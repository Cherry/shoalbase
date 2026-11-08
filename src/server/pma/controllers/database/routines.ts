// Ports of Controllers\Database\RoutinesController and Database\Routines.
import {
	getDbInfo,
	hasDatabase,
	render,
	requestString,
} from './common.ts';
import { type RoutineInfo, getDefinition, getRoutines } from './objects.ts';
import { htmlentities } from '../../../../lib/pma/database/htmlentities.ts';
import {
	DIRECTIONS,
	NUMERIC_OPTIONS,
	type RoutineData,
	type RoutineRow,
	SQL_DATA_ACCESS,
	mapAliasToMysqlType,
	needsExecuteDialog,
	routineDataFromDefinition,
	routineDataFromRequest,
	routineExecuteQueries,
	routineParameters,
	routineQueryFromRequest,
	unQuote,
} from '../../../../lib/pma/database/routines.ts';
import { Message } from '../../../../lib/pma/message.ts';
import { phpEmpty } from '../../../../lib/pma/server/php.ts';
import { sprintf } from '../../../../lib/pma/sprintf.ts';
import { getFunctionsForField } from '../../../../lib/pma/table-data/insert-edit.ts';
import { nestedParams } from '../../../../lib/pma/table-data/php-params.ts';
import { getAllFunctions } from '../../../../lib/pma/table-data/types.ts';
import { formatSql } from '../../../../lib/pma/table-structure/sql-format.ts';
import { getSupportedDatatypesHtml, getSupportedDatatypesList } from '../../../../lib/pma/table-structure/types.ts';
import { htmlspecialchars } from '../../../../lib/twig/php.ts';
import { backquote } from '../../../../lib/twig/sanitize.ts';
import { Context } from '../../../../sql-parser/index.ts';
import { getCharsets } from '../../core/charsets.ts';
import { getMessage } from '../../core/generator.ts';
import { currentUserHasPrivilege } from '../../shell/menu.ts';

import type { EditConfig } from '../../../../lib/pma/table-data/insert-edit.ts';
import type { ServerKind } from '../../../../lib/pma/table-structure/types.ts';
import type { PmaContext } from '../../core/context.ts';

const FAILED_QUERY = 'The following query has failed: "%s"';

function serverKind(context: PmaContext): ServerKind {
	return { type: context.dbi.isMariaDB() ? 'MariaDB' : 'MySQL', version: context.dbi.getVersion() };
}

/** DatabaseInterface::postConnect() loads the parser context; ours is global, so it is loaded right before parsing. */
function loadParserContext(context: PmaContext): void {
	Context.loadClosest(`${context.dbi.isMariaDB() ? 'MariaDb' : 'MySql'}${context.dbi.getVersion()}`);
}

/** What PHP echoes before an exit, which only becomes the page when nothing was added with addHTML(). */
interface Echo {
	text: string;
}

/** Ends the request the way PHP's exit does: the echoed text is the page body unless it is an AJAX response. */
function exit(context: PmaContext, echoed: Echo): Promise<Response> {
	if (!context.response.isAjax) {
		context.response.addHTML(echoed.text);
	}
	return context.response.response();
}

/** Routines::getDataFromName(). */
async function getDataFromName(context: PmaContext, name: unknown, type: unknown, all = true): Promise<RoutineData | null> {
	const { db, dbi } = context;
	const fields = 'SPECIFIC_NAME, ROUTINE_TYPE, DTD_IDENTIFIER, ROUTINE_DEFINITION, IS_DETERMINISTIC, SQL_DATA_ACCESS, ROUTINE_COMMENT, SECURITY_TYPE';
	const where = `ROUTINE_SCHEMA ${await dbi.getCollateForIS()}='${dbi.escapeString(db)}' AND SPECIFIC_NAME='${dbi.escapeString(requestString(name))}'AND ROUTINE_TYPE='${dbi.escapeString(requestString(type))}'`;
	const row = await dbi.fetchSingleRow(`SELECT ${fields} FROM INFORMATION_SCHEMA.ROUTINES WHERE ${where};`);
	if (row === null) {
		return null;
	}
	const definition = await getDefinition(context, db, String(row.ROUTINE_TYPE) as 'PROCEDURE', String(row.SPECIFIC_NAME));
	if (definition === null) {
		return null;
	}
	loadParserContext(context);
	// eslint-disable-next-line antislop/no-chained-type-assertions -- the SELECT above names exactly the RoutineRow columns, but the DBI returns untyped rows.
	return routineDataFromDefinition(row as unknown as RoutineRow, definition, all);
}

/** Routines::getRow(). */
async function getRow(context: PmaContext, routine: RoutineInfo, rowClass = ''): Promise<string> {
	const { db, dbi } = context;
	const sqlDrop = sprintf('DROP %s IF EXISTS %s', routine.type, backquote(routine.name));
	// Editing drops and recreates the routine, so only its definer (or a superuser) gets the edit and export links.
	const where = `ROUTINE_SCHEMA ${await dbi.getCollateForIS()}='${dbi.escapeString(db)}' AND SPECIFIC_NAME='${dbi.escapeString(routine.name)}'AND ROUTINE_TYPE='${dbi.escapeString(routine.type)}'`;
	const definer = await dbi.fetchValue(`SELECT \`DEFINER\` FROM INFORMATION_SCHEMA.ROUTINES WHERE ${where};`);
	const isDefiner = await dbi.getCurrentUser() === definer;
	const hasCreateRoutine = await currentUserHasPrivilege(dbi, 'CREATE ROUTINE', db);
	const hasEditPrivilege = (hasCreateRoutine && isDefiner) || await dbi.isSuperUser();
	const hasExportPrivilege = (hasCreateRoutine && isDefiner) || await dbi.isSuperUser();
	const hasExecutePrivilege = await currentUserHasPrivilege(dbi, 'EXECUTE', db) || isDefiner;
	const definition = await getDefinition(context, db, routine.type as 'PROCEDURE', routine.name);
	let executeAction = '';
	if (definition !== null) {
		loadParserContext(context);
		const params = routineParameters(definition);
		if (hasExecutePrivilege) {
			executeAction = needsExecuteDialog(routine.type, params) ? 'execute_dialog' : 'execute_routine';
		}
	}
	return render(context, 'database/routines/row', {
		db,
		table: context.table,
		sql_drop: sqlDrop,
		routine,
		row_class: rowClass,
		has_edit_privilege: hasEditPrivilege,
		has_export_privilege: hasExportPrivilege,
		has_execute_privilege: hasExecutePrivilege,
		execute_action: executeAction,
	});
}

/** Charsets::getCharsets() as the routine forms list them. */
async function charsetList(context: PmaContext): Promise<{ name: string; description: string; }[]> {
	const charsets = await getCharsets(context);
	return charsets.values().map((charset) => {
		return { name: charset.getName(), description: charset.getDescription() };
	}).toArray();
}

/** Routines::getParameterRow(); without a routine it is the template row the editor's JavaScript copies. */
async function getParameterRow(context: PmaContext, routine: RoutineData | null = null, index: number | null = null, rowClass = ''): Promise<string> {
	let data: RoutineData;
	let position = 0;
	let rowIndex: string;
	let dropClass = '';
	if (routine === null || index === null) {
		rowIndex = '%s';
		data = { item_name: '', item_type: '', item_num_params: 1, item_param_dir: [''], item_param_name: [''], item_param_type: [''], item_param_length: [''], item_param_opts_num: [''], item_param_opts_text: [''] };
	} else {
		dropClass = ' hide';
		position = index;
		rowIndex = String(index);
		data = routine;
	}
	const selectedCharset = String(data.item_param_opts_text[position] ?? '').toLowerCase();
	const list = await charsetList(context);
	const charsets = list.map((charset) => {
		return { ...charset, is_selected: charset.name === selectedCharset };
	});
	return render(context, 'database/routines/parameter_row', {
		class: rowClass,
		index: rowIndex,
		param_directions: DIRECTIONS,
		param_opts_num: NUMERIC_OPTIONS,
		item_param_dir: data.item_param_dir[position] ?? '',
		item_param_name: data.item_param_name[position] ?? '',
		item_param_length: data.item_param_length[position] ?? '',
		item_param_opts_num: data.item_param_opts_num[position] ?? '',
		supported_datatypes: getSupportedDatatypesHtml(serverKind(context), mapAliasToMysqlType(String(data.item_param_type[position] ?? ''))),
		charsets,
		drop_class: dropClass,
	});
}

/** Routines::getEditorForm(); `hasErrors` is the global $errors upstream reads. */
async function getEditorForm(context: PmaContext, mode: string, operation: string, source: RoutineData, hasErrors: boolean): Promise<string> {
	const routine: RoutineData = {
		...source,
		item_param_dir: [...source.item_param_dir],
		item_param_name: [...source.item_param_name],
		item_param_type: [...source.item_param_type],
		item_param_length: [...source.item_param_length],
		item_param_opts_num: [...source.item_param_opts_num],
		item_param_opts_text: [...source.item_param_opts_text],
	};
	for (let index = 0; index < routine.item_num_params; index++) {
		routine.item_param_name[index] = htmlentities(routine.item_param_name[index] ?? '');
		routine.item_param_length[index] = htmlentities(routine.item_param_length[index] ?? '');
	}
	if (operation === 'change') {
		const isProcedure = routine.item_type === 'PROCEDURE';
		routine.item_type = isProcedure ? 'FUNCTION' : 'PROCEDURE';
		routine.item_type_toggle = isProcedure ? 'PROCEDURE' : 'FUNCTION';
	} else if (operation === 'add' || (routine.item_num_params === 0 && mode === 'add' && !hasErrors)) {
		for (const key of ['item_param_dir', 'item_param_name', 'item_param_type', 'item_param_length', 'item_param_opts_num', 'item_param_opts_text'] as const) {
			routine[key].push('');
		}
		routine.item_num_params++;
	} else if (operation === 'remove') {
		for (const key of ['item_param_dir', 'item_param_name', 'item_param_type', 'item_param_length', 'item_param_opts_num', 'item_param_opts_text'] as const) {
			routine[key].splice(routine.item_num_params - 1, 1);
		}
		routine.item_num_params--;
	}
	let parameterRows = '';
	for (let index = 0; index < routine.item_num_params; index++) {
		parameterRows += await getParameterRow(context, routine, index, routine.item_type === 'FUNCTION' ? ' hide' : '');
	}
	const privileges = await context.dbi.getUserPrivileges();
	const charsets = await getCharsets(context);
	return render(context, 'database/routines/editor_form', {
		db: context.db,
		routine,
		is_edit_mode: mode === 'edit',
		is_ajax: context.response.isAjax,
		parameter_rows: parameterRows,
		charsets: charsets.values().toArray(),
		numeric_options: NUMERIC_OPTIONS,
		has_privileges: privileges.procPriv && privileges.isReloadPriv,
		sql_data_access: SQL_DATA_ACCESS,
	});
}

function supportedDatatypes(context: PmaContext): string[] {
	return getSupportedDatatypesList(serverKind(context));
}

/** Routines::create(), after the old routine was dropped; privileges are never adjusted because that needs RELOAD. */
async function recreate(context: PmaContext, routineQuery: string, createRoutine: string | null, itemName: string): Promise<[string[], Message | null]> {
	const { dbi } = context;
	if (await dbi.tryQuery(routineQuery) === false) {
		const errors = [`${sprintf(FAILED_QUERY, htmlspecialchars(routineQuery))}<br>MySQL said: ${dbi.getError()}`];
		if (await dbi.tryQuery(createRoutine ?? '') === false) {
			errors.push(`Sorry, we failed to restore the dropped routine.<br>The backed up query was:"${htmlspecialchars(createRoutine ?? '')}"<br>MySQL said: ${dbi.getError()}`);
		}
		return [errors, null];
	}
	const message = Message.success('Routine %1$s has been modified.');
	message.addParam(backquote(itemName));
	return [[], message];
}

/** Routines::handleRequestCreateOrEdit(): the AJAX response that ends the request, or the errors. */
async function handleRequestCreateOrEdit(context: PmaContext): Promise<Response | string[]> {
	const { db, dbi, request, response } = context;
	const post = request.post;
	const errors: string[] = [];
	if (phpEmpty(post.editor_process_add) && phpEmpty(post.editor_process_edit)) {
		return errors;
	}
	let message: Message | undefined;
	let sqlQuery = '';
	const routineQuery = routineQueryFromRequest(nestedParams(post), supportedDatatypes(context));
	const itemName = requestString(post.item_name);
	if (phpEmpty(post.editor_process_edit)) {
		if (await dbi.tryQuery(routineQuery) === false) {
			errors.push(`${sprintf(FAILED_QUERY, htmlspecialchars(routineQuery))}<br><br>MySQL said: ${dbi.getError()}`);
		} else {
			message = Message.success('Routine %1$s has been created.');
			message.addParam(backquote(itemName));
			sqlQuery = routineQuery;
		}
	} else {
		const originalType = requestString(post.item_original_type);
		if (originalType !== 'PROCEDURE' && originalType !== 'FUNCTION') {
			errors.push(sprintf('Invalid routine type: "%s"', htmlspecialchars(originalType)));
		} else {
			const originalName = requestString(post.item_original_name);
			const createRoutine = await getDefinition(context, db, originalType, originalName);
			const dropRoutine = `DROP ${originalType} ${backquote(originalName)};\n`;
			if (await dbi.tryQuery(dropRoutine) === false) {
				errors.push(`${sprintf(FAILED_QUERY, htmlspecialchars(dropRoutine))}<br>MySQL said: ${dbi.getError()}`);
			} else {
				const [newErrors, modified] = await recreate(context, routineQuery, createRoutine, itemName);
				if (newErrors.length === 0) {
					sqlQuery = dropRoutine + routineQuery;
					message = modified ?? undefined;
				} else {
					errors.push(...newErrors);
				}
			}
		}
	}
	if (errors.length > 0) {
		message = Message.error('One or more errors have occurred while processing your request:');
		message.addHtml('<ul>');
		for (const error of errors) {
			message.addHtml(`<li>${error}</li>`);
		}
		message.addHtml('</ul>');
	}
	const output = await getMessage(context, message ?? '', { sqlQuery });
	// The global $message is what the Header shows, also as the displayMessage of AJAX responses.
	response.globals.message = message;
	if (!response.isAjax) {
		return errors;
	}
	if (!message?.isSuccess()) {
		response.setRequestStatus(false);
		response.addJSON('message', output);
		return response.response();
	}
	const [routine] = await getRoutines(context, db, requestString(post.item_type), itemName);
	response.addJSON('name', htmlspecialchars(itemName.toUpperCase()));
	response.addJSON('new_row', routine === undefined ? '' : await getRow(context, routine));
	response.addJSON('insert', routine !== undefined);
	response.addJSON('message', output);
	response.addJSON('tableType', 'routines');
	return response.response();
}

/** Routines::handleEditor(): a Response when the request ends there. */
async function handleEditor(context: PmaContext, echoed: Echo): Promise<Response | null> {
	const { db, request, response } = context;
	const { params, post, query } = request;
	const handled = await handleRequestCreateOrEdit(context);
	if (handled instanceof Response) {
		return handled;
	}
	const errors = handled;
	const otherwise = phpEmpty(params.add_item) && phpEmpty(params.edit_item) && phpEmpty(post.routine_addparameter) && phpEmpty(post.routine_removeparameter) && phpEmpty(post.routine_changetype);
	if (errors.length === 0 && (!phpEmpty(post.editor_process_add) || !phpEmpty(post.editor_process_edit) || otherwise)) {
		return null;
	}
	let operation = '';
	if (!phpEmpty(post.routine_addparameter)) {
		operation = 'add';
	} else if (!phpEmpty(post.routine_removeparameter)) {
		operation = 'remove';
	} else if (!phpEmpty(post.routine_changetype)) {
		operation = 'change';
	}
	let routine: RoutineData | null = null;
	let mode = '';
	let title = '';
	if (!phpEmpty(params.add_item)) {
		title = 'Add routine';
		routine = routineDataFromRequest(nestedParams(post), supportedDatatypes(context));
		mode = 'add';
	} else if (!phpEmpty(params.edit_item)) {
		title = 'Edit routine';
		if (operation === '' && !phpEmpty(query.item_name) && phpEmpty(post.editor_process_edit)) {
			routine = await getDataFromName(context, query.item_name, query.item_type);
			if (routine !== null) {
				routine.item_original_name = routine.item_name;
				routine.item_original_type = routine.item_type;
			}
		} else {
			routine = routineDataFromRequest(nestedParams(post), supportedDatatypes(context));
		}
		mode = 'edit';
	}
	if (routine !== null) {
		const editor = await getEditorForm(context, mode, operation, routine, errors.length > 0);
		if (response.isAjax) {
			response.addJSON('message', editor);
			response.addJSON('title', title);
			response.addJSON('paramTemplate', await getParameterRow(context));
			response.addJSON('type', routine.item_type);
		} else {
			echoed.text += `\n\n<h2>${title}</h2>\n\n${editor}`;
		}
		return exit(context, echoed);
	}
	const text = 'Error in processing request: ' + sprintf(
		'No routine with name %1$s found in database %2$s. You might be lacking the necessary privileges to edit this routine.',
		htmlspecialchars(backquote(params.item_name)),
		htmlspecialchars(backquote(db)),
	);
	const message = Message.error(text);
	if (response.isAjax) {
		response.setRequestStatus(false);
		response.addJSON('message', message);
		return response.response();
	}
	echoed.text += message.getDisplay();
	return null;
}

/** Routines::browseRow(). */
function browseRow(row: Record<string, unknown>): string {
	return Object.values(row).map(value => `<td>${value === null ? '<i>NULL</i>' : htmlspecialchars(value)}</td>`).join('');
}

/** Runs the queries one by one as mysqli's multi_query() would: false as soon as one fails. */
async function runQueries(context: PmaContext, queries: string[], onResult: (rows: Record<string, unknown>[], fields: string[]) => void): Promise<boolean> {
	// mysqli refuses an empty multi-query outright.
	const statements = queries.length === 0 ? [''] : queries;
	for (const statement of statements) {
		const results = await context.dbi.tryQueryResultSets(statement);
		if (results === false) {
			return false;
		}
		for (const result of results) {
			onResult(result.fetchAllAssoc(), result.getFieldNames());
		}
	}
	return true;
}

/** Routines::handleExecuteRoutine(): a Response when the request ends there. */
async function handleExecuteRoutine(context: PmaContext, echoed: Echo): Promise<Response | null> {
	const { db, dbi, request, response } = context;
	const post = request.post;
	const routine = await getDataFromName(context, post.item_name, post.item_type, false);
	if (routine === null) {
		const message = Message.error('Error in processing request: ' + sprintf('No routine with name %1$s found in database %2$s.', htmlspecialchars(backquote(post.item_name)), htmlspecialchars(backquote(db))));
		if (response.isAjax) {
			response.setRequestStatus(false);
			response.addJSON('message', message);
			return response.response();
		}
		echoed.text += message.getDisplay();
	}
	const queries = routine === null ? [] : routineExecuteQueries(routine, nestedParams(post), getAllFunctions({ isMariaDB: dbi.isMariaDB(), version: dbi.getVersion() }));
	const multipleQuery = queries.join('');
	let output = '';
	let displayed = 0;
	let affected = 0;
	let tables = '';
	const outcome = await runQueries(context, queries, (rows, fields) => {
		if (rows.length === 0) {
			return;
		}
		tables += `<table class="table table-striped w-auto"><tr>${fields.map(field => `<th>${htmlspecialchars(field)}</th>`).join('')}</tr>`;
		tables += rows.map(row => `<tr>${browseRow(row)}</tr>`).join('');
		tables += '</table>';
		displayed++;
		affected = rows.length;
	});
	let message: Message;
	if (outcome && routine !== null) {
		output = formatSql(queries.join('\n'));
		output += '<div class="card my-3"><div class="card-header">';
		output += sprintf('Execution results of routine %s', backquote(htmlspecialchars(routine.item_name)));
		output += `</div><div class="card-body">${tables}</div></div>`;
		let text = 'Your SQL query has been executed successfully.';
		if (routine.item_type === 'PROCEDURE') {
			const rows = affected === 1 ? '%d row affected by the last statement inside the procedure.' : '%d rows affected by the last statement inside the procedure.';
			text += `<br>${sprintf(rows, affected)}`;
		}
		message = Message.success(text);
		if (displayed === 0) {
			output += Message.notice('MySQL returned an empty result set (i.e. zero rows).').getDisplay();
		}
	} else {
		message = Message.error(`${sprintf(FAILED_QUERY, htmlspecialchars(multipleQuery))}<br><br>MySQL said: ${dbi.getError()}`);
	}
	if (response.isAjax) {
		response.setRequestStatus(message.isSuccess());
		response.addJSON('message', message.getDisplay() + output);
		response.addJSON('dialog', false);
		return response.response();
	}
	echoed.text += message.getDisplay() + output;
	if (message.isError()) {
		return exit(context, echoed);
	}
	return null;
}

/** Routines::getExecuteForm(). */
async function getExecuteForm(context: PmaContext, source: RoutineData): Promise<string> {
	const { config, dbi } = context;
	const routine: RoutineData = { ...source, item_name: htmlentities(source.item_name), item_param_name: source.item_param_name.map(name => htmlentities(name)) };
	// A Map keeps the integer keys Twig looks up with loop.index0.
	const params = new Map<string | number, unknown>([['no_support_types', []]]);
	const editConfig: EditConfig = config;
	const flavor = { isMariaDB: dbi.isMariaDB(), version: dbi.getVersion() };
	for (let index = 0; index < routine.item_num_params; index++) {
		const type = String(routine.item_param_type[index] ?? '');
		if (routine.item_type === 'PROCEDURE' && routine.item_param_dir[index] === 'OUT') {
			// PHP reads null from the missing entry, which Twing would not treat as null.
			params.set(index, { generator: null });
			continue;
		}
		const param: Record<string, unknown> = {};
		if (config.ShowFunctionFields) {
			if (/enum|set/i.test(type)) {
				param.generator = null;
			} else {
				const field = { True_Type: type.toLowerCase(), Type: '', Key: '', Field: '', Default: '', first_timestamp: false };
				param.generator = getFunctionsForField(field, false, false, editConfig, flavor);
			}
		}
		if (type === 'DATETIME' || type === 'TIMESTAMP') {
			param.class = 'datetimefield';
		} else if (type === 'DATE') {
			param.class = 'datefield';
		}
		if (type === 'ENUM' || type === 'SET') {
			param.input_type = type === 'ENUM' ? 'radio' : 'checkbox';
			param.htmlentities = (routine.item_param_length_arr?.[index] ?? []).map(value => htmlentities(unQuote(value)));
		} else {
			param.input_type = 'text';
		}
		params.set(index, param);
	}
	return render(context, 'database/routines/execute_form', {
		db: context.db,
		routine,
		ajax: context.response.isAjax,
		show_function_fields: config.ShowFunctionFields,
		params,
	});
}

/** Routines::handleExecute(). */
async function handleExecute(context: PmaContext, echoed: Echo): Promise<Response | null> {
	const { db, request, response } = context;
	const { post, query } = request;
	if (!phpEmpty(post.execute_routine) && !phpEmpty(post.item_name)) {
		return handleExecuteRoutine(context, echoed);
	}
	if (phpEmpty(query.execute_dialog) || phpEmpty(query.item_name)) {
		return null;
	}
	const routine = await getDataFromName(context, query.item_name, query.item_type, true);
	if (routine !== null) {
		const form = await getExecuteForm(context, routine);
		if (response.isAjax) {
			response.addJSON('message', form);
			response.addJSON('title', `Execute routine ${backquote(htmlentities(query.item_name))}`);
			response.addJSON('dialog', true);
		} else {
			echoed.text += `\n\n<h2>Execute routine</h2>\n\n${form}`;
		}
		return exit(context, echoed);
	}
	if (response.isAjax) {
		const message = Message.error('Error in processing request: ' + sprintf('No routine with name %1$s found in database %2$s.', htmlspecialchars(backquote(query.item_name)), htmlspecialchars(backquote(db))));
		response.setRequestStatus(false);
		response.addJSON('message', message);
		return response.response();
	}
	return null;
}

/** Routines::export(). */
async function exportRoutine(context: PmaContext): Promise<Response | null> {
	const { db, request, response } = context;
	const { query } = request;
	if (phpEmpty(query.export_item) || phpEmpty(query.item_name) || phpEmpty(query.item_type)) {
		return null;
	}
	if (query.item_type !== 'FUNCTION' && query.item_type !== 'PROCEDURE') {
		return null;
	}
	const definition = await getDefinition(context, db, query.item_type, requestString(query.item_name));
	const itemName = htmlspecialchars(backquote(query.item_name));
	if (definition !== null) {
		const exportData = htmlspecialchars(`DELIMITER $$\n${definition}$$\nDELIMITER ;\n`.trim());
		const title = sprintf('Export of routine %s', itemName);
		if (response.isAjax) {
			response.addJSON('message', exportData);
			response.addJSON('title', title);
			return response.response();
		}
		response.addHTML(`<div class="container"><h2>${title}</h2><div class="card"><div class="card-body"><textarea rows="15" class="form-control">${exportData}</textarea></div></div></div>`);
		return null;
	}
	const message = Message.error(sprintf(
		'Error in processing request: No routine with name %1$s found in database %2$s. You might be lacking the necessary privileges to view/export this routine.',
		itemName,
		htmlspecialchars(backquote(db)),
	));
	if (response.isAjax) {
		response.setRequestStatus(false);
		response.addJSON('message', message);
		return response.response();
	}
	response.addHTML(message.getDisplay());
	return null;
}

/** Database\RoutinesController. */
export async function routinesController(context: PmaContext): Promise<Response> {
	const { dbi, request, response } = context;
	response.addScriptFiles(['database/routines.js']);
	const type = request.params.type;
	await dbi.getUserPrivileges();
	if (!response.isAjax) {
		let tableExists = false;
		if (context.table !== '') {
			const tables = await dbi.getTables(context.db);
			tableExists = tables.includes(context.table);
		}
		if (tableExists) {
			// DbTableExists::check() passes: the table was just listed.
			await dbi.selectDb(context.db);
		} else {
			context.table = '';
			if (!await hasDatabase(context)) {
				return response.response();
			}
			await getDbInfo(context, '');
		}
	} else if (context.db !== '') {
		await dbi.selectDb(context.db);
	}
	const echoed: Echo = { text: '' };
	for (const step of [handleEditor, handleExecute]) {
		const done = await step(context, echoed);
		if (done !== null) {
			return done;
		}
	}
	const exported = await exportRoutine(context);
	if (exported !== null) {
		return exported;
	}
	let which: string | null = null;
	if (type === 'FUNCTION' || type === 'PROCEDURE') {
		which = type;
	}
	const items = await getRoutines(context, context.db, which);
	const isAjax = response.isAjax && phpEmpty(request.params.ajax_page_request);
	let rows = '';
	for (const item of items) {
		rows += await getRow(context, item, isAjax ? 'ajaxInsert hide' : '');
	}
	// Echoed text is dropped here: the list is added with addHTML(), which ResponseRenderer prefers.
	response.addHTML(await render(context, 'database/routines/index', {
		db: context.db,
		table: context.table,
		items,
		rows,
		has_privilege: await currentUserHasPrivilege(dbi, 'CREATE ROUTINE', context.db, context.table),
	}));
	return response.response();
}

export const controllers = {
	'Database/RoutinesController': routinesController,
};

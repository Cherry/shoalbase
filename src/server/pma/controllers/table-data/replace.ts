// Port of Controllers\Table\ReplaceController (/table/replace): saves the insert/edit form and grid edits.
import { renderChangeForm, requestGoto } from './change.ts';
import { countRows, setSessionForEditNext } from './insert-edit.ts';
import { getDisplayField, getForeigners, searchForeigner } from './relation.ts';
import { Message } from '../../../../lib/pma/message.ts';
import { bcryptHash } from '../../../../lib/pma/table-data/bcrypt.ts';
import {
	addMicroseconds,
	bin2hex,
	buildInsertQuery,
	getCurrentValueForDifferentTypes,
	getCurrentValueForFunction,
	getGotoInclude,
	getQueryValue,
} from '../../../../lib/pma/table-data/insert-edit.ts';
import {
	type PhpArray,
	type PhpValue,
	nestedParams,
	phpArray,
	phpEmpty,
	phpEntries,
	phpGet,
	phpJsonValue,
	phpKeys,
	phpScalar,
	phpValues,
} from '../../../../lib/pma/table-data/php-params.ts';
import { escapeCompat } from '../../../../lib/pma/table-structure/column-spec.ts';
import { htmlspecialchars } from '../../../../lib/twig/php.ts';
import { backquote } from '../../../../lib/twig/sanitize.ts';
import { getFromRoute } from '../../../../lib/twig/url.ts';
import { DbiQueryError } from '../../core/dbi.ts';
import { getMessage } from '../../core/generator.ts';
import { signSqlQuery } from '../../core/sql-signature.ts';
import { mysqlDie } from '../server/mysql-die.ts';
import { forwardTo } from '../table-structure/common.ts';

import type { PmaContext } from '../../core/context.ts';
import type { Controller, ControllerContext } from '../../dispatcher.ts';

const MAX_UPLOAD_SIZE = 2_097_152;

/** PHP's parse_str() for the grid edit's jQuery-serialized cell lists. */
function parseStr(query: string): PhpArray {
	const params: Record<string, string | string[]> = {};
	for (const [key, value] of new URLSearchParams(query)) {
		const name = key.endsWith('[]') ? key.slice(0, -2) : key;
		if (key.endsWith('[]')) {
			const list = params[name];
			params[name] = Array.isArray(list) ? [...list, value] : [value];
		} else {
			params[name] = value;
		}
	}
	return nestedParams(params);
}

/** File::checkTblChangeForm() + getContent(): the uploaded file as 0x-hex, or false without a usable upload. */
async function uploadedValue(context: ControllerContext, key: string, rownumber: string): Promise<string | false> {
	const file = context.files[`fields_upload[multi_edit][${rownumber}][${key}]`];
	if (file === undefined || file.name === '' || file.size > MAX_UPLOAD_SIZE) {
		return false;
	}
	const bytes = new Uint8Array(await file.arrayBuffer());
	let hex = '';
	for (const byte of bytes) {
		hex += byte.toString(16).padStart(2, '0');
	}
	return `0x${hex}`;
}

function asStringMap(value: PhpValue | undefined): PhpArray | null {
	return phpArray(value) ?? null;
}

interface ExecutionResult {
	totalAffectedRows: number;
	lastMessages: Message[];
	warningMessages: string[];
	errorMessages: string[];
	returnToSqlQuery: string;
}

/** InsertEdit::executeSqlQuery(). */
async function executeSqlQuery(context: PmaContext, queries: string[], submitType: string | undefined): Promise<ExecutionResult> {
	const { dbi, response, config } = context;
	let returnToSqlQuery = '';
	if (response.globals.sqlQuery !== '' && response.globals.sqlQuery !== '0') {
		returnToSqlQuery = response.globals.sqlQuery;
	}
	response.globals.sqlQuery = `${queries.join('; ')};`;
	response.globals.displayQuery = response.globals.sqlQuery;

	let totalAffectedRows = 0;
	const lastMessages: Message[] = [];
	let warningMessages: string[] = [];
	const errorMessages: string[] = [];
	for (const query of queries) {
		if (submitType === 'showinsert') {
			lastMessages.push(Message.notice('Showing SQL query'));
			continue;
		}
		const result = config.IgnoreMultiSubmitErrors ? await dbi.tryQuery(query) : await dbi.query(query);
		if (result === false) {
			errorMessages.push(dbi.getError());
		} else {
			totalAffectedRows += dbi.affectedRows();
			let insertId = await dbi.insertId();
			if (insertId !== 0) {
				if (totalAffectedRows > 0) {
					insertId += totalAffectedRows - 1;
				}
				const message = Message.notice('Inserted row id: %1$d');
				message.addParam(insertId);
				lastMessages.push(message);
			}
		}
		const warnings = await dbi.getWarnings();
		warningMessages = warnings.map((warning) => {
			const code = /^[\t\n\v\f\r ]*[+-]?\d/.test(warning.Code ?? '') ? Number.parseInt(warning.Code ?? '0', 10) : 0;
			const text = warning.Message ?? '';
			return htmlspecialchars(`${warning.Level ?? ''}: #${code}${text === '' ? '' : ` ${text}`}`);
		});
	}
	return { totalAffectedRows, lastMessages, warningMessages, errorMessages, returnToSqlQuery };
}

/** Runs the controller upstream includes for $goto_include. */
async function forwardToInclude(context: ControllerContext, include: string, post: PhpArray): Promise<Response> {
	if (include === '/table/change') {
		return renderChangeForm(context, null, { post });
	}
	const names: Record<string, string> = { '/sql': 'Sql/SqlController', '/database/sql': 'Database/SqlController', '/table/sql': 'Table/SqlController' };
	const forwarded = Object.hasOwn(names, include) ? await forwardTo(context, names[include]) : null;
	if (forwarded !== null) {
		return forwarded;
	}
	// The target page is not ported yet: show what it would show above its own content.
	const { response } = context;
	const dispMessage = response.globals.dispMessage;
	if (dispMessage !== undefined) {
		response.addHTML(await getMessage(context, dispMessage, { sqlQuery: response.globals.displayQuery ?? response.globals.sqlQuery }));
	} else if (response.globals.message !== undefined) {
		response.addHTML(await getMessage(context, response.globals.message));
		response.globals.message = undefined;
	}
	return response.response();
}

/** The grid edit reply: relational links, the stored value when MySQL may have truncated it, and the row count. */
async function gridEditResponse(context: ControllerContext, post: PhpArray, message: Message): Promise<Response> {
	const { dbi, response, db, table } = context;
	const extraData: Record<string, unknown> = {};
	const relFieldsList = phpScalar(post.rel_fields_list);
	if (relFieldsList !== undefined && relFieldsList !== '') {
		const map = await getForeigners(context, db, table, 'both');
		const relations = new Map<string, string>();
		for (const [cellIndex, fields] of phpEntries(parseStr(relFieldsList))) {
			for (const [relationField, relationValue] of phpEntries(phpArray(fields) ?? {})) {
				const fieldValue = typeof relationValue === 'string' ? relationValue : '';
				const whereComparison = `='${fieldValue}'`;
				const foreigner = searchForeigner(context, map, relationField);
				if (foreigner === false) {
					relations.set(cellIndex, '');
					continue;
				}
				let dispval = '';
				const displayField = await getDisplayField(context, foreigner.foreign_db, foreigner.foreign_table);
				if (displayField !== false && displayField !== '') {
					const result = await dbi.tryQuery(`SELECT ${backquote(displayField)} FROM ${backquote(foreigner.foreign_db)}.${backquote(foreigner.foreign_table)} WHERE ${backquote(foreigner.foreign_field)}${whereComparison}`);
					if (result !== false && result.numRows() > 0) {
						dispval = String(result.fetchValue() ?? '');
					}
				}
				// Unset outside a browsed session; upstream then warns and takes the non-K branches.
				const relationalDisplay = context.session.data.tmpval?.relational_display;
				let title: string;
				if (relationalDisplay === 'K') {
					title = dispval === '' || dispval === '0' ? '' : ` title="${htmlspecialchars(dispval)}"`;
				} else {
					title = ` title="${htmlspecialchars(fieldValue)}"`;
				}
				const sqlQuery = `SELECT * FROM ${backquote(foreigner.foreign_db)}.${backquote(foreigner.foreign_table)} WHERE ${backquote(foreigner.foreign_field)}${whereComparison}`;
				const href = getFromRoute(context.urlState(), '/sql', { db: foreigner.foreign_db, table: foreigner.foreign_table, pos: '0', sql_signature: signSqlQuery(context.session, sqlQuery), sql_query: sqlQuery });
				const text = htmlspecialchars(relationalDisplay === 'D' ? dispval : fieldValue);
				relations.set(cellIndex, `<a href="${href}"${title}>${text}</a>`);
			}
		}
		extraData.relations = phpJsonValue([...relations]);
	}

	// verifyWhetherValueCanBeTruncatedAndAppendExtraData().
	const columnName = phpScalar(phpGet(post, 'fields_name', 'multi_edit', 0, 0)) ?? '';
	extraData.isNeedToRecheck = false;
	const whereClause = phpScalar(phpGet(post, 'where_clause', 0)) ?? '';
	const result = await dbi.tryQuery(`SELECT ${backquote(table)}.${backquote(columnName)} FROM ${backquote(db)}.${backquote(table)} WHERE ${whereClause}`);
	if (result !== false) {
		const meta = result.getFieldsMeta()[0];
		let newValue = result.fetchValue();
		if (newValue !== false) {
			if (meta.isTimeType()) {
				newValue = addMicroseconds(newValue ?? '');
			} else if (meta.isBinary) {
				newValue = `0x${bin2hex(newValue ?? '')}`;
			}
			extraData.isNeedToRecheck = true;
			extraData.truncatableFieldValue = newValue;
		}
	}

	const postedTable = phpScalar(post.table) ?? '';
	const postedDb = phpScalar(post.db) ?? '';
	extraData.row_count = await countRows(context, postedTable, postedDb);
	extraData.sql_query = await getMessage(context, message, { sqlQuery: response.globals.displayQuery ?? '' });

	response.setRequestStatus(message.isSuccess());
	response.addJSON('message', message);
	response.addJSON(extraData);
	return response.response();
}

async function replace(context: ControllerContext): Promise<Response> {
	const { dbi, response, request, config } = context;
	const post = nestedParams(request.post);
	await dbi.selectDb(context.db);
	response.addScriptFiles(['makegrid.js', 'sql.js', 'indexes.js', 'gis_data_editor.js']);

	const insertRows = phpScalar(post.insert_rows);
	if (insertRows !== undefined && /^[\t\n\v\f\r ]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?[\t\n\v\f\r ]*$/i.test(insertRows) && Number(insertRows) !== Number(config.InsertRows)) {
		response.addScriptFiles(['vendor/jquery/additional-methods.js', 'table/change.js']);
		(config as Record<string, unknown>).InsertRows = insertRows;
		return renderChangeForm(context, null, { post });
	}

	// Common::run()'s $urlParams: goto, db, table and server.
	const goto = requestGoto(context);
	const urlParams: Record<string, unknown> = {};
	if (goto !== '') {
		urlParams.goto = goto;
	}
	urlParams.db = context.db;
	urlParams.table = context.table;
	urlParams.server = context.server;

	const afterInsert = phpScalar(post.after_insert);
	if (afterInsert !== undefined && ['new_insert', 'same_insert', 'edit_next'].includes(afterInsert)) {
		urlParams.after_insert = afterInsert;
		const whereClauses = phpArray(post.where_clause);
		if (whereClauses !== undefined) {
			for (const clause of phpValues(whereClauses)) {
				if (afterInsert === 'same_insert') {
					urlParams.where_clause = [...(urlParams.where_clause as unknown[] | undefined ?? []), clause];
				} else if (afterInsert === 'edit_next') {
					await setSessionForEditNext(context, typeof clause === 'string' ? clause : '');
				}
			}
		}
	}

	const gotoInclude = getGotoInclude(afterInsert, goto, context.table);
	let include = gotoInclude.include;
	context.table = gotoInclude.table;

	// InsertEdit::getParamsForUpdateOrInsert().
	let loopArray: [string, string][];
	let usingKey: boolean;
	let isInsert: boolean;
	const submitType = phpScalar(post.submit_type);
	if (post.where_clause !== undefined) {
		const clauses = phpArray(post.where_clause);
		loopArray = clauses === undefined ? [['0', phpScalar(post.where_clause) ?? '']] : phpEntries(clauses).map(([key, value]) => [key, typeof value === 'string' ? value : '']);
		usingKey = true;
		isInsert = submitType !== undefined && ['insert', 'showinsert', 'insertignore'].includes(submitType);
	} else {
		loopArray = [];
		const multiEdit = phpArray(phpGet(post, 'fields', 'multi_edit'));
		if (!phpEmpty(post.fields) && multiEdit !== undefined) {
			loopArray = phpKeys(multiEdit).map((key, index) => [String(index), key]);
		}
		usingKey = false;
		isInsert = true;
	}
	const isInsertIgnore = submitType === 'insertignore';

	const queries: string[] = [];
	const valueSets: string[] = [];
	const queryFields: string[] = [];
	const version = dbi.getVersion();
	for (const [rownumber, whereClause] of loopArray) {
		if (!usingKey && post[`insert_ignore_${whereClause}`] !== undefined) {
			continue;
		}
		const row = rownumber;
		const queryValues: string[] = [];
		const columns: PhpArray = { ...asStringMap(phpGet(post, 'fields', 'multi_edit', row)) };
		const names = asStringMap(phpGet(post, 'fields_name', 'multi_edit', row)) ?? {};
		const previous = asStringMap(phpGet(post, 'fields_prev', 'multi_edit', row));
		const funcs = asStringMap(phpGet(post, 'funcs', 'multi_edit', row));
		const salts = asStringMap(phpGet(post, 'salt', 'multi_edit', row));
		const types = asStringMap(phpGet(post, 'fields_type', 'multi_edit', row));
		const nulls = asStringMap(phpGet(post, 'fields_null', 'multi_edit', row));
		const nullsPrevious = asStringMap(phpGet(post, 'fields_null_prev', 'multi_edit', row));
		const autoIncrement = asStringMap(phpGet(post, 'auto_increment', 'multi_edit', row));
		const virtual = asStringMap(phpGet(post, 'virtual', 'multi_edit', row));

		for (const key of phpKeys(names)) {
			columns[key] ??= '';
		}
		for (const [key, rawName] of phpEntries(names)) {
			const columnName = typeof rawName === 'string' ? rawName : '';
			const posted = columns[key];
			let currentValue = typeof posted === 'string' ? posted : '';
			const uploaded = await uploadedValue(context, key, row);
			if (uploaded !== false) {
				currentValue = uploaded;
			}
			const func = phpScalar(funcs?.[key]);
			const nullIsSet = nulls !== null && nulls[key] !== undefined;
			const isNull = nulls !== null && !phpEmpty(nulls[key]);
			const wasNull = nullsPrevious !== null && !phpEmpty(nullsPrevious[key]);
			let valueSql: string;
			if (func === undefined || ['', '0'].includes(func)) {
				const type = phpScalar(types?.[key]) ?? '';
				let protectedRow: Record<string, string | null> | null = null;
				if (type === 'protected' && isInsert && usingKey && types !== null && whereClause !== '' && whereClause !== '0') {
					protectedRow = await dbi.fetchSingleRow(`SELECT * FROM ${backquote(context.table)} WHERE ${whereClause};`);
				}
				const setValues = phpArray(posted);
				valueSql = getCurrentValueForDifferentTypes({
					uploaded,
					type,
					value: currentValue,
					isAutoIncrement: autoIncrement !== null && autoIncrement[key] !== undefined,
					isNull,
					wasNull,
					nullIsSet,
					setValues: setValues === undefined ? null : phpValues(setValues).map(item => (typeof item === 'string' ? item : '')),
					protectedRow,
					columnName: phpScalar(names[key]) ?? '',
				});
			} else {
				let passwordHash: string | undefined;
				let uuid: string | undefined;
				if (func === 'PHP_PASSWORD_HASH') {
					passwordHash = bcryptHash(currentValue);
				} else if (func === 'UUID') {
					uuid = String(await dbi.fetchValue('SELECT UUID()') ?? '');
				}
				valueSql = getCurrentValueForFunction({ func, salt: phpScalar(salts?.[key]), value: currentValue, version, passwordHash, uuid });
			}

			if (virtual !== null && virtual[key] !== undefined) {
				continue;
			}
			const queryValue = getQueryValue({
				columnName,
				isInsert,
				valueSql,
				value: currentValue,
				// An array (SET) value never equals the previous text.
				previous: typeof posted === 'string' ? phpScalar(previous?.[key]) : undefined,
				func,
				isNull,
				nullIsSet,
				wasNull,
				isFirstRow: valueSets.length === 0,
			});
			if (queryValue.value === null) {
				continue;
			}
			queryValues.push(queryValue.value);
			if (queryValue.addField) {
				queryFields.push(backquote(columnName));
			}
		}

		if (queryValues.length === 0) {
			continue;
		}
		if (isInsert) {
			valueSets.push(queryValues.join(', '));
		} else {
			const clauseIsUnique = phpScalar(post.clause_is_unique) ?? phpScalar(nestedParams(context.request.query).clause_is_unique) ?? '';
			queries.push(`UPDATE ${backquote(context.table)} SET ${queryValues.join(', ')} WHERE ${whereClause}${clauseIsUnique === '' || clauseIsUnique === '0' ? ' LIMIT 1' : ''}`);
		}
	}

	if (isInsert && valueSets.length > 0) {
		queries.splice(0, queries.length, buildInsertQuery(isInsertIgnore, context.table, queryFields, valueSets));
	} else if (queries.length === 0 && post.preview_sql === undefined) {
		response.globals.message = Message.success('No change');
		if (include === '/table/replace') {
			include = '/table/change';
		}
		return forwardToInclude(context, include, post);
	}

	if (post.preview_sql !== undefined) {
		let html = '<div class="preview_sql">';
		if (queries.length === 0) {
			html += 'No change';
		}
		for (const query of queries) {
			html += `<code class="sql" dir="ltr"><pre>\n${escapeCompat(query)}\n</pre></code>`;
		}
		response.addJSON('sql_data', `${html}</div>`);
		return response.response();
	}

	let execution: ExecutionResult;
	try {
		execution = await executeSqlQuery(context, queries, submitType);
	} catch (error) {
		if (error instanceof DbiQueryError) {
			return mysqlDie(context, error.formatted, error.query);
		}
		throw error;
	}

	let message: Message;
	if (isInsert && valueSets.length > 0) {
		message = Message.getMessageForInsertedRows(execution.totalAffectedRows);
	} else {
		message = Message.getMessageForAffectedRows(execution.totalAffectedRows);
	}
	message.addMessages(execution.lastMessages, '<br>');
	if (execution.warningMessages.length > 0) {
		message.addMessagesString(execution.warningMessages, '<br>');
		message.isError(true);
	}
	if (execution.errorMessages.length > 0) {
		message.addMessagesString(execution.errorMessages);
		message.isError(true);
	}

	// The global $message, which Header::getMessage() shows unless it is handed over as $disp_message.
	response.globals.message = message;
	if (response.isAjax && post.ajax_page_request === undefined) {
		return gridEditResponse(context, post, message);
	}

	if (execution.returnToSqlQuery !== '') {
		response.globals.dispQuery = response.globals.sqlQuery;
		response.globals.dispMessage = message;
		// Upstream's unset($message) only drops the local alias, so the global message still shows in the header.
		response.globals.sqlQuery = execution.returnToSqlQuery;
	}
	response.addScriptFiles(['vendor/jquery/additional-methods.js', 'table/change.js']);

	let forwardedPost = post;
	if (afterInsert === 'new_insert') {
		forwardedPost = { ...post };
		delete forwardedPost.where_clause;
	}
	if (include === '/table/change' && execution.returnToSqlQuery !== '') {
		return renderChangeForm(context, null, { post: forwardedPost, dispMessage: message });
	}
	return forwardToInclude(context, include, forwardedPost);
}

const replaceController: Controller = async context => replace(context);

export const controllers = {
	'Table/ReplaceController': replaceController,
};


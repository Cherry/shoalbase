// NormalizationController with the Normalization class's database reads: the 1NF, 2NF and 3NF wizard.
import { jsonHttpHeaders } from '../../../../lib/pma/ajax-response.ts';
import { phpJsonEncode } from '../../../../lib/pma/json.ts';
import { Message } from '../../../../lib/pma/message.ts';
import {
	type ColumnDefinition,
	type NewTable3Nf,
	columnsListHtml,
	distinctValuesQuery,
	isPartialDependency,
	moveRepeatingGroupQueries,
	newTables2NfHtml,
	newTables2NfQueries,
	newTables3Nf,
	newTables3NfQueries,
	normalizeTableHtml,
	oneNfStep1Html,
	oneNfStep2,
	oneNfStep3,
	oneNfStep4,
	partialDependenciesHtml,
	partialDependencyQuery,
	partialKeyCombinations,
	threeNfStep1,
	twoNfStep1,
} from '../../../../lib/pma/misc/normalization.ts';
import { sprintf } from '../../../../lib/pma/sprintf.ts';
import {
	getAttributes,
	getColumnTypes,
	isVirtualColumnsSupported,
	supportsStoredKeywordForVirtualColumns,
} from '../../../../lib/pma/table-structure/types.ts';
import { htmlspecialchars } from '../../../../lib/twig/php.ts';
import { backquote } from '../../../../lib/twig/sanitize.ts';
import { getFromRoute, getHiddenInputs } from '../../../../lib/twig/url.ts';
import { renderTemplate } from '../../../twig/render.ts';
import { getCharsets, getCollations } from '../../core/charsets.ts';
import { getIcon } from '../../core/generator.ts';
import { getPrimaryIndex } from '../../core/index.ts';
import { getComments } from '../table-data/relation.ts';
import { serverKind } from '../table-structure/columns-definition.ts';
import { RELATION_PARAMETERS } from '../table-structure/common.ts';

import type { Charset, Collation } from '../../../../lib/pma/charsets.ts';
import type { PmaContext } from '../../core/context.ts';

type Json = Record<string, unknown>;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function decodeJson<T>(value: unknown, fallback: T): T {
	try {
		return JSON.parse(text(value)) as T;
	} catch {
		return fallback;
	}
}

async function columnDefinitions(context: PmaContext, db: string, table: string): Promise<ColumnDefinition[]> {
	await context.dbi.selectDb(db);
	const columns = await context.dbi.getColumns(db, table, true);
	return columns.entries().map(([name, definition]) => { return { name, type: String(definition.Type ?? '') }; }).toArray();
}

/** Types::getColumns()['String'], the string-like column types. */
function stringTypes(context: PmaContext): string[] {
	const group = getColumnTypes(serverKind(context)).find(entry => Array.isArray(entry) && entry[0] === 'String');
	return Array.isArray(group) ? group[1] : [];
}

async function primaryKeyColumns(context: PmaContext, table: string, db: string): Promise<string[]> {
	const primary = await getPrimaryIndex(context, table, db);
	if (primary === false) {
		return [];
	}
	return primary.getColumns().values().map(column => column.getName())
		.toArray();
}

/** The charsets template variable: each charset with its collations. */
function charsetList(charsets: Map<string, Charset>, collations: Map<string, Map<string, Collation>>): Json[] {
	return charsets.values().map((charset) => {
		const list = (collations.get(charset.getName()) ?? new Map<string, Collation>()).values();
		return {
			name: charset.getName(),
			description: charset.getDescription(),
			collations: list.map((collation) => { return { name: collation.getName(), description: collation.getDescription() }; }).toArray(),
		};
	}).toArray();
}

/** Normalization::getHtmlForCreateNewColumn(): the column editor rows for new columns. */
async function createNewColumnHtml(context: PmaContext, numFields: number, columnMeta: Json = {}): Promise<string> {
	const { config, db, dbi, table } = context;
	const commentsMap = await getComments(context, db, table);
	const contentCells = Array.from({ length: Math.max(numFields, 0) }, (_, column) => {
		return {
			column_number: column,
			column_meta: columnMeta,
			type_upper: '',
			length_values_input_size: 8,
			length: '',
			extracted_columnspec: [],
			submit_attribute: null,
			comments_map: commentsMap,
			fields_meta: null,
			is_backup: true,
			move_columns: [],
			available_mime: [],
			mime_map: [],
		};
	});
	const charsets = await getCharsets(context);
	const collations = await getCollations(context);
	const server = serverKind(context);
	const privileges = await dbi.getUserPrivileges();
	return renderTemplate('columns_definitions/table_fields_definitions', {
		is_backup: true,
		fields_meta: null,
		relation_parameters: RELATION_PARAMETERS,
		content_cells: contentCells,
		change_column: context.request.post.change_column ?? context.request.query.change_column ?? null,
		is_virtual_columns_supported: isVirtualColumnsSupported(server),
		browse_mime: config.BrowseMIME,
		supports_stored_keyword: supportsStoredKeywordForVirtualColumns(server),
		server_version: dbi.getVersion(),
		max_rows: Math.trunc(Number(config.MaxRows)),
		char_editing: config.CharEditing,
		attribute_types: getAttributes(server),
		privs_available: privileges.colPriv && privileges.isReloadPriv,
		max_length: dbi.getVersion() >= 50503 ? 1024 : 255,
		charsets: charsetList(charsets, collations),
	}, await context.templateState());
}

/** Normalization::findPartialDependencies(). */
async function findPartialDependencies(context: PmaContext): Promise<string> {
	const { db, dbi, table } = context;
	await dbi.selectDb(db);
	const columnNames = await dbi.getColumnNames(db, table);
	const columns = columnNames.map(name => backquote(name));
	const totalRows = await dbi.fetchValue(`SELECT COUNT(*) FROM (SELECT * FROM ${backquote(table)} LIMIT 500) as dt;`);
	const keyNames = await primaryKeyColumns(context, table, db);
	const primaryKey = keyNames.map(name => backquote(name));
	const partialKeys = partialKeyCombinations(primaryKey);
	const counted = [...new Set([...columns, ...partialKeys])];
	const counts = await dbi.fetchSingleRow(distinctValuesQuery(counted, table));
	const countOf = (column: string): string | null => counts?.[`${column}_cnt`] ?? null;
	const dependencies = new Map<string, string[]>();
	for (const column of columns) {
		if (primaryKey.includes(column)) {
			continue;
		}
		for (const partialKey of partialKeys) {
			if (partialKey === '') {
				continue;
			}
			const pairCount = await dbi.fetchValue(partialDependencyQuery(partialKey, column, table));
			if (!isPartialDependency(countOf(partialKey), countOf(column), pairCount === false ? null : pairCount, totalRows === false ? null : totalRows)) {
				continue;
			}
			dependencies.set(partialKey, [...dependencies.get(partialKey) ?? [], column]);
		}
	}
	return partialDependenciesHtml(dependencies);
}

/** Runs the statements of a normalization step, stopping at the first failure like upstream. */
async function runQueries(context: PmaContext, queries: string[]): Promise<{ error: boolean; message: Message | null; }> {
	await context.dbi.selectDb(context.db);
	for (const query of queries) {
		if (await context.dbi.tryQuery(query) === false) {
			const message = Message.error('Error in processing!');
			message.addMessage(Message.rawError(context.dbi.getError()), '<br><br>');
			return { error: true, message };
		}
	}
	return { error: false, message: null };
}

async function stepResponse(context: PmaContext, post: Json): Promise<Response | null> {
	const { db, dbi, response, table } = context;
	if (post.createNewTables2NF !== undefined) {
		const queries = newTables2NfQueries(decodeJson(post.pd, {}), decodeJson(post.newTablesName, {}), table);
		const headText = `<h3>${sprintf('The second step of normalization is complete for table \'%1$s\'.', htmlspecialchars(table))}</h3>`;
		if (queries.length === 0) {
			response.addJSON({ legendText: 'End of step', headText, queryError: false });
			return response.response();
		}
		const result = await runQueries(context, queries);
		response.addJSON({ legendText: 'End of step', headText, queryError: result.error, extra: result.message ?? '' });
		return response.response();
	}
	if (post.createNewTables3NF !== undefined) {
		const newTables = decodeJson<Record<string, Record<string, NewTable3Nf>>>(post.newTables, {});
		const headText = '<h3>The third step of normalization is complete.</h3>';
		if (Object.keys(newTables).length === 0) {
			response.addJSON({ legendText: 'End of step', headText, queryError: false });
			return response.response();
		}
		const columnsByTable = new Map<string, string[]>();
		for (const original of Object.keys(newTables)) {
			columnsByTable.set(original, await dbi.getColumnNames(db, original));
		}
		const result = await runQueries(context, newTables3NfQueries(newTables, original => columnsByTable.get(original) ?? []));
		response.addJSON({ legendText: 'End of step', headText, queryError: result.error, extra: result.message ?? '' });
		return response.response();
	}
	if (post.repeatingColumns !== undefined) {
		const queries = moveRepeatingGroupQueries(text(post.repeatingColumns), text(post.primary_columns), text(post.newTable), text(post.newColumn), table);
		const result = await runQueries(context, queries);
		const moved = Message.success(sprintf('Selected repeating group has been moved to the table \'%s\'', htmlspecialchars(table)));
		response.addJSON({ queryError: result.error, message: result.message ?? moved });
		return response.response();
	}
	return null;
}

export async function normalizationController(context: PmaContext): Promise<Response> {
	const { db, response, table } = context;
	const post = context.request.post as Json;
	await context.dbi.connect();
	if (post.getColumns !== undefined) {
		const options = columnsListHtml(await columnDefinitions(context, db, table), stringTypes(context), 'dropdown');
		response.addHTML(`<option selected disabled>Select one…</option><option value="no_such_col">No such column</option>${options}`);
		return response.response();
	}
	if (post.splitColumn !== undefined) {
		const numFields = Math.min(4096, Math.trunc(Number.parseInt(text(post.numFields), 10) || 0));
		response.addHTML(await createNewColumnHtml(context, numFields) + getHiddenInputs(context.urlState(), db, table));
		return response.response();
	}
	if (post.addNewPrimary !== undefined) {
		response.addHTML(await createNewColumnHtml(context, 1, { Field: `${table}_id`, Extra: 'auto_increment' }) + getHiddenInputs(context.urlState(), db, table));
		return response.response();
	}
	if (post.findPdl !== undefined) {
		response.addHTML(await findPartialDependencies(context));
		return response.response();
	}
	if (post.getNewTables2NF !== undefined) {
		response.addHTML(newTables2NfHtml(decodeJson(post.pd, {}), table));
		return response.response();
	}
	if (post.getNewTables3NF !== undefined) {
		const tables = decodeJson<Record<string, string[]>>(post.tables, {});
		const primaryKeys: Record<string, string[]> = {};
		for (const name of Object.keys(tables)) {
			primaryKeys[name] = await primaryKeyColumns(context, name, db);
		}
		// Core::headerJSON() on a disabled response, so only the JSON goes out.
		return new Response(phpJsonEncode(newTables3Nf(decodeJson(post.pd, {}), tables, primaryKeys)), { headers: jsonHttpHeaders(new Date()) });
	}
	response.addScriptFiles(['normalization.js', 'vendor/jquery/jquery.uitablefilter.js']);
	const normalizeTo = ['1nf', '2nf', '3nf'].includes(text(post.normalizeTo)) ? text(post.normalizeTo) : '1nf';
	const finished = await stepResponse(context, post);
	if (finished !== null) {
		return finished;
	}
	if (post.step1 !== undefined) {
		const options = columnsListHtml(await columnDefinitions(context, db, table), stringTypes(context), 'dropdown');
		response.addHTML(oneNfStep1Html(normalizeTo, options));
	} else if (post.step2 !== undefined) {
		const hasPrimary = await getPrimaryIndex(context, table, db) !== false;
		response.addJSON(oneNfStep2(hasPrimary, getIcon(context, 'b_index_add', 'Add a primary key on existing column(s)')));
	} else if (post.step3 !== undefined) {
		const checkboxes = columnsListHtml(await columnDefinitions(context, db, table), null, 'checkbox');
		response.addJSON(oneNfStep3(checkboxes, await primaryKeyColumns(context, table, db)));
	} else if (post.step4 !== undefined) {
		response.addJSON(oneNfStep4(columnsListHtml(await columnDefinitions(context, db, table), null, 'checkbox')));
	} else if (post.step === '2.1') {
		await context.dbi.selectDb(db);
		response.addJSON(twoNfStep1(await primaryKeyColumns(context, table, db), await context.dbi.getColumnNames(db, table)));
	} else if (post.step === '3.1') {
		const tables = Array.isArray(post.tables) ? post.tables as string[] : [];
		const described = [];
		for (const name of tables) {
			await context.dbi.selectDb(db);
			described.push({ name, primaryKey: await primaryKeyColumns(context, name, db), columns: await context.dbi.getColumnNames(db, name) });
		}
		response.addJSON(threeNfStep1(described));
	} else {
		response.addHTML(normalizeTableHtml(getFromRoute(context.urlState(), '/normalization'), getHiddenInputs(context.urlState(), db, table)));
	}
	return response.response();
}

export const controllers = {
	NormalizationController: normalizationController,
};

// Ports of Controllers\Database\DesignerController, Database\Designer and Designer\Common without configuration storage:
// pages, table positions and settings live in the browser (IndexedDB), and only native foreign keys can be edited.
import {
	getDbInfo,
	hasDatabase,
	internalErrorPage,
	render,
	requestString,
} from './common.ts';
import {
	type Constraint,
	DesignerTable,
	MENU_BUTTON_CLASSES,
	type TableColumns,
	columnsType,
	rawurlencode,
	scriptContr,
	scriptTabs,
} from '../../../../lib/pma/database/designer.ts';
import { getSchemaPlugins } from '../../../../lib/pma/database/schema-plugins.ts';
import { getColumnsSql } from '../../../../lib/pma/dbi-sql.ts';
import { getChoice, getDefault, getOptions } from '../../../../lib/pma/export-import/properties.ts';
import { phpJsonEncode } from '../../../../lib/pma/json.ts';
import { phpInt } from '../../../../lib/pma/server/php.ts';
import { searchColumnInForeigners } from '../../../../lib/pma/table-data/relation.ts';
import { isForeignKeySupportedEngine } from '../../../../lib/pma/table-structure/column-spec.ts';
import { backquote } from '../../../../lib/twig/sanitize.ts';
import { getIndexesFromTable } from '../../core/index.ts';
import { getDisplayField, getForeigners } from '../table-data/relation.ts';

import type { OptionRequest } from '../../../../lib/pma/export-import/properties.ts';
import type { PmaContext } from '../../core/context.ts';

/** Common::getTablesInfo(). */
async function getTablesInfo(context: PmaContext, db: string = context.db, table: string | null = null): Promise<DesignerTable[]> {
	const { dbi } = context;
	await dbi.selectDb(db);
	const tables = await dbi.getTablesFull(db, table ?? '');
	const designerTables: DesignerTable[] = [];
	for (const row of tables.values()) {
		const name = String(row.TABLE_NAME);
		const displayField = await getDisplayField(context, db, name);
		const engine = typeof row.ENGINE === 'string' ? row.ENGINE : '';
		designerTables.push(new DesignerTable(db, name, engine, typeof displayField === 'string' && displayField !== '' ? displayField : null));
	}
	return designerTables;
}

/** Common::getColumnsInfo(). */
async function getColumnsInfo(context: PmaContext, tables: DesignerTable[]): Promise<Map<string, TableColumns>> {
	const tabColumn = new Map<string, TableColumns>();
	for (const table of tables) {
		const result = await context.dbi.query(getColumnsSql(table.getDatabaseName(), table.getTableName()));
		for (const [index, row] of result.fetchAllAssoc().entries()) {
			const name = table.getDbTableString();
			const columns = tabColumn.get(name) ?? { COLUMN_ID: [], COLUMN_NAME: [], TYPE: [], NULLABLE: [] };
			tabColumn.set(name, columns);
			columns.COLUMN_ID.push(index);
			columns.COLUMN_NAME.push(String(row.Field));
			columns.TYPE.push(String(row.Type));
			columns.NULLABLE.push(String(row.Null));
		}
	}
	return tabColumn;
}

/** Common::getAllKeys(): the "db.table.column" of every indexed column, or only of unique ones. */
async function getAllKeys(context: PmaContext, tables: DesignerTable[], uniqueOnly = false): Promise<Map<string, number>> {
	const keys = new Map<string, number>();
	for (const table of tables) {
		const schema = table.getDatabaseName();
		const indexes = await getIndexesFromTable(context, table.getTableName(), schema);
		for (const index of indexes.values()) {
			if (uniqueOnly && !index.isUnique()) {
				continue;
			}
			for (const column of index.getColumns().keys()) {
				keys.set(`${schema}.${table.getTableName()}.${column}`, 1);
			}
		}
	}
	return keys;
}

/** Common::getScriptContr(): the foreign keys of every table in the database (no internal relations without storage). */
async function getScriptContr(context: PmaContext, tables: DesignerTable[]): Promise<Record<string, unknown>[]> {
	const { db, dbi } = context;
	await dbi.selectDb(db);
	const constraints: Constraint[] = [];
	const result = await dbi.query(`SHOW TABLES FROM ${backquote(db)}`);
	for (const value of result.fetchAllColumn()) {
		const name = String(value);
		const foreigners = await getForeigners(context, db, name, 'foreign');
		// Without access to all of a table's columns its foreign keys are unknown.
		for (const key of foreigners.foreign_keys_data ?? []) {
			for (const [index, field] of (key.index_list ?? []).entries()) {
				constraints.push({
					name: rawurlencode(String(key.constraint ?? '')),
					sourceTable: rawurlencode(`${db}.${name}`),
					sourceColumn: rawurlencode(String(field)),
					targetTable: rawurlencode(`${key.ref_db_name ?? db}.${key.ref_table_name}`),
					targetColumn: rawurlencode(String(key.ref_index_list?.[index] ?? '')),
				});
			}
		}
	}
	return scriptContr(constraints, tables);
}

interface TablesData {
	tables: DesignerTable[];
	tabColumn: Map<string, TableColumns>;
	allKeys: Map<string, number>;
	pkOrUniqueKeys: Map<string, number>;
}

/** Designer::getDatabaseTables() for the add_table dialog. */
async function getDatabaseTables(context: PmaContext, db: string, data: TablesData): Promise<string> {
	return render(context, 'database/designer/database_tables', {
		db: context.db,
		text_dir: 'ltr',
		get_db: db,
		has_query: context.request.params.query !== undefined,
		tab_pos: [],
		display_page: -1,
		tab_column: data.tabColumn,
		tables_all_keys: data.allKeys,
		tables_pk_or_unique_keys: data.pkOrUniqueKeys,
		tables: data.tables,
		columns_type: columnsType(data.tables, data.tabColumn, data.pkOrUniqueKeys),
	});
}

/** Designer::getHtmlForSchemaExport(). */
async function schemaExportDialog(context: PmaContext, page: string): Promise<string> {
	const { config, request } = context;
	const options: OptionRequest = { get: request.query, request: request.params, timeoutPassed: false, section: config.Schema as unknown as Record<string, unknown> };
	const plugins = getSchemaPlugins(config.PDFPageSizes);
	const exportType = request.query.export_type;
	const defaultFormat = typeof exportType === 'string' ? exportType : getDefault(options, 'format');
	return render(context, 'database/designer/schema_export', {
		db: context.db,
		page,
		plugins_choice: getChoice(plugins, defaultFormat),
		options: getOptions(options, plugins),
	});
}

/** The dialogs DesignerController answers before anything else. */
async function dialog(context: PmaContext, kind: unknown): Promise<string> {
	const post = context.request.post;
	const db = requestString(post.db);
	if (kind === 'edit' || kind === 'delete') {
		return render(context, 'database/designer/edit_delete_pages', { db, operation: `${kind}Page`, pdfwork: false, pages: [] });
	}
	if (kind === 'save_as') {
		return render(context, 'database/designer/page_save_as', { db, pdfwork: false, pages: [] });
	}
	if (kind === 'export') {
		return schemaExportDialog(context, requestString(post.selected_page));
	}
	if (kind === 'add_table') {
		const tables = await getTablesInfo(context, db, requestString(post.table));
		const tabColumn = await getColumnsInfo(context, tables);
		const allKeys = await getAllKeys(context, tables);
		const pkOrUniqueKeys = await getAllKeys(context, tables, true);
		return getDatabaseTables(context, db, { tables, tabColumn, allKeys, pkOrUniqueKeys });
	}
	return '';
}

/** The storage engine of a table, upper-cased as Common::addNewRelation() compares them. */
async function engineOf(context: PmaContext, db: string, table: string): Promise<string | null> {
	const tables = await context.dbi.getTablesFull(db, table);
	const engine = tables.get(table)?.ENGINE;
	return typeof engine === 'string' ? engine.toUpperCase() : null;
}

/** SHOW INDEX columns of a table, as the "has an index" check of Common::addNewRelation() reads them. */
async function indexedColumns(context: PmaContext, db: string, table: string): Promise<Set<string>> {
	const result = await context.dbi.query(`SHOW INDEX FROM ${backquote(db)}.${backquote(table)};`);
	return new Set(result.fetchAllAssoc().map(row => String(row.Column_name)));
}

/** Common::addNewRelation(): only native foreign keys, as internal relations need configuration storage. */
async function addNewRelation(context: PmaContext): Promise<[boolean, string]> {
	const { dbi } = context;
	const post = context.request.post;
	const [t1, f1, t2, f2, db1, db2] = ['T1', 'F1', 'T2', 'F2', 'DB1', 'DB2'].map(key => requestString(post[key]));
	const type1 = await engineOf(context, db1, t1) ?? '';
	const type2 = await engineOf(context, db2, t2) ?? '';
	if (!isForeignKeySupportedEngine(type1) || !isForeignKeySupportedEngine(type2) || type1 !== type2) {
		return [false, 'Error: Relational features are disabled!'];
	}
	const existing = searchColumnInForeigners(await getForeigners(context, db2, t2, 'foreign'), f2, context.db);
	if (existing !== false && existing.constraint !== undefined && existing.constraint !== null) {
		return [false, 'Error: relationship already exists.'];
	}
	const index1 = await indexedColumns(context, db1, t1);
	const index2 = await indexedColumns(context, db2, t2);
	if (!index1.has(f1) || !index2.has(f2)) {
		return [false, 'Error: Missing index on column(s).'];
	}
	let query = `ALTER TABLE ${backquote(db2)}.${backquote(t2)} ADD FOREIGN KEY (${backquote(f2)}) REFERENCES ${backquote(db1)}.${backquote(t1)}(${backquote(f1)})`;
	const onDelete = requestString(post.on_delete);
	const onUpdate = requestString(post.on_update);
	if (onDelete !== 'nix') {
		query += ` ON DELETE ${onDelete}`;
	}
	if (onUpdate !== 'nix') {
		query += ` ON UPDATE ${onUpdate}`;
	}
	query += ';';
	if (await dbi.tryQuery(query) !== false) {
		return [true, 'FOREIGN KEY relationship has been added.'];
	}
	return [false, `Error: FOREIGN KEY relationship could not be added!<br>${dbi.getError()}`];
}

/** Thrown where Designer\Common (strict_types) passes null to mb_strtoupper() for a table getTablesFull() did not find. */
class MissingTableError extends Error {}

/** Common::removeRelation(): drops a native foreign key; internal relations need configuration storage. */
async function removeRelation(context: PmaContext): Promise<[boolean, string]> {
	const post = context.request.post;
	const [db1, t1] = requestString(post.T1).split('.', 2);
	const [db2, t2] = requestString(post.T2).split('.', 2);
	const type1 = await engineOf(context, db1, t1 ?? '');
	const type2 = await engineOf(context, db2, t2 ?? '');
	if (type1 === null || type2 === null) {
		throw new MissingTableError();
	}
	if (isForeignKeySupportedEngine(type1) && isForeignKeySupportedEngine(type2) && type1 === type2) {
		const foreigner = searchColumnInForeigners(await getForeigners(context, db2, t2, 'foreign'), requestString(post.F2), context.db);
		if (foreigner !== false && foreigner.constraint !== undefined && foreigner.constraint !== null) {
			await context.dbi.query(`ALTER TABLE ${backquote(db2)}.${backquote(t2)} DROP FOREIGN KEY ${backquote(foreigner.constraint)};`);
			return [true, 'FOREIGN KEY relationship has been removed.'];
		}
	}
	return [false, 'Error: Relational features are disabled!'];
}

/** The POSTed operations, which only report success or failure. */
async function operation(context: PmaContext, kind: unknown): Promise<Response> {
	const { response } = context;
	const post = context.request.post;
	if (kind === 'deletePage') {
		response.setRequestStatus(false);
	} else if (kind === 'savePage') {
		// Without storage no page exists or can be created, and saving positions fails.
		if (post.save_page !== 'same') {
			response.addJSON('id', null);
		}
		response.setRequestStatus(false);
	} else if (kind === 'setDisplayField') {
		const message = 'phpMyAdmin configuration storage is not configured for "Display Features".';
		response.setRequestStatus(false);
		response.addJSON('message', message);
		// Upstream assigns the global $message, which the header also shows.
		response.globals.message = message;
	} else if (kind === 'addNewRelation' || kind === 'removeRelation') {
		let result: [boolean, string];
		try {
			result = kind === 'addNewRelation' ? await addNewRelation(context) : await removeRelation(context);
		} catch (error) {
			if (!(error instanceof MissingTableError)) {
				throw error;
			}
			return internalErrorPage(context, 'TypeError');
		}
		response.setRequestStatus(result[0]);
		response.addJSON('message', result[1]);
		response.globals.message = result[1];
	}
	// save_setting_value succeeds without doing anything when there is no settings storage.
	return response.response();
}

/** Database\DesignerController. */
export async function designerController(context: PmaContext): Promise<Response> {
	const { db, request, response, server } = context;
	const { post, query } = request;
	if (post.dialog !== undefined) {
		const html = await dialog(context, post.dialog);
		if (html !== '' && html !== '0') {
			response.addHTML(html);
		}
		return response.response();
	}
	if (post.operation !== undefined) {
		return operation(context, post.operation);
	}
	if (!await hasDatabase(context)) {
		return response.response();
	}
	const tables = await getTablesInfo(context);
	const visualBuilderMode = query.query !== undefined;
	// Without storage there are no saved pages, so the page is -1 unless one is requested.
	let displayPage = -1;
	if (!visualBuilderMode && query.page !== undefined && query.page !== '' && query.page !== '0') {
		displayPage = phpInt(query.page);
	}
	const tabColumn = await getColumnsInfo(context, tables);
	const tabs = scriptTabs(tables);
	const pkOrUniqueKeys = await getAllKeys(context, tables, true);
	const allKeys = await getAllKeys(context, tables);
	const contr = await getScriptContr(context, tables);
	response.setMinimal();
	response.setBodyId('designer_body');
	response.addScriptFiles(['designer/database.js', 'designer/objects.js', 'designer/page.js', 'designer/history.js', 'designer/move.js', 'designer/init.js']);
	await getDbInfo(context, '');
	const displayedFields: Record<string, string> = {};
	for (const table of tables) {
		const field = table.getDisplayField();
		if (field !== null) {
			displayedFields[table.getTableName()] = field;
		}
	}
	const designerConfig = {
		db,
		scriptTables: tabs,
		scriptContr: contr,
		server,
		scriptDisplayField: Object.keys(displayedFields).length === 0 ? [] : displayedFields,
		displayPage,
		tablesEnabled: false,
	};
	response.addHTML(await render(context, 'database/designer/main', {
		db,
		text_dir: 'ltr',
		get_db: requestString(query.db),
		designer_config: phpJsonEncode(designerConfig),
		display_page: displayPage,
		has_query: visualBuilderMode,
		visual_builder: visualBuilderMode,
		selected_page: null,
		params_array: MENU_BUTTON_CLASSES,
		tab_pos: [],
		tab_column: tabColumn,
		tables_all_keys: allKeys,
		tables_pk_or_unique_keys: pkOrUniqueKeys,
		designerTables: tables,
		columns_type: columnsType(tables, tabColumn, pkOrUniqueKeys),
	}));
	response.addHTML('<div id="PMA_disable_floating_menubar"></div>');
	return response.response();
}

export const controllers = {
	'Database/DesignerController': designerController,
};

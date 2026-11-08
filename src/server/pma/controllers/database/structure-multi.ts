// Ports of the Database\Structure controllers behind the "With selected:" menu: confirmation forms and their actions.
import { disableResponse, redirect, render } from './common.ts';
import { renderStructure } from './structure.ts';
import { isSystemSchema } from '../../../../lib/pma/dbi-sql.ts';
import { FlashMessages } from '../../../../lib/pma/flash-messages.ts';
import { Message } from '../../../../lib/pma/message.ts';
import { htmlspecialchars } from '../../../../lib/twig/php.ts';
import { backquote } from '../../../../lib/twig/sanitize.ts';
import { handleDisableCheckCleanup, handleDisableCheckInit, isCheckEnabled } from '../../core/foreign-key.ts';
import { Table } from '../../core/table.ts';
import { withMysqlDie } from '../server/mysql-die.ts';
import { moveCopy } from '../table-structure/move-copy.ts';

import type { PmaContext } from '../../core/context.ts';

/** A posted list such as selected_tbl[], or [] when it is missing or not an array. */
export function postedList(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.map(String);
	}
	if (typeof value === 'object' && value !== null) {
		return Object.values(value).map(String);
	}
	return [];
}

/** Characters, not UTF-16 units, like mb_substr()/mb_strlen(). */
function mbSubstr(value: string, start: number, length?: number): string {
	const characters = [...value];
	return characters.slice(start, length === undefined ? undefined : start + length).join('');
}

/** The "No table selected." JSON error the form controllers answer with when nothing is ticked. */
function noTableSelected(context: PmaContext): Promise<Response> {
	context.response.setRequestStatus(false);
	context.response.addJSON('message', 'No table selected.');
	return context.response.response();
}

/** DatabaseInterface::getVirtualTables(): the views of a database. */
async function getVirtualTables(context: PmaContext): Promise<string[]> {
	const tables = await context.dbi.getTablesFull(context.db);
	const views: string[] = [];
	for (const row of tables.values()) {
		const name = String(row.TABLE_NAME);
		if (await Table.get(context, name, context.db).isView()) {
			views.push(name);
		}
	}
	return views;
}

function selectedParams(context: PmaContext, selected: string[]): Record<string, unknown> {
	return { db: context.db, selected };
}

/** Ends an action by showing the table list with the action's message, like `($this->structureController)()`. */
async function showStructure(context: PmaContext, message: Message, sqlQuery: string | null = null, flash?: FlashMessages): Promise<Response> {
	context.response.globals.message = message;
	if (sqlQuery !== null) {
		context.response.globals.sqlQuery = sqlQuery;
	}
	return renderStructure(context, flash ?? new FlashMessages(context.session.data));
}

/** Database\Structure\DropFormController. */
export async function dropFormController(context: PmaContext): Promise<Response> {
	const selected = postedList(context.request.post.selected_tbl);
	if (selected.length === 0) {
		return noTableSelected(context);
	}
	const views = await getVirtualTables(context);
	let fullQueryViews = '';
	let fullQuery = '';
	for (const current of selected) {
		if (views.includes(current)) {
			fullQueryViews += (fullQueryViews === '' ? 'DROP VIEW ' : ', ') + backquote(htmlspecialchars(current));
		} else {
			fullQuery += (fullQuery === '' ? 'DROP TABLE ' : ', ') + backquote(htmlspecialchars(current));
		}
	}
	if (fullQuery !== '') {
		fullQuery += ';<br>\n';
	}
	if (fullQueryViews !== '') {
		fullQuery += `${fullQueryViews};<br>\n`;
	}
	const urlParams: Record<string, unknown> = selectedParams(context, selected);
	if (views.length > 0) {
		urlParams.views = views;
	}
	context.response.addHTML(await render(context, 'database/structure/drop_form', {
		url_params: urlParams,
		full_query: fullQuery,
		is_foreign_key_check: await isCheckEnabled(context),
	}));
	return context.response.response();
}

/** Database\Structure\DropTableController. */
export async function dropTableController(context: PmaContext): Promise<Response> {
	const { db, dbi, request, response } = context;
	const reload = request.post.reload;
	if (reload !== undefined && reload !== '' && reload !== '0') {
		response.globals.reload = true;
	}
	const selected = postedList(request.post.selected);
	const views = await getVirtualTables(context);
	if (request.post.mult_btn !== 'Yes') {
		return showStructure(context, Message.success('No change'));
	}
	const defaultFkCheckValue = await handleDisableCheckInit(context);
	let sqlQuery = '';
	let sqlQueryViews = '';
	for (const current of selected) {
		if (views.includes(current)) {
			sqlQueryViews += (sqlQueryViews === '' ? 'DROP VIEW ' : ', ') + backquote(current);
		} else {
			sqlQuery += (sqlQuery === '' ? 'DROP TABLE ' : ', ') + backquote(current);
		}
		response.globals.reload = true;
	}
	if (sqlQuery !== '') {
		sqlQuery += ';';
	} else if (sqlQueryViews !== '') {
		sqlQuery = `${sqlQueryViews};`;
		sqlQueryViews = '';
	}
	// Issue #14205: the cached position may point past the shorter list.
	const tmpval = context.session.data.tmpval;
	if (tmpval !== undefined) {
		delete tmpval.table_limit_offset;
		delete tmpval.table_limit_offset_db;
	}
	let message = Message.success();
	await dbi.selectDb(db);
	let result = await dbi.tryQuery(sqlQuery) !== false;
	if (!result) {
		message = Message.error(dbi.getError());
	}
	if (result && sqlQueryViews !== '') {
		sqlQuery += ` ${sqlQueryViews};`;
		result = await dbi.tryQuery(sqlQueryViews) !== false;
	}
	if (!result) {
		message = Message.error(dbi.getError());
	}
	await handleDisableCheckCleanup(context, defaultFkCheckValue);
	return showStructure(context, message, sqlQuery);
}

/** Database\Structure\EmptyFormController. */
export async function emptyFormController(context: PmaContext): Promise<Response> {
	const selected = postedList(context.request.post.selected_tbl);
	if (selected.length === 0) {
		return noTableSelected(context);
	}
	const fullQuery = selected.map(name => `TRUNCATE ${backquote(htmlspecialchars(name))};<br>`).join('');
	context.response.addHTML(await render(context, 'database/structure/empty_form', {
		url_params: selectedParams(context, selected),
		full_query: fullQuery,
		is_foreign_key_check: await isCheckEnabled(context),
	}));
	return context.response.response();
}

/** Database\Structure\EmptyTableController. */
export async function emptyTableController(context: PmaContext): Promise<Response> {
	const { db, dbi, request, response } = context;
	const flash = new FlashMessages(context.session.data);
	if (request.post.mult_btn !== 'Yes') {
		flash.addMessage('success', 'No change');
		redirect(context, '/database/structure', { db });
		return response.response();
	}
	return withMysqlDie(context, async () => {
		const defaultFkCheckValue = await handleDisableCheckInit(context);
		let sqlQuery = '';
		for (const name of postedList(request.post.selected)) {
			if (await Table.get(context, name, db).isView()) {
				continue;
			}
			const query = `TRUNCATE ${backquote(name)}`;
			sqlQuery += `${query};\n`;
			await dbi.selectDb(db);
			await dbi.query(query);
		}
		await handleDisableCheckCleanup(context, defaultFkCheckValue);
		response.globals.sqlQuery = sqlQuery;
		return showStructure(context, Message.success(), null, flash);
	});
}

/** Database\Structure\AddPrefixController: the add prefix dialog body. */
export async function addPrefixController(context: PmaContext): Promise<Response> {
	const selected = postedList(context.request.post.selected_tbl);
	if (selected.length === 0) {
		return noTableSelected(context);
	}
	disableResponse(context);
	context.response.addHTML(await render(context, 'database/structure/add_prefix', { url_params: selectedParams(context, selected) }));
	return context.response.response();
}

/** Database\Structure\ChangePrefixFormController: the replace or copy prefix dialog body. */
export async function changePrefixFormController(context: PmaContext): Promise<Response> {
	const selected = postedList(context.request.post.selected_tbl);
	if (selected.length === 0) {
		return noTableSelected(context);
	}
	let route = '/database/structure/replace-prefix';
	if (context.request.post.submit_mult === 'copy_tbl_change_prefix') {
		route = '/database/structure/copy-table-with-prefix';
	}
	disableResponse(context);
	context.response.addHTML(await render(context, 'database/structure/change_prefix_form', { route, url_params: selectedParams(context, selected) }));
	return context.response.response();
}

/** Renames each selected table; the shared loop of AddPrefixTableController and ReplacePrefixController. */
async function renameTables(context: PmaContext, newName: (current: string) => string): Promise<Response> {
	const { db, dbi } = context;
	return withMysqlDie(context, async () => {
		let sqlQuery = '';
		for (const current of postedList(context.request.post.selected)) {
			const query = `ALTER TABLE ${backquote(current)} RENAME ${backquote(newName(current))}`;
			sqlQuery += `${query};\n`;
			await dbi.selectDb(db);
			await dbi.query(query);
		}
		return showStructure(context, Message.success(), sqlQuery);
	});
}

/** Database\Structure\AddPrefixTableController. */
export async function addPrefixTableController(context: PmaContext): Promise<Response> {
	const prefix = String(context.request.post.add_prefix ?? '');
	return renameTables(context, current => prefix + current);
}

/** Database\Structure\ReplacePrefixController. */
export async function replacePrefixController(context: PmaContext): Promise<Response> {
	const fromPrefix = String(context.request.post.from_prefix ?? '');
	const toPrefix = String(context.request.post.to_prefix ?? '');
	const length = [...fromPrefix].length;
	return renameTables(context, (current) => {
		if (mbSubstr(current, 0, length) === fromPrefix) {
			return toPrefix + mbSubstr(current, length);
		}
		return current;
	});
}

/** Database\Structure\CopyFormController: the copy tables dialog body. */
export async function copyFormController(context: PmaContext): Promise<Response> {
	const selected = postedList(context.request.post.selected_tbl);
	if (selected.length === 0) {
		return noTableSelected(context);
	}
	const databaseList = await context.dbi.getDatabaseList();
	const databases = databaseList.filter(name => name !== context.db && !isSystemSchema(name));
	disableResponse(context);
	context.response.addHTML(await render(context, 'database/structure/copy_form', {
		url_params: selectedParams(context, selected),
		options: databases.map((name) => {
			return { name, is_selected: false };
		}),
	}));
	return context.response.response();
}

/** Core::mimeDefaultFunction(). */
function mimeDefault(buffer: string): string {
	return htmlspecialchars(buffer).replaceAll('  ', ' &nbsp;').replaceAll(/\r\n|\r|\n/g, '<br>\n');
}

/** Database\Structure\ShowCreateController. */
export async function showCreateController(context: PmaContext): Promise<Response> {
	const selected = postedList(context.request.post.selected_tbl);
	if (selected.length === 0) {
		return noTableSelected(context);
	}
	const tables: Record<'tables' | 'views', { name: string; show_create: string; }[]> = { tables: [], views: [] };
	for (const name of selected) {
		const table = Table.get(context, name, context.db);
		const key = await table.isView() ? 'views' : 'tables';
		tables[key].push({ name: mimeDefault(name), show_create: mimeDefault(await table.showCreate()) });
	}
	context.response.addJSON('message', await render(context, 'database/structure/show_create', { tables }));
	return context.response.response();
}

const CENTRAL_COLUMNS_NOT_READY = 'The configuration storage is not ready for the central list of columns feature.';

/** Structure\CentralColumns\AddController and RemoveController: without configuration storage both report it is not ready. */
export async function centralColumnsUnavailableController(context: PmaContext): Promise<Response> {
	if (postedList(context.request.post.selected_tbl).length === 0) {
		return noTableSelected(context);
	}
	return showStructure(context, Message.error(CENTRAL_COLUMNS_NOT_READY));
}

/**
 * Structure\CentralColumns\MakeConsistentController. Without storage no central column matches, so each table only
 * gets an empty `ALTER TABLE`, as upstream sends.
 */
export async function centralColumnsMakeConsistentController(context: PmaContext): Promise<Response> {
	const { db, dbi } = context;
	const selected = postedList(context.request.post.selected_tbl);
	if (selected.length === 0) {
		return noTableSelected(context);
	}
	let message: Message | null = null;
	for (const table of selected) {
		await dbi.selectDb(db);
		if (await dbi.tryQuery(`ALTER TABLE ${backquote(table)};`) !== false) {
			continue;
		}
		if (message === null) {
			message = Message.error(dbi.getError());
		} else {
			message.addText(dbi.getError(), '<br>');
		}
	}
	return showStructure(context, message ?? Message.success('Success!'));
}

/** The drop_if_exists checkbox of the copy dialogs, which only counts as the string 'true'. */
function dropIfExists(context: PmaContext): boolean {
	return context.request.post.drop_if_exists === 'true';
}

/** Structure/CopyTableController: Table::moveCopy() of each table into the target database. */
export async function copyTableController(context: PmaContext): Promise<Response> {
	const { db, request } = context;
	const targetDb = typeof request.post.target_db === 'string' ? request.post.target_db : '';
	return withMysqlDie(context, async () => {
		for (const table of postedList(request.post.selected)) {
			await moveCopy(context, { sourceDb: db, sourceTable: table, targetDb, targetTable: table, what: String(request.post.what ?? ''), move: false, addDropIfExists: dropIfExists(context) });
			// Operations::adjustPrivilegesCopyTable() needs the RELOAD privilege, which customers do not have.
		}
		return showStructure(context, Message.success());
	});
}

/** Structure/CopyTableWithPrefixController. */
export async function copyTableWithPrefixController(context: PmaContext): Promise<Response> {
	const { db, request } = context;
	const fromLength = [...String(request.post.from_prefix ?? '')].length;
	const toPrefix = String(request.post.to_prefix ?? '');
	return withMysqlDie(context, async () => {
		for (const table of postedList(request.post.selected)) {
			const targetTable = toPrefix + mbSubstr(table, fromLength);
			await moveCopy(context, { sourceDb: db, sourceTable: table, targetDb: db, targetTable, what: 'data', move: false, addDropIfExists: dropIfExists(context) });
		}
		return showStructure(context, Message.success());
	});
}

export const controllers = {
	'Database/Structure/CopyTableController': copyTableController,
	'Database/Structure/CopyTableWithPrefixController': copyTableWithPrefixController,
	'Database/Structure/CentralColumns/AddController': centralColumnsUnavailableController,
	'Database/Structure/CentralColumns/RemoveController': centralColumnsUnavailableController,
	'Database/Structure/CentralColumns/MakeConsistentController': centralColumnsMakeConsistentController,
	'Database/Structure/DropFormController': dropFormController,
	'Database/Structure/DropTableController': dropTableController,
	'Database/Structure/EmptyFormController': emptyFormController,
	'Database/Structure/EmptyTableController': emptyTableController,
	'Database/Structure/AddPrefixController': addPrefixController,
	'Database/Structure/AddPrefixTableController': addPrefixTableController,
	'Database/Structure/ChangePrefixFormController': changePrefixFormController,
	'Database/Structure/ReplacePrefixController': replacePrefixController,
	'Database/Structure/CopyFormController': copyFormController,
	'Database/Structure/ShowCreateController': showCreateController,
};

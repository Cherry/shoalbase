// Ports of the Table\Structure key controllers: add-key, index, unique, fulltext, spatial and primary.
import { checkDbTableExists, forwardTo, render } from './common.ts';
import { structureController } from './structure.ts';
import { Message } from '../../../../lib/pma/message.ts';
import { backquote } from '../../../../lib/twig/sanitize.ts';

import type { PmaContext } from '../../core/context.ts';
import type { DbiRow } from '../../core/dbi.ts';

const list = (value: unknown): string[] => (Array.isArray(value) ? value : []);

/** AddKeyController: runs the posted ALTER through the SQL controller, then shows the structure with a navigation reload. */
export async function addKeyController(context: PmaContext): Promise<Response> {
	await forwardTo(context, 'Sql/SqlController');
	context.response.globals.reload = true;
	return structureController(context);
}

/** AddIndexController and its UNIQUE, FULLTEXT and SPATIAL twins: one key over the selected columns. */
function keyController(keyword: string) {
	return async (context: PmaContext): Promise<Response> => {
		const { dbi, response } = context;
		const selected = list(context.request.post.selected_fld);
		if (selected.length === 0) {
			response.setRequestStatus(false);
			response.addJSON('message', 'No column selected.');
			return response.response();
		}
		const sqlQuery = `ALTER TABLE ${backquote(context.table)} ADD ${keyword}(${selected.map(field => backquote(field)).join(', ')});`;
		response.globals.sqlQuery = sqlQuery;
		await dbi.selectDb(context.db);
		const result = await dbi.tryQuery(sqlQuery);
		response.globals.message = result === false ? Message.error(dbi.getError()) : Message.success();
		return structureController(context);
	};
}

/** PrimaryController::getKeyForTablePrimary(). */
async function primaryKeyColumns(context: PmaContext): Promise<string> {
	await context.dbi.selectDb(context.db);
	const result = await context.dbi.query(`SHOW KEYS FROM ${backquote(context.table)};`);
	return result.fetchAllAssoc().filter((row: DbiRow) => row.Key_name === 'PRIMARY').map(row => `${row.Column_name ?? ''}, `)
		.join('');
}

/** PrimaryController: asks before replacing an existing primary key. */
export async function primaryController(context: PmaContext): Promise<Response> {
	const { dbi, response } = context;
	let selected = list(context.request.post.selected);
	const selectedFields = list(context.request.post.selected_fld);
	if (selected.length === 0 && selectedFields.length === 0) {
		response.setRequestStatus(false);
		response.addJSON('message', 'No column selected.');
		return response.response();
	}
	const primary = await primaryKeyColumns(context);
	let button = '';
	if (primary === '' && selectedFields.length > 0) {
		button = 'Yes';
		selected = selectedFields;
	}
	const posted = context.request.post.mult_btn;
	if (typeof posted === 'string') {
		button = posted;
	}
	if (selectedFields.length > 0 && primary !== '') {
		const missing = await checkDbTableExists(context);
		if (missing !== null) {
			return missing;
		}
		response.addHTML(await render(context, 'table/structure/primary', { db: context.db, table: context.table, selected: selectedFields }));
		return response.response();
	}
	if (button === 'Yes') {
		let sqlQuery = `ALTER TABLE ${backquote(context.table)}`;
		if (primary !== '') {
			sqlQuery += ' DROP PRIMARY KEY,';
		}
		sqlQuery += ` ADD PRIMARY KEY(${selected.map(field => backquote(field)).join(', ')});`;
		response.globals.sqlQuery = sqlQuery;
		await dbi.selectDb(context.db);
		if (await dbi.tryQuery(sqlQuery) === false) {
			response.globals.message = Message.error(dbi.getError());
		}
	}
	response.globals.message ??= Message.success();
	return structureController(context);
}


/** CentralColumnsAddController and CentralColumnsRemoveController: without configuration storage both report it and show the structure. */
async function centralColumnsController(context: PmaContext): Promise<Response> {
	const { response } = context;
	if (list(context.request.post.selected_fld).length === 0) {
		response.setRequestStatus(false);
		response.addJSON('message', 'No column selected.');
		return response.response();
	}
	response.globals.message = Message.error('The configuration storage is not ready for the central list of columns feature.');
	return structureController(context);
}
export const controllers = {
	'Table/Structure/AddKeyController': addKeyController,
	'Table/Structure/AddIndexController': keyController('INDEX'),
	'Table/Structure/UniqueController': keyController('UNIQUE'),
	'Table/Structure/FulltextController': keyController('FULLTEXT'),
	'Table/Structure/SpatialController': keyController('SPATIAL'),
	'Table/Structure/PrimaryController': primaryController,
	'Table/Structure/CentralColumnsAddController': centralColumnsController,
	'Table/Structure/CentralColumnsRemoveController': centralColumnsController,
};

// Ports of Controllers\Table\AddFieldController (/table/add-field) and Table\CreateController (/table/create).
import { columnsFormData, serverKind } from './columns-definition.ts';
import { checkDbTableExists, mysqlDieHtmlFor, render } from './common.ts';
import { previewSql } from './save.ts';
import { Message } from '../../../../lib/pma/message.ts';
import { nestedParams } from '../../../../lib/pma/table-data/php-params.ts';
import { CreateAddField } from '../../../../lib/pma/table-structure/create-add-field.ts';
import { htmlspecialchars } from '../../../../lib/twig/php.ts';
import { getFromRoute } from '../../../../lib/twig/url.ts';
import { getMessage } from '../../core/generator.ts';
import { isValidStorageEngine } from '../../core/storage-engine.ts';
import { setMenuTable } from '../../shell/menu.ts';

import type { PmaContext } from '../../core/context.ts';

const int = (value: unknown): number => (typeof value === 'string' ? Math.trunc(Number.parseFloat(value)) || 0 : 0);

/** Generator::mysqlDie() with a back link and exit; the customer only reaches it with a bad database or table name. */
function mysqlDie(context: PmaContext, serverMessage: string, sqlQuery: string, backUrl: string): Promise<Response> {
	const { response } = context;
	const html = mysqlDieHtmlFor(context, serverMessage, sqlQuery, false);
	if (response.isAjax) {
		response.setRequestStatus(false);
		response.addJSON('message', html);
		return response.response();
	}
	const back = backUrl.includes('?') ? `${backUrl}&amp;no_history=true` : `${backUrl}?no_history=true`;
	response.addHTML(`${html}<fieldset class="pma-fieldset tblFooters">[ <a href="${back}">Back</a> ]</fieldset>\n\n`);
	return response.response();
}

export async function addFieldController(context: PmaContext): Promise<Response> {
	const { dbi, response } = context;
	response.addScriptFiles(['table/structure.js']);
	const post = nestedParams(context.request.post);
	const errorUrl = getFromRoute(context.urlState(), '/table/sql', { db: context.db, table: context.table });

	let numFields = 1;
	let regenerate = false;
	if (post.submit_num_fields !== undefined) {
		// The form keeps its own position fields, which ColumnsDefinition reads back from $_POST.
		if (post.orig_after_field !== undefined) {
			context.request.post.after_field = context.request.post.orig_after_field;
		}
		if (post.orig_field_where !== undefined) {
			context.request.post.field_where = context.request.post.orig_field_where;
		}
		numFields = Math.min(int(post.orig_num_fields) + int(post.added_fields), 4096);
		regenerate = true;
	} else if (int(post.num_fields) > 0) {
		numFields = Math.min(4096, int(post.num_fields));
	}

	if (post.do_save_data !== undefined) {
		const createAddField = new CreateAddField(post, serverKind(context));
		const sqlQuery = createAddField.getColumnCreationQuery(context.table);
		response.globals.sqlQuery = sqlQuery;
		if (post.preview_sql !== undefined) {
			previewSql(context, sqlQuery);
			return response.response();
		}
		if (!await dbi.selectDb(context.db)) {
			return mysqlDie(context, dbi.getError(), `USE ${context.db}`, errorUrl);
		}
		if (await dbi.tryQuery(sqlQuery) === false) {
			// Upstream passes neither, so mysqlDie() falls back to the last error and the query global.
			response.addHTML(mysqlDieHtmlFor(context, '', '', false));
			response.setRequestStatus(false);
			return response.response();
		}
		const message = Message.success('Table %1$s has been altered successfully.');
		message.addParam(context.table);
		// Upstream keeps it in the  global as well, so the header shows it too.
		response.globals.message = message;
		response.addJSON('message', await getMessage(context, message, { sqlQuery, type: 'success' }));
		response.addJSON('structure_refresh_route', getFromRoute(context.urlState(), '/table/structure', { db: context.db, table: context.table, ajax_request: '1' }));
		return response.response();
	}

	const missing = await checkDbTableExists(context);
	if (missing !== null) {
		return missing;
	}
	response.addScriptFiles(['vendor/jquery/jquery.uitablefilter.js', 'indexes.js']);
	const data = await columnsFormData(context, { action: getFromRoute(context.urlState(), '/table/add-field'), numFields, regenerate });
	response.addHTML(await render(context, 'columns_definitions/column_definitions_form', data));
	return response.response();
}

export async function createController(context: PmaContext): Promise<Response> {
	const { dbi, response } = context;
	const url = context.urlState();
	if (context.db === '') {
		return mysqlDie(context, 'The database name is empty!', '', 'index.php');
	}
	if (!await dbi.selectDb(context.db)) {
		return mysqlDie(context, `'${htmlspecialchars(context.db)}' database does not exist.`, '', 'index.php');
	}
	const existingColumns = await dbi.getColumns(context.db, context.table);
	if (existingColumns.size > 0) {
		return mysqlDie(context, `Table ${htmlspecialchars(context.table)} already exists!`, '', getFromRoute(url, '/database/structure', { db: context.db }));
	}
	const post = nestedParams(context.request.post);
	const createAddField = new CreateAddField(post, serverKind(context));
	const numFields = createAddField.getNumberOfFieldsFromRequest();

	if (post.do_save_data !== undefined) {
		let { db, table } = context;
		if (await dbi.getLowerCaseNames() === '1') {
			db = db.toLowerCase();
			table = table.toLowerCase();
		}
		const engine = typeof post.tbl_storage_engine === 'string' ? post.tbl_storage_engine : '';
		const sqlQuery = createAddField.getTableCreationQuery(db, table, await isValidStorageEngine(context, engine));
		response.globals.sqlQuery = sqlQuery;
		if (post.preview_sql !== undefined) {
			previewSql(context, sqlQuery);
			return response.response();
		}
		if (await dbi.tryQuery(sqlQuery) === false) {
			response.setRequestStatus(false);
			response.addJSON('message', dbi.getError());
		}
		return response.response();
	}

	// The table does not exist yet, so the menu leaves it out.
	setMenuTable(context, '');
	response.addScriptFiles(['vendor/jquery/jquery.uitablefilter.js', 'indexes.js']);
	const action = getFromRoute(url, '/table/create');
	const data = await columnsFormData(context, { action, numFields });
	response.addHTML(await render(context, 'columns_definitions/column_definitions_form', data));
	return response.response();
}

export const controllers = {
	'Table/AddFieldController': addFieldController,
	'Table/CreateController': createController,
};

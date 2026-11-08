// Ports of Controllers\View\CreateController and View\OperationsController (routes /view/create and /view/operations).
import { checkDbTableExists, render } from './common.ts';
import { renameTable } from './move-copy.ts';
import { structureController } from './structure.ts';
import { escapeString } from '../../../../lib/pma/dbi-sql.ts';
import { Message } from '../../../../lib/pma/message.ts';
import { type PhpArray, nestedParams, phpArray } from '../../../../lib/pma/table-data/php-params.ts';
import { warningMessages } from '../../../../lib/pma/table-structure/maintenance.ts';
import { createViewQuery } from '../../../../lib/pma/table-structure/view.ts';
import { htmlspecialchars } from '../../../../lib/twig/php.ts';
import { getFromRoute } from '../../../../lib/twig/url.ts';
import { CreateStatement, Parser, TokensList } from '../../../../sql-parser/index.ts';
import { getMessage } from '../../core/generator.ts';
import { Table } from '../../core/table.ts';
import { hasDatabase, internalErrorPage } from '../database/common.ts';
import { loadParserContext } from '../table-data/relation.ts';

import type { PmaContext } from '../../core/context.ts';

const VIEW_ALGORITHM_OPTIONS = ['UNDEFINED', 'MERGE', 'TEMPTABLE'];
const VIEW_WITH_OPTIONS = ['CASCADED', 'LOCAL'];
const VIEW_SECURITY_OPTIONS = ['DEFINER', 'INVOKER'];

const isEmpty = (value: unknown): boolean => [undefined, null, '', '0'].includes(value as never);

/** The form values of an existing view, read like CreateController's "edit view" prefill. */
async function existingView(context: PmaContext, db: string, table: string): Promise<Record<string, unknown>> {
	const { dbi } = context;
	const item = await dbi.fetchSingleRow(`SELECT \`VIEW_DEFINITION\`, \`CHECK_OPTION\`, \`DEFINER\`,
            \`SECURITY_TYPE\`
            FROM \`INFORMATION_SCHEMA\`.\`VIEWS\`
            WHERE TABLE_SCHEMA='${escapeString(db)}'
            AND TABLE_NAME='${escapeString(table)}';`);
	const createView = await Table.get(context, table, db).showCreate();
	// CREATE ALGORITHM=<ALGORITHM> DE...
	const algorithm = createView.slice(17).split(' ', 1)[0];
	let as: unknown = item?.VIEW_DEFINITION ?? null;
	// MySQL 8.0 leaves VIEW_DEFINITION empty for views of other definers (upstream issue #16194).
	if (isEmpty(as)) {
		loadParserContext(context);
		const statement = new Parser(createView).statements[0];
		if (statement instanceof CreateStatement && Array.isArray(statement.body)) {
			as = TokensList.build(statement.body);
		}
	}
	return {
		operation: 'alter',
		definer: item?.DEFINER ?? null,
		sql_security: item?.SECURITY_TYPE ?? null,
		name: table,
		as,
		with: item?.CHECK_OPTION ?? null,
		algorithm,
	};
}

/** Runs the posted CREATE or ALTER VIEW; returns the response to send. */
async function saveView(context: PmaContext, view: PhpArray): Promise<Response> {
	const { dbi, response } = context;
	const post = context.request.post;
	const sqlQuery = createViewQuery(view, post.createview !== undefined);
	response.globals.sqlQuery = sqlQuery;
	if (await dbi.tryQuery(sqlQuery) === false) {
		if (post.ajax_dialog === undefined) {
			response.globals.message = Message.rawError(dbi.getError());
			return response.response();
		}
		response.addJSON('message', Message.error(`<i>${htmlspecialchars(sqlQuery)}</i><br><br>${dbi.getError()}`));
		response.setRequestStatus(false);
		return response.response();
	}
	if (post.ajax_dialog === undefined) {
		response.globals.message = Message.success();
		return structureController(context);
	}
	response.addJSON('message', await getMessage(context, Message.success(), { sqlQuery }));
	response.setRequestStatus(true);
	return response.response();
}

export async function viewCreateController(context: PmaContext): Promise<Response> {
	const { dbi, response } = context;
	if (!await hasDatabase(context)) {
		return response.response();
	}
	const post = nestedParams(context.request.post);
	const postedView = phpArray(post.view);
	if (postedView?.name !== undefined && isEmpty(postedView.name)) {
		response.addJSON('message', Message.error('View name can not be empty!'));
		response.setRequestStatus(false);
		return response.response();
	}
	if (post.createview !== undefined || post.alterview !== undefined) {
		return saveView(context, postedView ?? {});
	}
	const sqlQuery = isEmpty(post.sql_query) ? '' : post.sql_query;
	let view: Record<string, unknown> = {
		operation: 'create',
		or_replace: '',
		algorithm: '',
		definer: '',
		sql_security: '',
		name: '',
		column_names: '',
		as: sqlQuery,
		with: '',
	};
	const query = context.request.query;
	if (query.db !== undefined && query.table !== undefined) {
		view = { ...view, ...await existingView(context, String(query.db), String(query.table)) };
	}
	if (postedView !== undefined) {
		view = { ...view, ...postedView };
	}
	await dbi.connect();
	const url = context.urlState();
	response.addHTML(await render(context, 'view_create', {
		ajax_dialog: post.ajax_dialog !== undefined,
		text_dir: 'ltr',
		// Common::run() starts $urlParams with db, table and server.
		url_params: { db: context.db, table: context.table, server: context.server, goto: getFromRoute(url, '/table/structure'), back: getFromRoute(url, '/view/create'), reload: 1 },
		view,
		view_algorithm_options: VIEW_ALGORITHM_OPTIONS,
		view_with_options: VIEW_WITH_OPTIONS,
		view_security_options: VIEW_SECURITY_OPTIONS,
	}));
	return response.response();
}

export async function viewOperationsController(context: PmaContext): Promise<Response> {
	const { dbi, response } = context;
	const post = context.request.post;
	let table = Table.get(context, context.table, context.db);
	response.addScriptFiles(['table/operations.js']);
	const missing = await checkDbTableExists(context);
	if (missing !== null) {
		return missing;
	}
	const operationsUrl = getFromRoute(context.urlState(), '/view/operations');
	const message = new Message();
	let type: 'success' | 'error' = 'success';
	let result: boolean | undefined;
	let warnings: string[] = [];
	if (post.submitoptions !== undefined) {
		if (post.new_name !== undefined) {
			const renamed = await renameTable(context, table, typeof post.new_name === 'string' ? post.new_name : '');
			// Renaming to the same name leaves Table::$messages empty, and addText(null) is a TypeError.
			if (renamed.ok && renamed.message === '') {
				return internalErrorPage(context, 'TypeError');
			}
			message.addText(renamed.message);
			result = renamed.ok;
			if (renamed.ok) {
				table = renamed.table;
				context.table = table.getName();
				await table.getStatus(true);
				response.globals.reload = true;
			}
		}
		warnings = warningMessages(await dbi.getWarnings(), post.new_tbl_storage_engine);
	}
	if (result !== undefined) {
		if (message.getString() === '') {
			message.addText(result ? 'Your SQL query has been executed successfully.' : 'Error');
			type = result ? 'success' : 'error';
		}
		if (warnings.length > 0) {
			message.addMessagesString(warnings);
			message.isError(true);
		}
		response.addHTML(await getMessage(context, message, { type }));
	}
	response.addHTML(await render(context, 'table/operations/view', {
		db: context.db,
		table: context.table,
		url_params: { db: context.db, table: context.table, back: operationsUrl, goto: operationsUrl },
	}));
	return response.response();
}

export const controllers = {
	'View/CreateController': viewCreateController,
	'View/OperationsController': viewOperationsController,
};

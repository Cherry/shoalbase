// Ports of the column actions of the structure page: drop (confirm and run), browse selected columns and the reserved word check.
import { checkDbTableExists, redirectWithPage, render } from './common.ts';
import { FlashMessages } from '../../../../lib/pma/flash-messages.ts';
import { Message } from '../../../../lib/pma/message.ts';
import { sprintf } from '../../../../lib/pma/sprintf.ts';
import { nestedParams, phpArray, phpValues } from '../../../../lib/pma/table-data/php-params.ts';
import { backquote } from '../../../../lib/twig/sanitize.ts';
import { Context } from '../../../../sql-parser/index.ts';
import { Sql, SqlExit, parseAnalyze } from '../../display/sql.ts';
import { requestGoto } from '../sql/sql.ts';

import type { PmaContext } from '../../core/context.ts';

const list = (value: unknown): string[] => (Array.isArray(value) ? value : []);

function noColumnSelected(context: PmaContext): Promise<Response> {
	context.response.setRequestStatus(false);
	context.response.addJSON('message', 'No column selected.');
	return context.response.response();
}

/** DropColumnConfirmationController. */
export async function dropColumnConfirmationController(context: PmaContext): Promise<Response> {
	const selected = list(context.request.post.selected_fld);
	if (selected.length === 0) {
		return noColumnSelected(context);
	}
	const missing = await checkDbTableExists(context);
	if (missing !== null) {
		return missing;
	}
	context.response.addHTML(await render(context, 'table/structure/drop_confirm', { db: context.db, table: context.table, fields: selected }));
	return context.response.response();
}

/** DropColumnController: drops the columns, then redirects to the structure page with a flash message. */
export async function dropColumnController(context: PmaContext): Promise<Response> {
	const { dbi, response } = context;
	const flash = new FlashMessages(context.session.data);
	const selected = list(context.request.post.selected);
	if (selected.length === 0) {
		return noColumnSelected(context);
	}
	let message: Message | null = null;
	if (context.request.post.mult_btn === 'Yes') {
		const statement = `ALTER TABLE ${backquote(context.table)}${selected.map(field => ` DROP ${backquote(field)}`).join(',')};`;
		await dbi.selectDb(context.db);
		if (await dbi.tryQuery(statement) === false) {
			message = Message.error(dbi.getError());
		}
	} else {
		message = Message.success('No change');
	}
	if (message === null) {
		message = Message.success(selected.length === 1 ? '%1$d column has been dropped successfully.' : '%1$d columns have been dropped successfully.');
		message.addParam(selected.length);
	}
	flash.addMessage(message.isError() ? 'danger' : 'success', message.getMessage());
	redirectWithPage(context, '/table/structure', { db: context.db, table: context.table });
	return response.response();
}

/** Structure\BrowseController: browses the selected columns through the SQL result display. */
export async function browseController(context: PmaContext): Promise<Response> {
	const { response } = context;
	const selected = list(context.request.post.selected_fld);
	if (selected.length === 0) {
		return noColumnSelected(context);
	}
	const sqlQuery = `SELECT ${selected.map(field => backquote(field)).join(', ')} FROM ${backquote(context.db)}.${backquote(context.table)}`;
	const [analyzed, db] = parseAnalyze(context, sqlQuery, context.db);
	context.db = db;
	try {
		response.addHTML(await new Sql(context).executeQueryAndGetQueryResponse({
			analyzed,
			isGotoFile: false,
			db: context.db,
			table: context.table,
			findRealEnd: null,
			extraData: null,
			messageToShow: null,
			sqlData: null,
			goto: requestGoto(context),
			dispQuery: null,
			dispMessage: null,
			sqlQuery,
			completeQuery: null,
		}));
	} catch (error) {
		if (!(error instanceof SqlExit)) {
			throw error;
		}
	}
	return response.response();
}

/** Structure\ReservedWordCheckController: warns about column or table names that are MySQL reserved words. */
export async function reservedWordCheckController(context: PmaContext): Promise<Response> {
	const { config, dbi, response } = context;
	if (config.ReservedWordDisableWarning !== false) {
		response.setRequestStatus(false);
		return response.response();
	}
	await dbi.connect();
	// The keyword tables are global state, so they are loaded right before use.
	Context.loadClosest(`${dbi.isMariaDB() ? 'MariaDb' : 'MySql'}${dbi.getVersion()}`);
	const reserved: string[] = [];
	const names = phpArray(nestedParams(context.request.post).field_name) ?? {};
	const columns = phpValues(names).map(value => (typeof value === 'string' ? value : ''));
	for (const column of columns) {
		if (Context.isKeyword(column.trim(), true) !== null) {
			reserved.push(column.trim());
		}
	}
	if (Context.isKeyword(context.table.trim(), true) !== null) {
		reserved.push(context.table.trim());
	}
	if (reserved.length === 0) {
		response.setRequestStatus(false);
	}
	const text = reserved.length === 1 ? 'The name \'%s\' is a MySQL reserved keyword.' : 'The names \'%s\' are MySQL reserved keywords.';
	response.addJSON('message', sprintf(text, reserved.join(',')));
	return response.response();
}

export const controllers = {
	'Table/DropColumnConfirmationController': dropColumnConfirmationController,
	'Table/DropColumnController': dropColumnController,
	'Table/Structure/BrowseController': browseController,
	'Table/Structure/ReservedWordCheckController': reservedWordCheckController,
};

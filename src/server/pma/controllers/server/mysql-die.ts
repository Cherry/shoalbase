// Generator::mysqlDie() bound to the request: the error box replaces the page, or becomes the AJAX error message.
import { mysqlDieHtml } from '../../../../lib/pma/server/mysql-die.ts';
import { DbiQueryError } from '../../core/dbi.ts';
import { generatorState } from '../../core/generator.ts';

import type { PmaContext } from '../../core/context.ts';

/** Generator::mysqlDie($serverMessage, $sqlQuery, $isModifyLink, '', false): the error HTML only. */
export function mysqlDieMessage(context: PmaContext, serverMessage: string, sqlQuery: string, isModifyLink = true): string {
	return mysqlDieHtml({
		serverMessage,
		sqlQuery,
		isModifyLink,
		db: context.db,
		table: context.table,
		url: context.urlState(),
		state: generatorState(context),
	});
}

/** Generator::mysqlDie() with exit: nothing rendered before it is kept, as the controllers here fail before any output. */
export async function mysqlDie(context: PmaContext, serverMessage: string, sqlQuery: string): Promise<Response> {
	const { response } = context;
	const html = mysqlDieMessage(context, serverMessage, sqlQuery);
	if (response.isAjax) {
		response.setRequestStatus(false);
		response.addJSON('message', html);
		return response.response();
	}
	response.addHTML(html);
	return response.response();
}

/** Runs a controller body and turns DatabaseInterface::query() failures into the mysqlDie() page. */
export async function withMysqlDie(context: PmaContext, body: () => Promise<Response>): Promise<Response> {
	try {
		return await body();
	} catch (error) {
		if (!(error instanceof DbiQueryError)) {
			throw error;
		}
		return mysqlDie(context, error.formatted, error.query);
	}
}

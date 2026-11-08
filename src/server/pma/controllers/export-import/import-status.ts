// Ports of Controllers\Import\StatusController and SimulateDmlController.
import { render } from './common.ts';
import { UPLOAD_HANDLER } from './import-page.ts';
import { noCacheHeaders } from '../../../../lib/pma/ajax-response.ts';
import { unQuote } from '../../../../lib/pma/database/routines.ts';
import { Message } from '../../../../lib/pma/message.ts';
import { formatSql } from '../../../../lib/pma/table-structure/sql-format.ts';
import { backquote } from '../../../../lib/twig/sanitize.ts';
import { getFromRoute } from '../../../../lib/twig/url.ts';
import {
	DeleteStatement,
	Lexer,
	Parser,
	Query,
	Token,
	TokensList,
	UpdateStatement,
} from '../../../../sql-parser/index.ts';
import { signSqlQuery } from '../../core/sql-signature.ts';
import { loadParserContext } from '../../plugins/export/engine.ts';

import type { ImportMessage } from './import.ts';
import type { PmaContext } from '../../core/context.ts';
import type { Controller } from '../../dispatcher.ts';

/** UploadProgress::getIdKey(). */
const ID_KEY = 'UPLOAD_IDENTIFIER';

/** How long the status polls wait for an import result: prod's max_execution_time. */
const MAX_WAIT_SECONDS = 600;
const RETRY_MS = 250;

interface UploadStatus {
	id: string;
	finished: boolean;
	percent: number;
	total: number;
	complete: number;
	plugin: string;
}

/** What UploadProgress::getUploadStatus() keeps once an upload is done; ImportController records it for its upload id. */
export function finishedUpload(id: string): UploadStatus {
	return { id, finished: true, percent: 100, total: 0, complete: 0, plugin: ID_KEY };
}

function disabledResponse(context: PmaContext, contentType: string, body: string, extraHeaders: [string, string][] = []): Promise<Response> {
	const { response } = context;
	response.disable();
	for (const [name, value] of [...noCacheHeaders(new Date()), ['Content-Type', contentType], ...extraHeaders]) {
		response.header(name, value);
	}
	response.addHTML(body);
	return response.response();
}

/**
 * Ajax::status(). The upload has no progress to report here, and PHP's session lock made the poll wait for the import,
 * so until ImportController has stored its result the poll answers "uploaded, still processing" without touching the session.
 */
function uploadStatus(context: PmaContext): Promise<Response> {
	const id = typeof context.request.query.id === 'string' ? context.request.query.id : '';
	let status: UploadStatus | null = null;
	if (id.trim() !== '') {
		const stored = (context.session.data.__upload_status as Record<string, unknown> | undefined)?.[id] as UploadStatus | undefined;
		status = stored ?? finishedUpload(id);
		// The upload id is a uniqid(), so its first 8 hex digits say when the form was shown; old forms stop waiting.
		if (stored === undefined && (Date.now() / 1000) - Number.parseInt(id.slice(0, 8), 16) < MAX_WAIT_SECONDS) {
			status = { ...status, finished: false };
		}
	}
	return disabledResponse(context, 'application/json; charset=UTF-8', JSON.stringify(status), [['X-Content-Type-Options', 'nosniff']]);
}

/** The poll that loads the import's message into the page, retried in the browser while the result is not stored yet. */
async function statusMessage(context: PmaContext): Promise<Response> {
	const stored = context.session.data.Import_message as ImportMessage | undefined;
	let message = stored?.message ?? null;
	if (message === null) {
		// PHP waits in a loop for the message; this page only sees it once the import response has set the session cookie.
		const attempt = Math.trunc(Number(context.request.query.attempt)) || 0;
		if (attempt * RETRY_MS < MAX_WAIT_SECONDS * 1000) {
			const url = getFromRoute(context.urlState(), '/import-status', { message: 'true', import_status: 1, attempt: attempt + 1 });
			const retry = `<script>setTimeout(function () { $("#import_form_status").load(${JSON.stringify(url)}); }, ${RETRY_MS});</script>`;
			return disabledResponse(context, 'text/html;charset=utf-8', retry);
		}
		message = Message.error('Could not load the progress of the import.').getDisplay();
	}
	let body = message;
	if (stored?.go_back_url !== null && stored?.go_back_url !== undefined) {
		body += await render(context, 'import_status', { go_back_url: stored.go_back_url });
	}
	return disabledResponse(context, 'text/html;charset=utf-8', body);
}

const statusController: Controller = async (context) => {
	// Ajax::uploadProgressSetup() names the handler, which the import page already stored.
	const status = (context.session.data.__upload_status ?? {}) as Record<string, unknown>;
	status.handler = UPLOAD_HANDLER;
	context.session.data.__upload_status = status;
	const message = context.request.query.message;
	if (typeof message === 'string' && message !== '' && message !== '0') {
		return statusMessage(context);
	}
	return uploadStatus(context);
};

/** SimulateDml::getSimulatedUpdateQuery() / getSimulatedDeleteQuery(): a SELECT of the rows the statement would change. */
function simulatedQuery(parser: Parser, statement: DeleteStatement | UpdateStatement): string {
	const list = parser.list as TokensList;
	const table = Query.getTables(statement)[0];
	const condition = Query.getClause(statement, list, 'WHERE');
	const where = condition === '' ? '' : ` WHERE ${condition}`;
	const order = statement.order === null || statement.order.length === 0 ? '' : ` ORDER BY ${Query.getClause(statement, list, 'ORDER BY')}`;
	const limit = statement.limit === null ? '' : ` LIMIT ${Query.getClause(statement, list, 'LIMIT')}`;
	if (statement instanceof DeleteStatement) {
		return `SELECT * FROM ${table}${where}${order}${limit}`;
	}
	const values = new Map<string, string>();
	const newColumns: string[] = [];
	const oldColumns: string[] = [];
	for (const set of (statement.set ?? []).toReversed()) {
		const column = unQuote(set.column);
		if (values.has(column)) {
			continue;
		}
		oldColumns.push(backquote(column));
		const alias = backquote(`${column} \`new\``);
		newColumns.push(alias);
		values.set(column, `${set.value} AS ${alias}`);
	}
	return `SELECT * FROM (SELECT *, ${values.values().toArray().join(', ')} FROM ${table}${where}${order}${limit}) AS \`pma_tmp\``
		+ ` WHERE NOT (${oldColumns.join(', ')}) <=> (${newColumns.join(', ')})`;
}

const simulateDmlController: Controller = async (context) => {
	const { dbi, response, request } = context;
	const delimiter = typeof request.post.sql_delimiter === 'string' ? request.post.sql_delimiter : ';';
	loadParserContext(context);
	const lexer = new Lexer(response.globals.sqlQuery, false, delimiter);
	const parser = new Parser(new TokensList(lexer.list.tokens.filter(token => token.type !== Token.TYPE_COMMENT)));
	const data: Record<string, unknown>[] = [];
	let error = '';
	if (parser.errors.length > 0) {
		error = parser.errors[0].message;
	} else {
		for (const statement of parser.statements) {
			if ((!(statement instanceof UpdateStatement) && !(statement instanceof DeleteStatement)) || (statement.join?.length ?? 0) > 0 || Query.getTables(statement).length > 1) {
				error = 'Only single-table UPDATE and DELETE queries can be simulated.';
				break;
			}
			const query = simulatedQuery(parser, statement);
			await dbi.selectDb(context.db);
			const result = await dbi.tryQuery(query);
			const matched = result === false ? 0 : result.numRows();
			error = dbi.getError();
			if (error !== '') {
				break;
			}
			data.push({
				sql_query: formatSql(statement.build()),
				matched_rows: matched,
				matched_rows_url: getFromRoute(context.urlState(), '/sql', { db: context.db, sql_query: query, sql_signature: signSqlQuery(context.session, query) }),
			});
		}
	}
	if (error !== '') {
		response.addJSON('message', Message.rawError(error));
		response.addJSON('sql_data', false);
		return response.response();
	}
	response.addJSON('sql_data', data);
	return response.response();
};

export const controllers: Record<string, Controller> = {
	'Import/StatusController': statusController,
	'Import/SimulateDmlController': simulateDmlController,
};

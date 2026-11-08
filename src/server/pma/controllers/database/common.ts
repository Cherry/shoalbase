// Shared steps of the database controllers: AbstractController::hasDatabase(), Util::getDbInfo() and template rendering.
import { tableListSort } from '../../../../lib/pma/database/structure.ts';
import { isSystemSchema } from '../../../../lib/pma/dbi-sql.ts';
import { Message } from '../../../../lib/pma/message.ts';
import { phpEmpty, phpInt } from '../../../../lib/pma/server/php.ts';
import { twigVariables } from '../../../../lib/pma/server/twig-data.ts';
import { getScriptNameForOption } from '../../../../lib/pma/util.ts';
import { htmlspecialchars } from '../../../../lib/twig/php.ts';
import { sanitizeMessage } from '../../../../lib/twig/sanitize.ts';
import { getCommon } from '../../../../lib/twig/url.ts';
import { renderTemplate } from '../../../twig/render.ts';
import { generatorState, getDocumentationLink, showDocumentationLink } from '../../core/generator.ts';
import { requestGoto } from '../../display/sql.ts';

import type { PmaContext } from '../../core/context.ts';
import type { DbiRow } from '../../core/dbi.ts';

/** Renders a template with Maps turned into Twig arrays. */
export async function render(context: PmaContext, name: string, variables: Record<string, unknown>): Promise<string> {
	return renderTemplate(name, twigVariables(variables), await context.templateState());
}

/** A request value as a string, or '' when absent or an array. */
export function requestString(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	return '';
}

// What PHP sends for a disabled response: session_cache_limiter('private') headers and the default charset.
const DISABLED_RESPONSE_HEADERS: [string, string][] = [
	['Expires', 'Thu, 19 Nov 1981 08:52:00 GMT'],
	['Cache-Control', 'private, max-age=10800'],
	['Last-Modified', 'Tue, 07 Oct 2025 20:40:11 GMT'],
	['Content-Type', 'text/html; charset=utf-8'],
];

/** ResponseRenderer::disable() as seen on the wire: no phpMyAdmin headers, only PHP's session defaults and any header() the controller sent. */
export function disableResponse(context: PmaContext, sent: Record<string, string> = {}): void {
	context.response.disable();
	for (const [name, value] of DISABLED_RESPONSE_HEADERS) {
		context.response.header(name, sent[name] ?? value);
	}
}

/** ErrorHandler::handleException() for an uncaught PHP Error such as a TypeError: the bare fatal error page. */
export async function internalErrorPage(context: PmaContext, errorClass: string, sent: Record<string, string> = {}): Promise<Response> {
	disableResponse(context, sent);
	const box = `<div class="alert alert-danger" role="alert"><img src="themes/dot.gif" title="" alt="" class="icon ic_s_error"> ${errorClass}</div>`;
	context.response.addHTML(`<html><head><title>Internal error: ${errorClass}</title></head>\n${box}</body></html>`);
	return context.response.response();
}

/** Core::fatalError(): the JSON error for AJAX, else the generic error page inside the normal one. */
export async function fatalError(context: PmaContext, message: string): Promise<Response> {
	const { response } = context;
	if (response.isAjax) {
		response.setRequestStatus(false);
		response.addJSON('message', Message.error(message));
		return response.response();
	}
	const errorMessage = sanitizeMessage(generatorState(context), message);
	response.addHTML(await renderTemplate('error/generic', { lang: context.lang, dir: 'ltr', error_message: errorMessage }, await context.templateState()));
	return response.response();
}

/** Util::checkParameters($params, true): the fatal error page when a $_REQUEST parameter is missing, else null. */
export async function checkRequestParameters(context: PmaContext, params: string[]): Promise<Response | null> {
	const missing = params.filter(param => context.request.params[param] === undefined);
	if (missing.length === 0) {
		return null;
	}
	const state = generatorState(context);
	const link = showDocumentationLink(state, getDocumentationLink(state, 'faq', 'faqmissingparameters'), 'documentation', true);
	return fatalError(context, missing.map(param => `index.php: Missing parameter: ${param}${link}[br]`).join(''));
}

/**
 * AbstractController::redirect(): Core::sendHeaderLocation() only adds a Location header, so PHP still renders the
 * page into the 302 response, which this keeps.
 */
export function redirect(context: PmaContext, route: string, params: Record<string, unknown> = {}): void {
	context.response.header('Location', `/index.php?route=${route}${getCommon(context.urlState(), params, '&')}`);
}

/**
 * AbstractController::hasDatabase(): selects the database, else fails the AJAX request or redirects to the home page.
 * The caller returns context.response.response() when it gives false.
 */
export async function hasDatabase(context: PmaContext): Promise<boolean> {
	const { db, dbi, response } = context;
	let isDb = false;
	if (db !== '') {
		isDb = await dbi.selectDb(db);
		// Upstream accepts "Commands out of sync" (2014), which can follow a CALL, as a selected database.
		if (!isDb && dbi.getLastError()?.errno === 2014) {
			isDb = true;
		}
	}
	if (isDb) {
		return true;
	}
	if (response.isAjax) {
		response.setRequestStatus(false);
		response.addJSON('message', Message.error('No databases selected.'));
		return false;
	}
	redirect(context, '/', { reload: '1' });
	return false;
}

/** $GLOBALS['urlParams'] as Common::run() leaves it: goto, then the requested db and table, then the server. */
export function commonUrlParams(context: PmaContext): Record<string, unknown> {
	const { params } = context.request;
	const urlParams: Record<string, unknown> = {};
	const goto = requestGoto(context);
	if (goto !== '') {
		urlParams.goto = goto;
	}
	urlParams.db = typeof params.db === 'string' ? params.db : '';
	urlParams.table = typeof params.table === 'string' && urlParams.db !== '' ? params.table : '';
	urlParams.server = context.server;
	return urlParams;
}

/** Generator::getDbLink() for a named database. */
export function dbLink(context: PmaContext, database: string): string {
	const name = database.replaceAll(String.raw`\_`, '_').replaceAll(String.raw`\%`, '%');
	const scriptName = getScriptNameForOption(context.urlState(), context.config.DefaultTabDatabase, 'database');
	const href = scriptName + getCommon(context.urlState(), { db: name }, scriptName.includes('?') ? '&' : '?');
	return `<a href="${href}" title="${htmlspecialchars(`Jump to database “${name}”.`)}">${htmlspecialchars(name)}</a>`;
}

export interface DbInfo {
	tables: Map<string, DbiRow>;
	numTables: number;
	totalNumTables: number;
	isShowStats: boolean;
	isSystemSchema: boolean;
	position: number;
}

/** Util::getDbInfo() with SkipLockedTables off, as configured in production. */
export async function getDbInfo(context: PmaContext, subPart: string): Promise<DbInfo> {
	const { config, db, dbi, request } = context;
	const tmpval = context.session.tmpval;
	if (tmpval.table_limit_offset === undefined || tmpval.table_limit_offset_db !== db) {
		tmpval.table_limit_offset = 0;
		tmpval.table_limit_offset_db = db;
	}
	if (request.params.pos !== undefined) {
		tmpval.table_limit_offset = phpInt(request.params.pos);
	}
	const position = tmpval.table_limit_offset;
	let isShowStats = config.ShowStats;
	const systemSchema = isSystemSchema(db);
	if (systemSchema) {
		isShowStats = false;
	}
	const { sortBy, sortOrder } = tableListSort(request.params.sort, request.params.sort_order);

	let tables: Map<string, DbiRow>;
	let totalNumTables: number | undefined;
	const tableGroup = request.params.tbl_group;
	const tableType = request.params.tbl_type;
	if (!phpEmpty(tableGroup) || !phpEmpty(tableType)) {
		let type: string | null = null;
		if (!phpEmpty(tableType)) {
			type = String(tableType);
		}
		let groupTable = new Map<string, DbiRow>();
		let groupWithSeparator: string | false = false;
		if (!phpEmpty(tableGroup)) {
			groupTable = await dbi.getTablesFull(db, String(tableGroup), false, 0, false, sortBy, sortOrder, type);
			groupWithSeparator = String(tableGroup) + String(config.NavigationTreeTableSeparator);
		}
		const rest = await dbi.getTablesFull(db, groupWithSeparator === false ? '' : groupWithSeparator, groupWithSeparator !== false, 0, false, sortBy, sortOrder, type);
		// PHP's array union keeps the first occurrence of a key.
		tables = new Map([...groupTable, ...[...rest].filter(([name]) => !groupTable.has(name))]);
	} else {
		const names = await dbi.getTables(db);
		totalNumTables = names.length;
		let limitOffset = 0;
		let limitCount = false;
		if (subPart !== '_export') {
			limitOffset = position;
			limitCount = true;
		}
		tables = await dbi.getTablesFull(db, names, false, limitOffset, limitCount, sortBy, sortOrder, null);
	}
	const numTables = tables.size;
	return { tables, numTables, totalNumTables: totalNumTables ?? numTables, isShowStats, isSystemSchema: systemSchema, position };
}

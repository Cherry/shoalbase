// The JSON envelope of ResponseRenderer::ajaxResponse() and the headers Core::headerJSON() sends with it.
import type { CommonParams } from './header.ts';

export interface AjaxEnvelopeInput {
	/** ResponseRenderer::$JSON as the controller left it, in insertion order, with messages already rendered. */
	json: Record<string, unknown>;
	isSuccess: boolean;
	/** ResponseRenderer::getDisplay(), used when the controller set no "message". */
	display: string;
	/** Header::getPageTitle(), already escaped. */
	title: string;
	/** Menu::getDisplay(); null leaves the key out, as upstream does without a $dbi. */
	menu: string | null;
	scripts: { name: string; fire: 0 | 1; }[];
	/** Footer::getSelfUrl(). */
	selflink: string;
	/** Header::getMessage(). */
	displayMessage: string;
	/** Footer::getDebugMessage(), "'null'" unless $cfg['DBG']['sql'] is on. */
	debug: string;
	/** Whether the request carried a non-empty no_debug parameter. */
	noDebug: boolean;
	/** Footer::getErrorMessages(). */
	errors: string;
	promptPhpErrors: boolean;
	/** Whether $GLOBALS['error_message'] is set, which suppresses the query window and params keys. */
	hasErrorMessage: boolean;
	db: string;
	table: string;
	/** $GLOBALS['sql_query']. */
	sqlQuery: string;
	maxCharactersInDisplayedSQL: number;
	focusQuerywindow: boolean;
	/** $GLOBALS['reload']: asks the client to refresh the navigation tree. */
	reload: boolean;
	/** Header::getJsParams(). */
	params: CommonParams;
}

/** ResponseRenderer::ajaxResponse() for an enabled response, keeping PHP's key order. */
export function buildAjaxEnvelope(input: AjaxEnvelopeInput): Record<string, unknown> {
	const json: Record<string, unknown> = { ...input.json };
	if (json.message === undefined || json.message === null) {
		json.message = input.display;
	}
	if (!input.isSuccess) {
		json.success = false;
		json.error = json.message;
		delete json.message;
		return json;
	}
	json.success = true;
	if (json.title === undefined || json.title === null) {
		json.title = `<title>${input.title}</title>`;
	}
	if (input.menu !== null) {
		json.menu = input.menu;
	}
	json.scripts = input.scripts;
	json.selflink = input.selflink;
	json.displayMessage = input.displayMessage;
	if (!input.noDebug && input.debug !== '') {
		json.debug = input.debug;
	}
	if (input.errors !== '') {
		json.errors = input.errors;
	}
	json.promptPhpErrors = input.promptPhpErrors;
	if (input.hasErrorMessage) {
		return json;
	}
	let query = '';
	if ([...input.sqlQuery].length < input.maxCharactersInDisplayedSQL) {
		query = input.sqlQuery;
	}
	json.reloadQuerywindow = { db: input.db, table: input.table, sql_query: query };
	if (input.focusQuerywindow) {
		json._focusQuerywindow = query;
	}
	if (input.reload) {
		json.reloadNavigation = 1;
	}
	json.params = input.params;
	return json;
}

const httpStatusMessages: Record<number, string> = {
	200: 'OK',
	201: 'Created',
	204: 'No Content',
	301: 'Moved Permanently',
	302: 'Found',
	303: 'See Other',
	304: 'Not Modified',
	307: 'Temporary Redirect',
	400: 'Bad Request',
	401: 'Unauthorized',
	403: 'Forbidden',
	404: 'Not Found',
	405: 'Method Not Allowed',
	409: 'Conflict',
	413: 'Payload Too Large',
	429: 'Too Many Requests',
	500: 'Internal Server Error',
	501: 'Not Implemented',
	502: 'Bad Gateway',
	503: 'Service Unavailable',
};

/** The extra "status" header ResponseRenderer::setHttpResponseCode() sends under mod_php. */
export function statusHeader(code: number): [string, string] {
	return ['status', `${code} ${httpStatusMessages[code] ?? 'Web server is down'}`];
}

// DATE_RFC1123 as PHP's gmdate() formats it: a numeric "+0000" zone instead of "GMT".
function rfc1123(date: Date): string {
	return date.toUTCString().replace(/GMT$/, '+0000');
}

/** Core::getNoCacheHeaders(). */
export function noCacheHeaders(now: Date): [string, string][] {
	const date = rfc1123(now);
	return [
		['Expires', date],
		['Cache-Control', 'no-store, no-cache, must-revalidate, pre-check=0, post-check=0, max-age=0'],
		['Pragma', 'no-cache'],
		['Last-Modified', date],
	];
}

/** Core::headerJSON(). */
export function jsonHttpHeaders(now: Date): [string, string][] {
	return [
		...noCacheHeaders(now),
		['Content-Type', 'application/json; charset=UTF-8'],
		['X-Content-Type-Options', 'nosniff'],
	];
}

// Ports of PhpMyAdmin\Url and Core::linkURL() used by the Twig url(), get_common() and get_hidden_*() functions.
import { htmlspecialchars, httpBuildQuery, phpString } from './php.ts';

export interface UrlState {
	/** Index of the selected server; 0 when none is selected. */
	server: number;
	/** $cfg['ServerDefault']. */
	serverDefault: number;
	lang: string;
	/** Whether the pma_lang cookie is set; phpMyAdmin only adds lang= to URLs when it is not. */
	hasLangCookie: boolean;
	/** The session CSRF token, or an empty string when there is no session. */
	token: string;
}

type Params = Record<string, unknown>;

function addImplicitParams(params: Params, state: UrlState, overrideServer: boolean): Params {
	const result = { ...params };
	if (state.server && state.server !== state.serverDefault && (overrideServer || result.server === undefined)) {
		result.server = state.server;
	}
	if (!state.hasLangCookie && state.lang) {
		result.lang = state.lang;
	}
	return result;
}

/** Url::getCommonRaw() without URLQueryEncryption. */
export function getCommon(state: UrlState, params: Params = {}, divider = '?'): string {
	const query = httpBuildQuery(addImplicitParams(params, state, false));
	if ((divider !== '?' && divider !== '&') || query.length > 0) {
		return divider + query;
	}
	return '';
}

/** Url::getFromRoute(), the Twig url() function. */
export function getFromRoute(state: UrlState, route: string, params: Params = {}): string {
	return `index.php?route=${route}${getCommon(state, params, '&')}`;
}

/** Url::getHiddenFields(): the token is appended to every top-level call. */
export function getHiddenFields(state: UrlState, values: Params, prefix = '', isToken = false): string {
	const fields = { ...values };
	if (!isToken && state.token) {
		fields.token = state.token;
	}
	let html = '';
	for (const [key, value] of Object.entries(fields)) {
		const name = prefix ? `${prefix}[${key}]` : key;
		if (value !== null && typeof value === 'object') {
			html += getHiddenFields(state, value as Params, name, true);
		} else {
			html += `<input type="hidden" name="${htmlspecialchars(name)}" value="${htmlspecialchars(value)}">`;
		}
	}
	return html;
}

/** Url::getHiddenInputs(): `db` may be a parameter array instead of a database name. */
export function getHiddenInputs(state: UrlState, db: unknown = '', table: unknown = '', skip: string | string[] = []): string {
	let params: Params = {};
	if (db !== null && typeof db === 'object') {
		params = { ...db as Params };
	} else {
		if (phpString(db).length > 0) {
			params.db = db;
		}
		if (phpString(table).length > 0) {
			params.table = table;
		}
	}
	const fields = addImplicitParams(params, state, true);
	for (const name of Array.isArray(skip) ? skip : [skip]) {
		delete fields[name];
	}
	return getHiddenFields(state, fields);
}

/** Core::linkURL(): external links go through the url.php redirector. */
export function linkUrl(url: string, isSetup = false): string {
	if (!/^https?:\/\//.test(url)) {
		return url;
	}
	const query = httpBuildQuery({ url });
	if (isSetup) {
		return `../url.php?${query}`;
	}
	return `./url.php?${query}`;
}

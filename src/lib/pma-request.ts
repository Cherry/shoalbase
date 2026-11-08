import { tokensMatch } from '~/lib/auth';

export type RequestValue = string | string[];
export type RequestParams = Record<string, RequestValue>;

export interface PmaRequest {
	method: string;
	route: string;
	/** $_GET */
	query: RequestParams;
	/** $_POST, emptied (except ajax_request) when the CSRF token does not match, as Common::checkTokenRequestParam() does. */
	post: RequestParams;
	/** $_REQUEST: GET overlaid by POST, matching PHP's default request_order "GP". */
	params: RequestParams;
	isAjax: boolean;
	tokenMismatch: boolean;
}

/** Collects repeated keys (and PHP-style `name[]` keys) into arrays, the way PHP builds $_GET and $_POST. */
export const paramsFrom = (entries: Iterable<[string, unknown]>): RequestParams => {
	const params: RequestParams = {};
	for (const [rawKey, rawValue] of entries) {
		if (typeof rawValue !== 'string') {
			continue;
		}
		const isList = rawKey.endsWith('[]');
		const key = isList ? rawKey.slice(0, -2) : rawKey;
		const existing = params[key];
		if (isList) {
			params[key] = Array.isArray(existing) ? [...existing, rawValue] : [rawValue];
		} else {
			params[key] = rawValue;
		}
	}
	return params;
};

export const scalarParam = (params: RequestParams, key: string): string | undefined => {
	const value = params[key];
	if (typeof value === 'string') {
		return value;
	}
	return undefined;
};

/** Routing::getCurrentRoute(): GET wins over POST, and FAQ 1.34 short URLs (`?db=x[&table=y]`) open the database or table. */
export const currentRoute = (query: RequestParams, post: RequestParams): string => {
	let route = scalarParam(query, 'route') ?? scalarParam(post, 'route') ?? '/';
	if (route === '') {
		route = '/';
	}
	const database = scalarParam(query, 'db') ?? '';
	if (route === '/' && database !== '') {
		const table = scalarParam(query, 'table') ?? '';
		if (table === '') {
			return '/database/structure';
		}
		return '/sql';
	}
	return route;
};

/**
 * Builds phpMyAdmin's view of a request. A POST without the session token keeps only `ajax_request`,
 * so forged cross-site forms reach controllers as harmless GETs.
 */
export const buildPmaRequest = (method: string, query: RequestParams, rawPost: RequestParams, sessionToken: string | undefined): PmaRequest => {
	const isPost = method === 'POST';
	const tokenMismatch = !isPost || sessionToken === undefined || !tokensMatch(sessionToken, rawPost.token);
	let post = rawPost;
	if (isPost && tokenMismatch) {
		post = {};
		if (rawPost.ajax_request !== undefined) {
			post.ajax_request = rawPost.ajax_request;
		}
	}
	const params = { ...query, ...post };
	const route = currentRoute(query, post);
	const ajaxFlag = scalarParam(params, 'ajax_request');
	return { method, route, query, post, params, isAjax: ajaxFlag === 'true' || ajaxFlag === '1', tokenMismatch };
};

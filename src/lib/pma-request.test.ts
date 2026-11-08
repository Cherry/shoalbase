import { describe, expect, it } from 'vitest';

import {
	buildPmaRequest,
	currentRoute,
	paramsFrom,
	scalarParam,
} from '~/lib/pma-request';

const token = '0123456789abcdef0123456789abcdef';

describe('request parameters', () => {
	it('builds PHP-style arrays for name[] keys and keeps the last value for repeated scalars', () => {
		const params = paramsFrom([['selected_tbl[]', 'a'], ['selected_tbl[]', 'b'], ['db', 'x'], ['db', 'y'], ['file', {} as unknown]]);
		expect(params).toEqual({ selected_tbl: ['a', 'b'], db: 'y' });
		expect(scalarParam(params, 'db')).toBe('y');
		expect(scalarParam(params, 'selected_tbl')).toBeUndefined();
		expect(scalarParam(params, 'missing')).toBeUndefined();
	});
});

describe('phpMyAdmin request view', () => {
	it('reads the route from the query string and lets POST values override GET ones', () => {
		const request = buildPmaRequest('POST', { route: '/sql', db: 'a' }, { token, db: 'b', ajax_request: 'true' }, token);
		expect(request).toMatchObject({ route: '/sql', params: { route: '/sql', db: 'b' }, isAjax: true, tokenMismatch: false });
	});

	it('defaults to the home route and treats GETs as token mismatches, as upstream does', () => {
		expect(buildPmaRequest('GET', {}, {}, token)).toMatchObject({ route: '/', isAjax: false, tokenMismatch: true });
	});

	it('drops every POST parameter except ajax_request when the token is wrong or missing', () => {
		for (const [post, sessionToken] of [[{ token: 'forged', sql_query: 'DROP DATABASE x', ajax_request: '1' }, token], [{ sql_query: 'DROP DATABASE x', ajax_request: '1' }, token], [{ token, sql_query: 'DROP DATABASE x', ajax_request: '1' }, undefined]] as const) {
			const request = buildPmaRequest('POST', { route: '/sql' }, post, sessionToken);
			expect(request.tokenMismatch).toBe(true);
			expect(request.post).toEqual({ ajax_request: '1' });
			expect(request.params.sql_query).toBeUndefined();
			expect(request.isAjax).toBe(true);
		}
		expect(buildPmaRequest('POST', {}, { sql_query: 'x' }, token).post).toEqual({});
	});

	it('does not let a forged POST body choose a route', () => {
		expect(buildPmaRequest('POST', {}, { token: 'forged', route: '/logout' }, token).route).toBe('/');
	});

	it('resolves routes like Routing::getCurrentRoute()', () => {
		expect(currentRoute({ route: '/sql' }, { route: '/logout' })).toBe('/sql');
		expect(currentRoute({}, { route: '/logout' })).toBe('/logout');
		expect(currentRoute({ route: '' }, {})).toBe('/');
		expect(currentRoute({ db: 'shop' }, {})).toBe('/database/structure');
		expect(currentRoute({ db: 'shop', table: 'orders' }, {})).toBe('/sql');
		expect(currentRoute({ route: '/', db: 'shop', table: '' }, {})).toBe('/database/structure');
		expect(currentRoute({ route: '/server/status', db: 'shop' }, {})).toBe('/server/status');
		expect(currentRoute({}, { db: 'shop' })).toBe('/');
	});
});

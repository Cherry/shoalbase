import { describe, expect, it } from 'vitest';

import { createPmaContext } from './context.ts';
import { Message } from '../../../lib/pma/message.ts';
import { buildPmaRequest, paramsFrom } from '../../../lib/pma-request.ts';

import type { Connection } from 'mysql2/promise';

const TOKEN = '0123456789abcdef0123456789abcdef';

// Answers postConnect() and nothing else, which is all the page shell needs.
const connection = {
	query: async ({ sql }: { sql: string; }) => {
		if (sql.startsWith('SELECT @@version')) {
			return [[[Buffer.from('8.4.13'), Buffer.from('MySQL Community Server - GPL')]], [{ name: '@@version', characterSet: 45 }, { name: '@@version_comment', characterSet: 45 }]];
		}
		return [{ affectedRows: 0, warningStatus: 0 }, undefined];
	},
} as unknown as Connection;

function context(query: [string, string][]) {
	const request = buildPmaRequest('GET', paramsFrom(query), {}, TOKEN);
	return createPmaContext({
		request,
		url: new URL('http://127.0.0.1:8088/index.php'),
		auth: { user: 'customer', host: 'dbadmin-mysql', serverIndex: 1, token: TOKEN },
		connect: async () => connection,
		hasLangCookie: true,
	});
}

describe('ResponseRenderer', () => {
	it('wraps AJAX output in the upstream envelope', async () => {
		const { response } = context([['route', '/database/structure'], ['db', 'customer_db'], ['ajax_request', 'true']]);
		response.addHTML('<p>content</p>');
		const result = await response.response(new Date(Date.UTC(2026, 10, 6)));
		const body = await result.text();
		const json = JSON.parse(body) as Record<string, unknown>;

		expect(result.headers.get('Content-Type')).toBe('application/json; charset=UTF-8');
		expect(Object.keys(json)).toEqual(['message', 'success', 'title', 'menu', 'scripts', 'selflink', 'displayMessage', 'debug', 'promptPhpErrors', 'reloadQuerywindow', 'params']);
		expect(json.message).toBe('<p>content</p>');
		expect(json.title).toBe('<title>127.0.0.1:8088 / dbadmin-mysql / customer_db | phpMyAdmin 5.2.3</title>');
		expect(json.selflink).toBe('index.php?route=%2Fdatabase%2Fstructure&db=customer_db&server=1');
		expect(json.params).toMatchObject({ db: 'customer_db', token: TOKEN, logged_in: true, auth_type: 'cookie', user: 'customer' });
		// PHP's json_encode() escapes slashes.
		expect(body).toContain('"selflink":"index.php?route=%2Fdatabase%2Fstructure&db=customer_db&server=1"');
		expect(body).toContain(String.raw`<\/title>`);
	});

	it('turns a failed request into an error with the status header upstream sends', async () => {
		const { response } = context([['route', '/x'], ['ajax_request', '1']]);
		response.setRequestStatus(false);
		response.setHttpResponseCode(400);
		response.addJSON('message', Message.error('Bad'));
		const result = await response.response();

		expect(result.status).toBe(400);
		expect(result.headers.get('status')).toBe('400 Bad Request');
		expect(JSON.parse(await result.text())).toEqual({
			success: false,
			error: '<div class="alert alert-danger" role="alert">\n  <img src="themes/dot.gif" title="" alt="" class="icon ic_s_error"> Bad\n</div>\n',
		});
	});

	it('renders a full page with the shell headers for normal requests', async () => {
		const { response } = context([['route', '/']]);
		response.addHTML('<p id="body-marker"></p>');
		response.addScriptFiles(['home.js']);
		const result = await response.response();
		const page = await result.text();

		expect(result.headers.get('X-Frame-Options')).toBe('DENY');
		expect(page.startsWith('<!doctype html>')).toBe(true);
		expect(page).toContain('<p id="body-marker"></p>');
		expect(page).toContain('src="js/dist/home.js?v=5.2.3"');
		expect(page).toContain('<title>127.0.0.1:8088 / dbadmin-mysql | phpMyAdmin 5.2.3</title>');
	});

	it('sends only the controller output once disabled, even for AJAX', async () => {
		const { response } = context([['route', '/x'], ['ajax_request', 'true']]);
		response.disable();
		response.addHTML('raw');
		const result = await response.response();
		expect(await result.text()).toBe('raw');
		expect(result.headers.get('Content-Type')).toBe('text/html; charset=UTF-8');
	});

	it('redirects like AbstractController::redirect()', async () => {
		const { response } = context([['route', '/x']]);
		response.redirect('/database/structure', { db: 'customer_db' });
		const result = await response.response();
		expect(result.status).toBe(302);
		expect(result.headers.get('Location')).toBe('/index.php?route=/database/structure&db=customer_db');
	});

	it('turns a raw Location header into a 302 that still carries the page, as PHP does', async () => {
		const { response } = context([['route', '/themes/set']]);
		response.header('Location', 'index.php?route=/');
		const result = await response.response();
		expect(result.status).toBe(302);
		expect(result.headers.get('Location')).toBe('index.php?route=/');
		expect(await result.text()).toContain('<div id="page_content">');
	});

	it('shows the message request parameter through Header::getMessage() in AJAX responses', async () => {
		const { response } = context([['route', '/x'], ['ajax_request', 'true'], ['message', 'Saved [em]it[/em]']]);
		const result = await response.response();
		const json = JSON.parse(await result.text()) as Record<string, string>;
		expect(json.displayMessage).toContain('Saved <em>it</em>');
		expect(json.displayMessage).toContain('class="alert alert-primary"');
	});

	it('keeps the CommonParams code on the db the Header was built with, while later output follows the controller', async () => {
		const ctx = context([['route', '/'], ['db', 'customer_db']]);
		ctx.db = '';
		const result = await ctx.response.response();
		const page = await result.text();
		expect(page).toContain(',table:"",db:"customer_db",');
		expect(page).toContain('<title>127.0.0.1:8088 / dbadmin-mysql | phpMyAdmin 5.2.3</title>');
	});

	it('ignores invalid database and table parameters like Common::run()', () => {
		const ctx = context([['route', '/sql'], ['db', 'bad '], ['table', 'players']]);
		expect([ctx.db, ctx.table]).toEqual(['', '']);
	});
});

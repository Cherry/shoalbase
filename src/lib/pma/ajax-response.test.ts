import { describe, expect, it } from 'vitest';

import {
	type AjaxEnvelopeInput,
	buildAjaxEnvelope,
	jsonHttpHeaders,
	statusHeader,
} from './ajax-response.ts';

const input = (overrides: Partial<AjaxEnvelopeInput> = {}): AjaxEnvelopeInput => {
	return {
		json: {},
		isSuccess: true,
		display: '<div>page</div>',
		title: '127.0.0.1:8088 / dbadmin-mysql | phpMyAdmin 5.2.3',
		menu: '<nav></nav>',
		scripts: [{ name: 'ajax.js', fire: 0 }],
		selflink: 'index.php?route=%2F&server=1',
		displayMessage: '',
		debug: '\'null\'',
		noDebug: false,
		errors: '',
		promptPhpErrors: false,
		hasErrorMessage: false,
		db: '',
		table: '',
		sqlQuery: '',
		maxCharactersInDisplayedSQL: 1000,
		focusQuerywindow: false,
		reload: false,
		params: { server: 1 },
		...overrides,
	};
};

describe('buildAjaxEnvelope', () => {
	it('emits the keys of a normal page in the order the live server sends them', () => {
		const envelope = buildAjaxEnvelope(input());
		expect(Object.keys(envelope)).toEqual(['message', 'success', 'title', 'menu', 'scripts', 'selflink', 'displayMessage', 'debug', 'promptPhpErrors', 'reloadQuerywindow', 'params']);
		expect(envelope).toMatchObject({
			message: '<div>page</div>',
			success: true,
			title: '<title>127.0.0.1:8088 / dbadmin-mysql | phpMyAdmin 5.2.3</title>',
			debug: '\'null\'',
			reloadQuerywindow: { db: '', table: '', sql_query: '' },
		});
	});

	it('keeps controller keys first and their own message and title', () => {
		const envelope = buildAjaxEnvelope(input({ json: { sql_query: 'x', message: '<b>done</b>', title: 'custom' } }));
		expect(Object.keys(envelope).slice(0, 4)).toEqual(['sql_query', 'message', 'title', 'success']);
		expect(envelope.message).toBe('<b>done</b>');
		expect(envelope.title).toBe('custom');
	});

	it('turns the message into the error of a failed request and stops there', () => {
		expect(buildAjaxEnvelope(input({ isSuccess: false, json: { message: 'bad', extra: 1 } }))).toEqual({ extra: 1, success: false, error: 'bad' });
		expect(buildAjaxEnvelope(input({ isSuccess: false, json: { message: null } }))).toEqual({ success: false, error: '<div>page</div>' });
	});

	it('adds the optional keys only when upstream would', () => {
		const envelope = buildAjaxEnvelope(input({
			menu: null,
			noDebug: true,
			errors: '<div>php error</div>',
			db: 'customer_db',
			table: 'players',
			sqlQuery: 'SELECT 1',
			focusQuerywindow: true,
			reload: true,
		}));
		expect(envelope).not.toHaveProperty('menu');
		expect(envelope).not.toHaveProperty('debug');
		expect(envelope).toMatchObject({
			errors: '<div>php error</div>',
			reloadQuerywindow: { db: 'customer_db', table: 'players', sql_query: 'SELECT 1' },
			_focusQuerywindow: 'SELECT 1',
			reloadNavigation: 1,
		});
	});

	it('leaves out queries that are too long to display', () => {
		const envelope = buildAjaxEnvelope(input({ sqlQuery: 'SELECT 1', maxCharactersInDisplayedSQL: 8 }));
		expect(envelope.reloadQuerywindow).toEqual({ db: '', table: '', sql_query: '' });
	});

	it('skips the query window and params when an error message is pending', () => {
		const envelope = buildAjaxEnvelope(input({ hasErrorMessage: true }));
		expect(Object.keys(envelope).at(-1)).toBe('promptPhpErrors');
	});
});

describe('statusHeader', () => {
	it('names the status like upstream and falls back to its odd default', () => {
		expect(statusHeader(404)).toEqual(['status', '404 Not Found']);
		expect(statusHeader(599)).toEqual(['status', '599 Web server is down']);
	});
});

describe('jsonHttpHeaders', () => {
	it('sends no-cache headers with PHP dates, then the JSON type', () => {
		expect(jsonHttpHeaders(new Date(Date.UTC(2026, 10, 6, 22, 45, 19)))).toEqual([
			['Expires', 'Fri, 06 Nov 2026 22:45:19 +0000'],
			['Cache-Control', 'no-store, no-cache, must-revalidate, pre-check=0, post-check=0, max-age=0'],
			['Pragma', 'no-cache'],
			['Last-Modified', 'Fri, 06 Nov 2026 22:45:19 +0000'],
			['Content-Type', 'application/json; charset=UTF-8'],
			['X-Content-Type-Options', 'nosniff'],
		]);
	});
});

import { describe, expect, it } from 'vitest';

import {
	type UrlState,
	getCommon,
	getFromRoute,
	getHiddenFields,
	getHiddenInputs,
	linkUrl,
} from './url';

// The login page is served before the pma_lang cookie exists; the home page after it.
const loginPage: UrlState = { server: 1, serverDefault: 1, lang: 'en', hasLangCookie: false, token: '726361345d54512a664a324d32566548' };
const homePage: UrlState = { ...loginPage, hasLangCookie: true, token: '304b74753071683670656e7632287b46' };

describe('getHiddenInputs', () => {
	it('matches the login form fields phpMyAdmin 5.2.3 renders', () => {
		expect(getHiddenInputs(loginPage, {}, '', 'server'))
			.toBe('<input type="hidden" name="lang" value="en"><input type="hidden" name="token" value="726361345d54512a664a324d32566548">');
	});

	it('matches the home page language form, which keeps empty db/table', () => {
		expect(getHiddenInputs(homePage, { db: '', table: '' }))
			.toBe('<input type="hidden" name="db" value=""><input type="hidden" name="table" value=""><input type="hidden" name="token" value="304b74753071683670656e7632287b46">');
	});

	it('accepts db and table names and adds a non-default server', () => {
		expect(getHiddenInputs({ ...homePage, server: 2, token: '' }, 'my"db', 'tbl'))
			.toBe('<input type="hidden" name="db" value="my&quot;db"><input type="hidden" name="table" value="tbl"><input type="hidden" name="server" value="2">');
		expect(getHiddenInputs({ ...homePage, token: '' }, null, null)).toBe('');
		expect(getHiddenInputs(homePage, { db: 'x', table: 't' }, '', ['db', 'table'])).toBe('<input type="hidden" name="token" value="304b74753071683670656e7632287b46">');
	});
});

describe('getHiddenFields', () => {
	it('nests arrays as name[key] without repeating the token', () => {
		expect(getHiddenFields(homePage, { opts: { a: 1, b: [2] } }))
			.toBe('<input type="hidden" name="opts[a]" value="1"><input type="hidden" name="opts[b][0]" value="2"><input type="hidden" name="token" value="304b74753071683670656e7632287b46">');
		expect(getHiddenFields(homePage, { x: 1 }, 'p', true)).toBe('<input type="hidden" name="p[x]" value="1">');
	});
});

describe('getFromRoute and getCommon', () => {
	it('matches URLs from the live pages', () => {
		expect(getFromRoute(loginPage, '/')).toBe('index.php?route=/&lang=en');
		expect(getFromRoute(homePage, '/user-password')).toBe('index.php?route=/user-password');
	});

	it('keeps an explicit server and adds a non-default one', () => {
		const state = { ...homePage, server: 3 };
		expect(getFromRoute(state, '/sql', { db: 'a b' })).toBe('index.php?route=/sql&db=a+b&server=3');
		expect(getCommon(state, { server: 1 })).toBe('?server=1');
	});

	it('returns an empty string for "?" with no parameters but keeps other dividers', () => {
		expect(getCommon(homePage)).toBe('');
		expect(getCommon(homePage, {}, '&')).toBe('');
		expect(getCommon(homePage, {}, '#')).toBe('#');
		expect(getCommon({ ...homePage, server: 0 }, { a: 1 })).toBe('?a=1');
	});
});

describe('linkUrl', () => {
	it('routes external links through url.php like Core::linkURL()', () => {
		expect(linkUrl('https://www.phpmyadmin.net/')).toBe('./url.php?url=https%3A%2F%2Fwww.phpmyadmin.net%2F');
		expect(linkUrl('https://example.com/a b', true)).toBe('../url.php?url=https%3A%2F%2Fexample.com%2Fa+b');
		expect(linkUrl('index.php?route=/')).toBe('index.php?route=/');
	});
});

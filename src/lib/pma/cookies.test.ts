import { describe, expect, it } from 'vitest';

import { phpCookieName, removeCookieHeader, setCookieHeader } from './cookies.ts';

const NOW = new Date(Date.UTC(2026, 10, 6, 23, 53, 41, 500));

describe('phpCookieName', () => {
	it('decorates cookie names on HTTPS like Config::getCookieName()', () => {
		expect(phpCookieName('pma_theme', false)).toBe('pma_theme');
		expect(phpCookieName('pma_theme', true)).toBe('__Secure-pma_theme_https');
	});
});

describe('setCookieHeader', () => {
	it('matches the cookie the oracle sends after choosing a theme', () => {
		expect(setCookieHeader('pma_theme', 'metro', { isHttps: false, now: NOW })).toBe('pma_theme=metro; expires=Sun, 06 Dec 2026 23:53:41 GMT; Max-Age=2592000; path=/; HttpOnly; SameSite=Strict');
	});

	it('url-encodes values like urlencode() and supports session, secure and non-HttpOnly cookies', () => {
		expect(setCookieHeader('x', 'a b~', { isHttps: true, now: NOW, validity: 0, httpOnly: false, sameSite: 'Lax' })).toBe('x=a+b%7E; path=/; secure; SameSite=Lax');
	});
});

describe('removeCookieHeader', () => {
	it('expires the cookie the way setcookie() does for an empty value', () => {
		expect(removeCookieHeader('pma_theme', false)).toBe('pma_theme=deleted; expires=Thu, 01 Jan 1970 00:00:01 GMT; Max-Age=0; path=/');
		expect(removeCookieHeader('__Secure-pma_theme_https', true)).toBe('__Secure-pma_theme_https=deleted; expires=Thu, 01 Jan 1970 00:00:01 GMT; Max-Age=0; path=/; secure');
	});
});

import { describe, expect, it } from 'vitest';

import { isAllowedDomain, isRedirectAllowed } from './url-redirector.ts';

describe('isAllowedDomain', () => {
	it('accepts listed hosts and the current server name only', () => {
		expect(isAllowedDomain('https://www.phpmyadmin.net/x', 'pma.local')).toBe(true);
		expect(isAllowedDomain('https://pma.local/?a', 'pma.local')).toBe(true);
		expect(isAllowedDomain('https://evil.example/', 'pma.local')).toBe(false);
		expect(isAllowedDomain('https:///path', 'pma.local')).toBe(false);
		expect(isAllowedDomain('github.com', 'github.com')).toBe(false);
	});

	it('refuses user information and ports like parse_url() reports them', () => {
		expect(isAllowedDomain('https://user@github.com/', 'h')).toBe(false);
		expect(isAllowedDomain('https://:pass@github.com/', 'h')).toBe(false);
		expect(isAllowedDomain('https://:@github.com/', 'h')).toBe(true);
		expect(isAllowedDomain('https://github.com:443/', 'h')).toBe(false);
		expect(isAllowedDomain('https://github.com:/', 'h')).toBe(true);
	});
});

describe('isRedirectAllowed', () => {
	it('only forwards https URLs without line breaks', () => {
		expect(isRedirectAllowed(undefined, 'h')).toBe(false);
		expect(isRedirectAllowed('', 'h')).toBe(false);
		expect(isRedirectAllowed('ftp://github.com/', 'h')).toBe(false);
		expect(isRedirectAllowed('https://github.com/a\nb', 'h')).toBe(false);
		expect(isRedirectAllowed('https://github.com/a\n', 'h')).toBe(true);
		expect(isRedirectAllowed('https://dev.mysql.com/doc/', 'h')).toBe(true);
	});
});

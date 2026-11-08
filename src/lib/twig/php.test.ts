import { describe, expect, it } from 'vitest';

import {
	htmlspecialchars,
	httpBuildQuery,
	phpConcat,
	phpString,
	phpTrim,
	urlencode,
} from './php';

describe('phpString', () => {
	it('casts scalars like PHP (string)', () => {
		expect(phpString(null)).toBe('');
		expect(phpString(undefined)).toBe('');
		expect(phpString(false)).toBe('');
		expect(phpString(true)).toBe('1');
		expect(phpString('x')).toBe('x');
		expect(phpString(42)).toBe('42');
		expect(phpString(-7)).toBe('-7');
	});

	it('formats floats with PHP precision 14', () => {
		expect(phpString(0.1 + 0.2)).toBe('0.3');
		expect(phpString(1.5)).toBe('1.5');
		expect(phpString(0.0001)).toBe('0.0001');
		expect(phpString(-2.25)).toBe('-2.25');
	});

	it('uses PHP scientific notation outside the fixed range', () => {
		expect(phpString(0.00001)).toBe('1.0E-5');
		expect(phpString(1.5e-7)).toBe('1.5E-7');
		expect(phpString(1e20)).toBe('1.0E+20');
		expect(phpString(-1.25e21)).toBe('-1.25E+21');
	});

	it('spells out non-finite floats like PHP', () => {
		expect(phpString(NaN)).toBe('NAN');
		expect(phpString(Infinity)).toBe('INF');
		expect(phpString(-Infinity)).toBe('-INF');
	});
});

describe('phpTrim', () => {
	it('strips only the characters PHP trim() strips', () => {
		expect(phpTrim('\n\t  Log in \r\0\v')).toBe('Log in');
		const nbsp = String.fromCodePoint(0xA0);
		expect(phpTrim(`${nbsp}x${nbsp}`)).toBe(`${nbsp}x${nbsp}`);
	});
});

describe('htmlspecialchars', () => {
	it('escapes quotes like ENT_QUOTES', () => {
		expect(htmlspecialchars('<a href="x">it\'s & co</a>')).toBe('&lt;a href=&quot;x&quot;&gt;it&#039;s &amp; co&lt;/a&gt;');
		expect(htmlspecialchars(null)).toBe('');
	});
});

describe('urlencode', () => {
	it('matches PHP urlencode for the docs links phpMyAdmin builds', () => {
		expect(urlencode('https://www.phpmyadmin.net/')).toBe('https%3A%2F%2Fwww.phpmyadmin.net%2F');
		expect(urlencode('a b!*\'()~')).toBe('a+b%21%2A%27%28%29%7E');
	});
});

describe('httpBuildQuery', () => {
	it('builds queries like PHP http_build_query', () => {
		expect(httpBuildQuery({ db: 'my db', server: 2, ok: true, no: false, skip: null })).toBe('db=my+db&server=2&ok=1&no=0');
		expect(httpBuildQuery({ a: { b: 'c', d: ['e'] } }, '&amp;')).toBe('a%5Bb%5D=c&amp;a%5Bd%5D%5B0%5D=e');
		expect(httpBuildQuery({ empty: {}, x: 1 })).toBe('x=1');
	});
});

describe('phpConcat', () => {
	it('concatenates with PHP casts', () => {
		expect(phpConcat(true, false)).toBe('1');
		expect(phpConcat(null, 0.5)).toBe('0.5');
	});
});

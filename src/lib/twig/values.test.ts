import { describe, expect, it } from 'vitest';

import { fromTwigValue, toTwigContext, toTwigValue } from './values';

describe('Twig value conversion', () => {
	it('turns PHP-array-shaped objects into Maps recursively', () => {
		const value = toTwigValue({ a: { b: [1, { c: 2 }] } });
		expect(value).toEqual(new Map([['a', new Map<string, unknown>([['b', [1, new Map([['c', 2]])]]])]]));
	});

	it('keeps objects with methods, class instances and scalars as they are', () => {
		const language = { getCode: () => 'en' };
		const date = new Date(0);
		expect(toTwigValue(language)).toBe(language);
		expect(toTwigValue(date)).toBe(date);
		expect(toTwigValue('x')).toBe('x');
		expect(toTwigValue(null)).toBeNull();
	});

	it('keeps the top-level context a plain object', () => {
		expect(toTwigContext({ form: { db: 'x' }, n: 1 })).toEqual({ form: new Map([['db', 'x']]), n: 1 });
	});

	it('turns Maps back into plain objects for helpers', () => {
		expect(fromTwigValue(new Map<unknown, unknown>([['a', [new Map([[0, 'x']])]]]))).toEqual({ a: [{ 0: 'x' }] });
		expect(fromTwigValue('x')).toBe('x');
	});
});

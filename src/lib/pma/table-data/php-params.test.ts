import { describe, expect, it } from 'vitest';

import {
	type PhpArray,
	isValidGoto,
	nestedParams,
	phpArray,
	phpEmpty,
	phpEntries,
	phpGet,
	phpJsonValue,
	phpKeys,
	phpScalar,
	phpToTwig,
	phpValues,
} from './php-params.ts';

describe('nestedParams', () => {
	it('builds nested arrays from bracketed names and appends list values', () => {
		const params = nestedParams({
			'db': 'customer_db',
			'fields[multi_edit][0][abc]': 'x',
			'fields[multi_edit][0][set]': ['a', 'b'],
			'where_clause': ['first', 'second'],
		});
		expect(phpGet(params, 'fields', 'multi_edit', 0, 'abc')).toBe('x');
		expect(phpValues(phpGet(params, 'fields', 'multi_edit', '0', 'set') as PhpArray)).toEqual(['a', 'b']);
		expect(phpKeys(params.where_clause as PhpArray)).toEqual(['0', '1']);
		expect(params.db).toBe('customer_db');
	});

	it('keeps the posted order of integer keys, which plain objects would sort', () => {
		const params = nestedParams({ 'ops[0]': 'a', 'ops[8]': 'b', 'ops[2]': 'c' });
		expect(phpEntries(params.ops as PhpArray)).toEqual([['0', 'a'], ['8', 'b'], ['2', 'c']]);
	});

	it('numbers [] after the highest integer key and replaces a scalar by an array', () => {
		const params = nestedParams({ 'a[5]': 'x', 'a': ['y'], 'b': 'scalar', 'b[k]': 'z' });
		expect(phpEntries(params.a as PhpArray)).toEqual([['5', 'x'], ['6', 'y']]);
		expect(phpGet(params, 'b', 'k')).toBe('z');
	});

	it('lists keys added in code after the posted ones and skips deleted ones', () => {
		const array = nestedParams({ 'x[b]': '1', 'x[a]': '2' }).x as Record<string, string>;
		array.c = '3';
		delete array.b;
		expect(phpKeys(array as never)).toEqual(['a', 'c']);
	});
});

describe('accessors', () => {
	it('reads values like PHP array access', () => {
		const params = nestedParams({ 'a[b]': 'c' });
		expect(phpGet(params, 'a', 'b', 'c')).toBeUndefined();
		expect(phpGet(params, 'missing', 'b')).toBeUndefined();
		expect(phpArray('text')).toBeUndefined();
		expect(phpScalar(params.a)).toBeUndefined();
		expect(phpScalar('v')).toBe('v');
	});

	it('mirrors empty()', () => {
		expect(phpEmpty(undefined)).toBe(true);
		expect(phpEmpty(null)).toBe(true);
		expect(phpEmpty('0')).toBe(true);
		expect(phpEmpty('')).toBe(true);
		expect(phpEmpty('a')).toBe(false);
		expect(phpEmpty({})).toBe(true);
		expect(phpEmpty({ a: 'b' })).toBe(false);
	});

	it('encodes 0..n-1 keyed arrays as JSON lists and others as objects, like json_encode()', () => {
		expect(phpJsonValue([['0', 'a'], ['1', 'b']])).toEqual(['a', 'b']);
		expect(phpJsonValue([['0', 'a'], ['2', 'b']])).toEqual({ 0: 'a', 2: 'b' });
		expect(phpJsonValue([['1', 'a']])).toEqual({ 1: 'a' });
	});

	it('hands sequential arrays to templates as lists and others as maps with numeric keys', () => {
		expect(phpToTwig('x')).toBe('x');
		expect(phpToTwig(nestedParams({ a: ['x', 'y'] }).a)).toEqual(['x', 'y']);
		expect(phpToTwig(nestedParams({ 'a[2]': 'x', 'a[k]': 'y' }).a)).toEqual(new Map<number | string, unknown>([[2, 'x'], ['k', 'y']]));
	});
});

describe('isValidGoto', () => {
	it('accepts index.php targets, also urlencoded ones, like Core::checkPageValidity()', () => {
		expect(isValidGoto('index.php')).toBe(true);
		expect(isValidGoto('index.php?route=/sql')).toBe(true);
		expect(isValidGoto('index.php%3Froute%3D%2Fsql')).toBe(true);
		expect(isValidGoto('index.php%3F%ZZ')).toBe(true);
	});

	it('rejects other pages, empty values and arrays', () => {
		expect(isValidGoto('export.php?x=1')).toBe(false);
		expect(isValidGoto('index%2Ephp+x')).toBe(false);
		expect(isValidGoto('')).toBe(false);
		expect(isValidGoto('0')).toBe(false);
		expect(isValidGoto(['index.php'])).toBe(false);
	});
});

import { describe, expect, it } from 'vitest';

import {
	isNumericString,
	phpCompareStrings,
	strcasecmp,
	strcmp,
	strnatcasecmp,
	strnatcmp,
} from './php-compare.ts';

// Expected values were produced by PHP 8.3 in the oracle container: [a, b, strnatcmp, strnatcasecmp, strcmp, strcasecmp, a <=> b].
const phpResults: [string, string, number, number, number, number, number][] = [
	['img12', 'img10', 1, 1, 1, 1, 1],
	['img2', 'img10', -1, -1, 1, 1, 1],
	['IMG2', 'img10', -1, -1, -1, 1, -1],
	['a', 'A', 1, 0, 1, 0, 1],
	['', 'a', -1, -1, -1, -1, -1],
	['', '', 0, 0, 0, 0, 0],
	['x01', 'x1', -1, -1, -1, -1, -1],
	['x001', 'x01', -1, -1, -1, -1, -1],
	['0.15', '0.9', 1, 1, -1, -1, -1],
	['  a', 'a', 0, 0, -1, -1, -1],
	['a  b', 'a b', 0, 0, -1, -1, -1],
	['abc', 'ab', 1, 1, 1, 1, 1],
	['ab', 'abc', -1, -1, -1, -1, -1],
	['10', '9', 1, 1, -1, -1, 1],
	['010', '9', 1, 1, -1, -1, 1],
	['Ä', 'a', 1, 1, 1, 1, 1],
	['é', 'f', 1, 1, 1, 1, 1],
	['a1b', 'a01b', 1, 1, 1, 1, 1],
	['1.10', '1.9', 1, 1, -1, -1, -1],
	['db_2', 'db_10', -1, -1, 1, 1, 1],
	['test', 'Test', 1, 0, 1, 0, 1],
	['123abc', '123', 1, 1, 1, 1, 1],
	['007', '7', 0, 0, -1, -1, 0],
	['a 1', 'a1', 0, 0, -1, -1, -1],
];

describe('PHP string comparisons', () => {
	it.each(phpResults)('compares %j with %j like PHP', (left, right, natural, naturalCase, binary, binaryCase, spaceship) => {
		expect(strnatcmp(left, right)).toBe(natural);
		expect(strnatcasecmp(left, right)).toBe(naturalCase);
		expect(strcmp(left, right)).toBe(binary);
		expect(strcasecmp(left, right)).toBe(binaryCase);
		expect(phpCompareStrings(left, right)).toBe(spaceship);
	});

	it('compares runs with a leading zero digit by digit, so a shorter run sorts first', () => {
		expect(strnatcmp('a05', 'a051')).toBe(-1);
		expect(strnatcmp('a051', 'a05')).toBe(1);
		expect(strnatcmp('a05x', 'a051')).toBe(-1);
	});

	it('treats trailing whitespace as the end of the string', () => {
		expect(strnatcmp('a  ', 'a  b')).toBe(-1);
	});

	it('orders a database list like usort($list, "strnatcasecmp")', () => {
		const list = ['b', '10', '9', 'information_schema', 'A', 'customer_db', '2x', '100'];
		expect(list.toSorted(strnatcasecmp)).toEqual(['2x', '9', '10', '100', 'A', 'b', 'customer_db', 'information_schema']);
	});

	it('recognises PHP 8 numeric strings', () => {
		expect(['1', ' 1', '1 ', '-1.5', '+.5', '1e3', '2.', '\t7\n'].every(value => isNumericString(value))).toBe(true);
		expect(['', ' ', '1x', 'e3', '.', '0x1A', '1 2'].some(value => isNumericString(value))).toBe(false);
	});
});

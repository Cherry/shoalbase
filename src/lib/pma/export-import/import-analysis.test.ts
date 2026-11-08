import { describe, expect, it } from 'vitest';

import {
	BIGINT,
	type ColumnType,
	DECIMAL,
	GEOMETRY,
	INT,
	NONE,
	VARCHAR,
	analyzeTable,
	createTableSql,
	detectSize,
	detectType,
	getColumnAlphaName,
	getColumnNumberFromName,
	getDecimalPrecision,
	getDecimalScale,
	insertSql,
	phpFloatString,
	phpFloatval,
	phpIntval,
} from './import-analysis.ts';

const backquote = (name: string): string => `\`${name}\``;
const escape = (value: string): string => value.replaceAll('\'', String.raw`\'`);

// Expectations below were produced by PhpMyAdmin\Import in the 5.2.3 oracle container.
describe('detectType', () => {
	it.each([
		['NULL', NONE],
		['abc', VARCHAR],
		['1.5', DECIMAL],
		['0.10', DECIMAL],
		['1e400', VARCHAR],
		['1.5e3', DECIMAL],
		['007', VARCHAR],
		[' 5', VARCHAR],
		['+5', VARCHAR],
		['-0', VARCHAR],
		['2147483647', INT],
		['2147483648', BIGINT],
		['-2147483648', BIGINT],
		['99999999999999999999', BIGINT],
		['1.', DECIMAL],
		['1e3', VARCHAR],
		['1.2.3', VARCHAR],
		['', VARCHAR],
	])('classifies %j like PHP', (cell, type) => {
		expect(detectType(null, cell)).toBe(type);
	});

	it('keeps the column type for NULL and treats a missing cell as text', () => {
		expect(detectType(INT, 'NULL')).toBe(INT);
		expect(detectType(null, null)).toBe(VARCHAR);
	});
});

describe('detectSize', () => {
	it.each([
		[0, null, VARCHAR, 'abc', 3],
		[3, VARCHAR, VARCHAR, 'ab', 3],
		['5,2', DECIMAL, VARCHAR, 'abcdefg', 7],
		['5,2', DECIMAL, VARCHAR, 'ab', 5],
		[4, INT, VARCHAR, 'abcdef', 6],
		[0, null, DECIMAL, '12.345', '5,3'],
		[4, VARCHAR, DECIMAL, '12.345', 5],
		[9, VARCHAR, DECIMAL, '1.5', 9],
		['5,2', DECIMAL, DECIMAL, '123.4567', '7,4'],
		['5,2', DECIMAL, DECIMAL, '1.5', '5,2'],
		[2, INT, DECIMAL, '123.45', '5,2'],
		[8, INT, DECIMAL, '1.5', '8,1'],
		[0, null, INT, '123', 3],
		[3, VARCHAR, INT, '12345', 5],
		[5, VARCHAR, INT, '1', 5],
		['5,2', DECIMAL, INT, '12', '5,2'],
		['5,2', DECIMAL, INT, '12345', '7,2'],
		[2, INT, BIGINT, '12345678901', 11],
		['3', VARCHAR, INT, 'NULL', '3'],
		[0, GEOMETRY, VARCHAR, 'x', -1],
		[0, GEOMETRY, DECIMAL, '1.5', -1],
		[0, GEOMETRY, INT, '1', -1],
		[0, VARCHAR, GEOMETRY, 'x', -1],
	] as const)('sizes %j after type %j with a %j cell %j like PHP', (last, lastType, type, cell, expected) => {
		expect(detectSize(last, lastType, type, cell)).toBe(expected);
	});
});

describe('decimal sizes', () => {
	it('reads M and D like PHP, which starts the scale at offset 1 when there is no comma', () => {
		expect([getDecimalPrecision('5,2'), getDecimalScale('5,2')]).toEqual([5, 2]);
		expect([getDecimalPrecision('10'), getDecimalScale('10'), getDecimalScale('125'), getDecimalScale('5,')]).toEqual([0, 0, 25, 0]);
	});

	it('compares a text length with a stored size loosely', () => {
		expect(detectSize('10', VARCHAR, VARCHAR, 'abc')).toBe('10');
	});
});

describe('analyzeTable', () => {
	it('picks the widest type per column and turns all-NULL columns into varchar(10)', () => {
		const table = {
			name: 't',
			columns: ['a', 'b', 'c', 'd', 'e'],
			rows: [['1', 'x', '1.5', 'NULL', '2147483648'], ['22', 'yy', '10.25', 'NULL', '5'], ['3', '1', '3', 'NULL', '1.5'], [null, 'NULL', '', 'NULL', '7']],
		};
		expect(analyzeTable(table)).toEqual({ types: [VARCHAR, VARCHAR, VARCHAR, VARCHAR, DECIMAL], sizes: [2, 2, 4, '10', '10,1'] });
	});
});

describe('spreadsheet column names', () => {
	it.each([[1, 'A'], [26, 'Z'], [27, 'AA'], [52, 'AZ'], [53, 'BA'], [702, 'ZZ'], [703, 'AAA']])('names column %d %s', (number, name) => {
		expect(getColumnAlphaName(number)).toBe(name);
	});

	it.each([['A', 1], ['Z', 26], ['AA', 27], ['az', 52], ['ZZ', 702], ['', 0]])('numbers column %j as %d', (name, number) => {
		expect(getColumnNumberFromName(name)).toBe(number);
	});
});

describe('PHP number casts', () => {
	it('saturates integer strings and drops floats out of range', () => {
		expect(phpIntval('99999999999999999999')).toBe((1n << 63n) - 1n);
		expect(phpIntval('-99999999999999999999')).toBe(-(1n << 63n));
		expect(phpIntval('1.5e3')).toBe(1500n);
		expect(phpIntval('1e400')).toBe(0n);
	});

	it('reads the leading number of a string', () => {
		expect(phpFloatval('12abc')).toBe(12);
		expect(phpFloatval(' .5e1x')).toBe(5);
		expect(phpFloatval('abc')).toBe(0);
	});

	it.each([
		[0.00001, '1.0E-5'],
		[1e15, '1.0E+15'],
		[1e14, '1.0E+14'],
		[0.1, '0.1'],
		[0.1 + 0.2, '0.3'],
		[-0, '-0'],
		[0, '0'],
		[123_456_789_012_345_680, '1.2345678901235E+17'],
		[1.5e-7, '1.5E-7'],
		[0.0001, '0.0001'],
		[5, '5'],
		[NaN, 'NAN'],
		[Infinity, 'INF'],
		[-Infinity, '-INF'],
	])('prints %d as %s', (value, text) => {
		expect(phpFloatString(value)).toBe(text);
	});
});

describe('generated SQL', () => {
	const table = { name: 'tbl', columns: ['a', 'b', 'g'], rows: [['1', 'x\'y', 'POINT(1 2)'], ['NULL', '2.5', 'NULL']] };

	it('sizes columns from the analysis, without a size for geometry and 10 for unknown sizes', () => {
		const analysis = { types: [INT, VARCHAR, GEOMETRY] as const, sizes: [0, '5,2', 3] };
		expect(createTableSql('db', table, { types: [...analysis.types], sizes: analysis.sizes }, backquote))
			.toBe('CREATE TABLE IF NOT EXISTS `db`.`tbl` (`a` int(10), `b` varchar(5,2), `g` geometry);');
	});

	it('quotes text columns, leaves NULL and formatted SQL bare', () => {
		const analysis = { types: [INT, VARCHAR, GEOMETRY] as ColumnType[], sizes: [1, 3, 0], formattedSql: [false, false, true] };
		expect(insertSql('db', table, analysis, backquote, escape))
			.toBe('INSERT INTO `db`.`tbl` (`a`, `b`, `g`) VALUES (1, \'x\\\'y\', POINT(1 2)),\n (NULL, \'2.5\', NULL);');
	});

	it('quotes non-numeric cells without an analysis and skips tables without rows', () => {
		expect(insertSql('db', { ...table, rows: [['1', 'x', '2.5']] }, null, backquote, escape)).toBe('INSERT INTO `db`.`tbl` (`a`, `b`, `g`) VALUES (1, \'x\', 2.5);');
		expect(insertSql('db', { ...table, rows: [] }, null, backquote, escape)).toBeNull();
		expect(insertSql('db', { ...table, rows: [['1']] }, null, backquote, escape)).toBe('INSERT INTO `db`.`tbl` (`a`, `b`, `g`) VALUES (1, \u{27}\u{27}, \u{27}\u{27});');
	});
});

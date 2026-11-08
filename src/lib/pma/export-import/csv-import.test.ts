import { describe, expect, it } from 'vitest';

import { invalidCsvOption, parseCsv, unescapeCsvOption } from './csv-import.ts';

const defaults = { terminated: ',', enclosed: '"', escaped: '"', newLine: 'auto', maxLinesConstraint: 0 };

describe('parseCsv', () => {
	it('splits quoted values with separators, doubled quotes, newlines and unquoted NULL', () => {
		const result = parseCsv('id,name\n1,"a, b"\n2,"say ""hi"""\n3,NULL\n4,"multi\nline"\n', defaults);
		expect(result).toEqual({
			rows: [['id', 'name'], ['1', 'a, b'], ['2', 'say "hi"'], ['3', null], ['4', 'multi\nline']],
			formatErrorLine: null,
		});
	});

	it('keeps a quoted NULL as text and accepts CRLF or a missing final newline', () => {
		expect(parseCsv('"NULL",x\r\n10,y', defaults).rows).toEqual([['NULL', 'x'], ['10', 'y']]);
	});

	it('reads multi-character separators, a separate escape character and a custom line end', () => {
		const options = { ...defaults, terminated: '||', escaped: '\\', newLine: ';' };
		expect(parseCsv(String.raw`a||"b\"c"||;d||e;`, options).rows).toEqual([['a', 'b"c', ''], ['d', 'e']]);
	});

	it('reads unenclosed values when the enclosure is empty', () => {
		expect(parseCsv('1;a\n2;b\n', { ...defaults, terminated: ';', enclosed: '' }).rows).toEqual([['1', 'a'], ['2', 'b']]);
	});

	it('stops after the line limit', () => {
		expect(parseCsv('1\n2\n3\n', { ...defaults, maxLinesConstraint: 3 }).rows).toEqual([['1'], ['2']]);
	});

	it('keeps an unterminated quote at the end as the last value', () => {
		expect(parseCsv('1,"open\n', defaults).rows).toEqual([['1', 'open\n']]);
	});

	it.each([['a', ','], ['"', '"'], [',', '"']])('gets stuck on %j when the line end is %j, as the oracle reports', (text, newLine) => {
		expect(parseCsv(text, { ...defaults, newLine })).toEqual({ rows: [], formatErrorLine: 1 });
	});

	// Each of these was checked against the 5.2.3 oracle with a table import.
	it('keeps text after a closing quote and the line end in the same value, as PHP does', () => {
		expect(parseCsv('a,"b"x\n', defaults).rows).toEqual([['a', 'bx\n']]);
		expect(parseCsv('"a""",b\n', defaults).rows).toEqual([['a"', 'b']]);
		expect(parseCsv('a||b|', { ...defaults, terminated: '||', escaped: '\\', newLine: '|' }).rows).toEqual([['a', 'b']]);
	});

	it.each([
		['"', { terminated: ',', escaped: '\\', newLine: '\\' }],
		['"', { terminated: '||', newLine: '|' }],
		[',', { newLine: ',' }],
	])('stops at an escape, quote or separator that ends the input: %j', (text, options) => {
		expect(parseCsv(text, { ...defaults, ...options }).formatErrorLine).toBe(1);
	});

	it('reads a value whose quote is never closed up to a quote line end', () => {
		expect(parseCsv('"a', { ...defaults, escaped: '\\', newLine: '"' }).rows).toEqual([['a']]);
		expect(parseCsv('x\r', defaults).rows).toEqual([['x']]);
	});

	it('returns instead of spinning where PHP never leaves its loop', () => {
		expect(parseCsv('|a|"', { terminated: '|||', enclosed: '|', escaped: '"', newLine: '|', maxLinesConstraint: 0 })).toEqual({ rows: [], formatErrorLine: null });
	});

	it('ignores input without any line end, as upstream never parses that chunk', () => {
		expect(parseCsv('', defaults).rows).toEqual([]);
		expect(parseCsv('abc', { ...defaults, newLine: ';' }).rows).toEqual([['abc']]);
	});
});

describe('CSV options', () => {
	it('turns typed escape sequences into characters', () => {
		expect(unescapeCsvOption(String.raw`\t|\n|\r|\x`)).toBe('\t|\n|\r|\\x');
	});

	it.each([
		[{ terminated: '', enclosed: '"', escaped: '"', newLine: 'auto' }, 'Columns terminated with'],
		[{ terminated: ',', enclosed: 'xx', escaped: '"', newLine: 'auto' }, 'Columns enclosed with'],
		[{ terminated: ',', enclosed: '"', escaped: 'xx', newLine: 'auto' }, 'Columns escaped with'],
		[{ terminated: ',', enclosed: '"', escaped: '"', newLine: 'ab' }, 'Lines terminated with'],
		[{ terminated: ',', enclosed: '', escaped: '', newLine: '\n' }, null],
	])('names the first unusable option of %j', (options, label) => {
		expect(invalidCsvOption(options)).toBe(label);
	});
});

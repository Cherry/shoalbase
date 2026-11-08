import { describe, expect, it } from 'vitest';

import {
	findLineNumberAndColumn,
	getLines,
	lint,
	lintForEditor,
	lintMarker,
} from './linter.ts';

// Expectations below were captured from phpMyAdmin 5.2.3's /lint.
const error = (message: string, fromLine: number, fromColumn: number, toColumn: number) => {
	return { message, fromLine, fromColumn, toLine: fromLine, toColumn, severity: 'error' };
};

describe('getLines and findLineNumberAndColumn', () => {
	it('maps a position to its zero-based line and column', () => {
		const lines = getLines('ab\ncd\n\nef');
		expect(lines).toEqual([0, 3, 6, 7]);
		expect(findLineNumberAndColumn(lines, 0)).toEqual([0, 0]);
		expect(findLineNumberAndColumn(lines, 4)).toEqual([1, 1]);
		expect(findLineNumberAndColumn(lines, 8)).toEqual([3, 1]);
	});

	it('counts astral characters once, like the lexer', () => {
		expect(getLines(`${String.fromCodePoint(0x1_F6_00)}\nx`)).toEqual([0, 2]);
	});
});

describe('lint', () => {
	it('reports parser errors with the escaped token and its span', () => {
		expect(lint('SELEC 1')).toEqual([
			error('Unexpected beginning of statement. (near <code>SELEC</code>)', 0, 0, 5),
			error('Unexpected beginning of statement. (near <code>1</code>)', 0, 6, 7),
		]);
		expect(lint('SELECT * FRO players')).toEqual([]);
	});

	it('reports lexer errors that have no token', () => {
		expect(lint('"')).toEqual([
			error('Ending quote &quot; was expected. (near <code></code>)', 0, 1, 1),
			error('Unexpected beginning of statement. (near <code>&quot;</code>)', 0, 0, 1),
		]);
	});

	it('places errors without a token or position at the start', () => {
		expect(lintMarker([0, 4], ['Oops <x>.', 1, null, null])).toEqual(error('Oops &lt;x&gt;. (near <code></code>)', 0, 0, 0));
	});

	it('gives up on very long queries with a warning', () => {
		expect(lint('x'.repeat(10001))).toEqual([{
			message: 'Linting is disabled for this query because it exceeds the maximum length.',
			fromLine: 0,
			fromColumn: 0,
			toLine: 0,
			toColumn: 0,
			severity: 'warning',
		}]);
	});
});

describe('lintForEditor', () => {
	it('moves markers past the editor prefix back to the editor lines', () => {
		expect(lintForEditor('x$$\nSELEC 2', 'routine')).toEqual([
			error('Unexpected beginning of statement. (near <code>SELEC</code>)', 1, 0, 5),
			error('Unexpected beginning of statement. (near <code>2</code>)', 1, 6, 7),
		]);
		expect(lintForEditor('$$ SELEC 2', 'event')).toEqual([
			error('Unexpected beginning of statement. (near <code>SELEC</code>)', 0, 3, 8),
			error('Unexpected beginning of statement. (near <code>2</code>)', 0, 9, 10),
		]);
	});

	it('keeps markers that fall on the prefix line', () => {
		expect(lintForEditor('`', 'routine')).toEqual([error('Ending quote ` was expected. (near <code></code>)', 0, 1, 1)]);
		// The prefix counts toward the length limit, and its warning stays on line 0.
		expect(lintForEditor('x'.repeat(9990), 'routine')).toEqual(lint('x'.repeat(10001)));
	});

	it('lints without a prefix for unknown or malformed editor types', () => {
		expect(lintForEditor('SELEC 1', 'nope')).toEqual(lint('SELEC 1'));
		expect(lintForEditor('SELEC 1', ['routine'])).toEqual(lint('SELEC 1'));
	});
});

import { describe, expect, it } from 'vitest';

import { Query } from '../../../sql-parser/index.ts';
import { FieldMetadata, MysqlType } from '../field-metadata.ts';
import {
	detailedProfilingStats,
	hasNoRightsToDropDatabase,
	isAppendLimitClause,
	isJustBrowsing,
	isRememberSortingOrder,
	parseEnumSetValues,
	resultSetHasJustOneTable,
	startPosToDisplayRow,
} from './sql.ts';

const field = (table: string): FieldMetadata => new FieldMetadata(MysqlType.LONG, 0, { name: 'c', orgname: 'c', table, orgtable: table, charsetnr: 63, decimals: 0, length: 11 });

describe('isRememberSortingOrder', () => {
	it('remembers the sort of a plain SELECT * over one table only', () => {
		expect(isRememberSortingOrder(Query.getAll('SELECT * FROM t'), true)).toBe(true);
		expect(isRememberSortingOrder(Query.getAll('SELECT * FROM t'), false)).toBe(false);
		expect(isRememberSortingOrder(Query.getAll('SELECT a FROM t'), true)).toBe(false);
		expect(isRememberSortingOrder(Query.getAll('SELECT * FROM t, u'), true)).toBe(false);
		expect(isRememberSortingOrder(Query.getAll('SELECT COUNT(*) FROM t'), true)).toBe(false);
		expect(isRememberSortingOrder(Query.getAll('SELECT 1'), true)).toBe(false);
	});

	it('ignores statements without a select list', () => {
		expect(isRememberSortingOrder(Query.getAll('UPDATE t SET a = 1'), true)).toBe(false);
		expect(isRememberSortingOrder({ ...Query.getAll('SELECT * FROM t'), select_expr: [] }, true)).toBe(true);
	});
});

describe('isAppendLimitClause', () => {
	it('adds a LIMIT to SELECTs and subqueries that have none', () => {
		expect(isAppendLimitClause(Query.getAll('SELECT * FROM t'), 25)).toBe(true);
		expect(isAppendLimitClause(Query.getAll('SELECT * FROM t LIMIT 5'), 25)).toBe(false);
		expect(isAppendLimitClause(Query.getAll('SELECT 1'), 25)).toBe(false);
		expect(isAppendLimitClause(Query.getAll('SELECT * FROM t'), 'all')).toBe(false);
	});

	it('skips parse errors, exports, PROCEDURE ANALYSE and unparsed queries', () => {
		expect(isAppendLimitClause(Query.getAll('SELECT * FROM t ORDER'), 25)).toBe(false);
		expect(isAppendLimitClause({ ...Query.getAll('SELECT * FROM t'), is_export: true }, 25)).toBe(false);
		expect(isAppendLimitClause({ ...Query.getAll('SELECT * FROM t'), is_analyse: true }, 25)).toBe(false);
		expect(isAppendLimitClause({ ...Query.getAll('SELECT * FROM t'), parser: undefined }, 25)).toBe(false);
	});
});

describe('isJustBrowsing', () => {
	it('accepts a single-table SELECT with no or a trivial WHERE', () => {
		expect(isJustBrowsing(Query.getAll('SELECT * FROM t'), null)).toBe(true);
		expect(isJustBrowsing(Query.getAll('SELECT * FROM t WHERE 1'), null)).toBe(true);
	});

	it('rejects filters, groups, joins and an explicit real end', () => {
		expect(isJustBrowsing(Query.getAll('SELECT * FROM t WHERE a = 1'), null)).toBe(false);
		expect(isJustBrowsing(Query.getAll('SELECT a FROM t GROUP BY a'), null)).toBe(false);
		expect(isJustBrowsing(Query.getAll('SELECT DISTINCT a FROM t'), null)).toBe(false);
		expect(isJustBrowsing(Query.getAll('SELECT * FROM t, u'), null)).toBe(false);
		expect(isJustBrowsing(Query.getAll('SELECT * FROM t JOIN u ON t.a = u.a'), null)).toBe(false);
		expect(isJustBrowsing(Query.getAll('SELECT * FROM t'), true)).toBe(false);
		expect(isJustBrowsing(Query.getAll('SELECT 1'), null)).toBe(false);
		expect(isJustBrowsing({ ...Query.getAll('SELECT * FROM t'), select_tables: undefined }, null)).toBe(false);
		expect(isJustBrowsing({ ...Query.getAll('SELECT * FROM t'), statement: undefined }, null)).toBe(true);
	});
});

describe('hasNoRightsToDropDatabase', () => {
	it('blocks DROP DATABASE for non-superusers unless allowed', () => {
		const drop = Query.getAll('DROP DATABASE d');
		expect(hasNoRightsToDropDatabase(drop, false, false)).toBe(true);
		expect(hasNoRightsToDropDatabase(drop, true, false)).toBe(false);
		expect(hasNoRightsToDropDatabase(drop, false, true)).toBe(false);
		expect(hasNoRightsToDropDatabase(Query.getAll('DROP TABLE t'), false, false)).toBe(false);
	});
});

describe('resultSetHasJustOneTable', () => {
	it('needs at least one named table and no second one', () => {
		expect(resultSetHasJustOneTable([field('t'), field(''), field('t')])).toBe(true);
		expect(resultSetHasJustOneTable([field('t'), field('u')])).toBe(false);
		expect(resultSetHasJustOneTable([field('')])).toBe(false);
	});
});

describe('startPosToDisplayRow', () => {
	it('returns the first row of the page holding the given row', () => {
		expect(startPosToDisplayRow(260, 25)).toBe(250);
		expect(startPosToDisplayRow(250, 25)).toBe(225);
		expect(startPosToDisplayRow(10, 'all')).toBe(0);
	});
});

describe('detailedProfilingStats', () => {
	it('keeps the first duration of a state as text and sums repeated states as numbers', () => {
		const stats = detailedProfilingStats([
			{ Status: 'starting', Duration: '0.000098' },
			{ Status: 'checking permissions', Duration: '0.000004' },
			{ Status: 'starting', Duration: '0.000006' },
			{ Status: null, Duration: null },
		]);
		expect(stats.total_time).toBeCloseTo(0.000108, 9);
		expect(stats.chart.get('Checking Permissions')).toBe('0.000004');
		expect(stats.chart.get('Starting')).toBeCloseTo(0.000104, 9);
		expect(stats.states.get('Starting')).toMatchObject({ calls: 2 });
		expect(stats.states.get('')).toEqual({ total_time: '0', calls: 1 });
		expect(stats.profile[0]).toEqual({ status: 'Starting', duration: '98 µ', duration_raw: '0.000098' });
	});
});

describe('parseEnumSetValues', () => {
	it('splits quoted members, keeping escapes and unescaping doubled quotes and backslashes', () => {
		expect(parseEnumSetValues(String.raw`enum('x','y''z','a\\b')`)).toEqual(['x', 'y\'z', String.raw`a\b`]);
		expect(parseEnumSetValues('set(\'p\',\'q,r\')')).toEqual(['p', 'q,r']);
		expect(parseEnumSetValues(String.raw`enum('a\'b')`)).toEqual([String.raw`a\'b`]);
	});

	it('keeps unquoted text and unterminated values like str_getcsv()', () => {
		expect(parseEnumSetValues('enum(1,\'two\'x)')).toEqual(['1', 'twox']);
		expect(parseEnumSetValues('enum(\'open')).toEqual(['']);
		expect(parseEnumSetValues('enum(\'open)')).toEqual(['open']);
		expect(parseEnumSetValues('int')).toEqual(['']);
	});
});

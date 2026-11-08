import { describe, expect, it } from 'vitest';

import {
	StrictNullError,
	criteriaCounts,
	fillJoinClauses,
	joinClause,
	orderByClause,
	selectClause,
	unfinalizedTables,
	whereClause,
	whereClauseTablesAndColumns,
} from './qbe.ts';

const values = (...entries: [number, string][]) => new Map(entries);

describe('criteriaCounts', () => {
	it('defaults to three columns and one row', () => {
		expect(criteriaCounts({})).toEqual({ posted: 3, columns: 3, rows: 0 });
	});

	it('adds the requested columns and rows, never going below zero or above 100 rows', () => {
		expect(criteriaCounts({ criteriaColumnCount: '2', criteriaColumnAdd: '1', rows: '1', criteriaRowAdd: '2' })).toEqual({ posted: 2, columns: 3, rows: 3 });
		expect(criteriaCounts({ criteriaColumnCount: '1', criteriaColumnAdd: '-3', rows: '0', criteriaRowAdd: '-1' })).toEqual({ posted: 1, columns: 0, rows: 0 });
		expect(criteriaCounts({ rows: '99', criteriaRowAdd: '3' }).rows).toBe(100);
		expect(criteriaCounts({ criteriaColumnCount: 'x', criteriaColumnAdd: ['1'] }).columns).toBe(3);
	});
});

describe('selectClause', () => {
	it('lists the shown columns with their aliases', () => {
		const columns = values([0, '`t`.`a`'], [1, '`t`.`b`'], [2, ''], [3, '`t`.`d`']);
		const shows = values([0, 'on'], [1, 'on'], [2, 'on'], [3, 'off']);
		expect(selectClause(4, columns, shows, values([1, 'b`x'], [0, '0']))).toBe('SELECT `t`.`a`, `t`.`b` AS `b``x`\n');
	});

	it('is empty when nothing is shown', () => {
		expect(selectClause(1, values([0, '`t`.`a`']), values(), values())).toBe('');
	});
});

describe('whereClause', () => {
	const columns = values([0, '`t`.`a`'], [1, '`t`.`b`'], [2, '`t`.`c`']);

	it('joins the criteria with the and/or choice of the previous criterion', () => {
		const where = whereClause({
			columnCount: 3,
			rowCount: 0,
			columns,
			criterions: values([0, '= 1'], [2, '> 2']),
			andOrColumns: values([0, 'or'], [1, 'and']),
			andOrRows: values(),
			orValue: () => {},
		});
		expect(where).toBe('WHERE ((`t`.`a` = 1) OR (`t`.`c` > 2))\n');
	});

	it('adds the OR rows with their row choice', () => {
		const orValues: Record<string, string> = { '0,0': '< 5', '1,0': '= 7' };
		const where = whereClause({
			columnCount: 3,
			rowCount: 1,
			columns,
			criterions: values([1, 'IS NULL']),
			andOrColumns: values([0, 'and']),
			andOrRows: values([0, ''], [1, 'and']),
			orValue: (row, column) => orValues[`${row},${column}`],
		});
		expect(where).toBe('WHERE (`t`.`b` IS NULL)\n (`t`.`a` < 5)\nAND (`t`.`a` = 7)\n');
	});

	it('groups several values of one OR row', () => {
		const orValues: Record<string, string> = { '0,0': '< 5', '0,2': '> 1' };
		const where = whereClause({
			columnCount: 3,
			rowCount: 0,
			columns,
			criterions: values(),
			andOrColumns: values([0, 'or']),
			andOrRows: values(),
			orValue: (row, column) => orValues[`${row},${column}`],
		});
		expect(where).toBe('WHERE \n((`t`.`a` < 5) OR (`t`.`c` > 1))\n');
	});

	it('is empty without criteria', () => {
		expect(whereClause({ columnCount: 1, rowCount: 0, columns, criterions: values(), andOrColumns: values(), andOrRows: values(), orValue: () => '' })).toBe('');
	});

	it('fails like strict-typed PHP when an and/or choice is missing', () => {
		const base = { columnCount: 3, rowCount: 0, columns, andOrRows: values() };
		expect(() => whereClause({ ...base, criterions: values([0, '= 1'], [1, '= 2']), andOrColumns: values(), orValue: () => {} })).toThrow(StrictNullError);
		expect(() => whereClause({ ...base, criterions: values(), andOrColumns: values([0, 'and']), orValue: (_, column) => (column === 1 ? '= 1' : undefined) })).toThrow(StrictNullError);
	});
});

describe('orderByClause', () => {
	it('sorts by sort order, then direction, then column when every list has an entry per column', () => {
		const columns = values([0, '`t`.`a`'], [1, '`t`.`b`'], [2, '`t`.*']);
		const sorts = values([0, 'ASC'], [1, 'DESC'], [2, 'ASC']);
		expect(orderByClause(3, columns, sorts, values([0, '2'], [1, '10'], [2, '1']))).toBe('ORDER BY `t`.`a` ASC, `t`.`b` DESC\n');
		expect(orderByClause(3, columns, sorts, values([0, '1000'], [1, '1000'], [2, '1000']))).toBe('ORDER BY `t`.`a` ASC, `t`.`b` DESC\n');
		expect(orderByClause(2, values([0, '`t`.`b`'], [1, '`t`.`a`']), values([0, 'ASC'], [1, 'ASC']), values([0, '1'], [1, '1']))).toBe('ORDER BY `t`.`a` ASC, `t`.`b` ASC\n');
	});

	it('keeps the column order when the lists do not line up and skips unsorted columns', () => {
		const columns = values([0, '`t`.`b`'], [1, '`t`.`a`'], [2, '']);
		expect(orderByClause(3, columns, values([0, 'DESC'], [1, ''], [2, '']), values([0, '2']))).toBe('ORDER BY `t`.`b` DESC\n');
		expect(orderByClause(3, columns, values([0, ''], [1, ''], [2, 'ASC']), values())).toBe('ORDER BY  ASC\n');
		expect(orderByClause(1, columns, values([0, '']), values())).toBe('');
	});

	it('fails like strict-typed PHP for a sort without any column', () => {
		expect(() => orderByClause(1, values(), values([0, 'ASC']), values())).toThrow(StrictNullError);
	});
});

describe('whereClauseTablesAndColumns', () => {
	it('collects the columns whose criterion is an equality or an IS test', () => {
		const columns = ['`t`.`a`', '`u`.`b`', '`t`.`c`', '`t`', '`t`.`d`'];
		const result = whereClauseTablesAndColumns(['= 1', 'is null', '> 3', '= 1', undefined], index => columns[index]);
		expect(result.columns.keys().toArray()).toEqual(['t.a', 'u.b']);
		expect(result.tables.keys().toArray()).toEqual(['t', 'u']);
	});

	it('fails like strict-typed PHP for a criterion without a posted column', () => {
		expect(() => whereClauseTablesAndColumns(['= 1'], () => {})).toThrow(StrictNullError);
	});
});

describe('join building', () => {
	const relations = new Map([
		['child', new Map([['parent', '`child`.`pid` = `parent`.`id`']])],
		['parent', new Map<string, string>()],
		['grandchild', new Map([['child', '`grandchild`.`cid` = `child`.`id`']])],
		['other', new Map<string, string>()],
	]);

	it('joins every table reachable from the master in either direction', () => {
		const finalized = new Map([['parent', '']]);
		fillJoinClauses(finalized, relations, ['parent', 'child', 'grandchild', 'other']);
		expect([...finalized]).toEqual([['parent', ''], ['child', '`child`.`pid` = `parent`.`id`'], ['grandchild', '`grandchild`.`cid` = `child`.`id`']]);
		expect(unfinalizedTables(['parent', 'child', 'grandchild', 'other'], finalized)).toEqual(['other']);
		expect(joinClause(['other'], finalized)).toBe('`other`, `parent`\n    LEFT JOIN `child` ON `child`.`pid` = `parent`.`id`\n    LEFT JOIN `grandchild` ON `grandchild`.`cid` = `child`.`id`');
	});

	it('stops once every table is joined and does nothing without a master', () => {
		const finalized = new Map([['child', '']]);
		fillJoinClauses(finalized, relations, ['child', 'parent']);
		expect(finalized.keys().toArray()).toEqual(['child', 'parent']);
		// With every table joined, the FROM clause starts at the master without a leading comma.
		expect(joinClause(unfinalizedTables(['child', 'parent'], finalized), finalized)).toBe('`child`\n    LEFT JOIN `parent` ON `child`.`pid` = `parent`.`id`');
		const empty = new Map<string, string>();
		fillJoinClauses(empty, relations, ['child', 'unknown']);
		expect(empty.size).toBe(0);
		expect(joinClause(['a', 'b'], empty)).toBe('`a`, `b`');
	});
});

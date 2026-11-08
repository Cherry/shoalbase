import { describe, expect, it } from 'vitest';

import {
	earliestTime,
	engineKind,
	mysqlDateToTimestamp,
	replicationStatus,
	rowCountApproximation,
	tableListSort,
} from './structure.ts';

describe('tableListSort', () => {
	it('maps the request keys to status columns and only accepts DESC as a direction', () => {
		expect(tableListSort('size', 'DESC')).toEqual({ sortBy: 'Data_length', sortOrder: 'DESC' });
		expect(tableListSort('records', 'desc')).toEqual({ sortBy: 'Rows', sortOrder: 'ASC' });
	});

	it('falls back to the name for unknown or inherited keys', () => {
		expect(tableListSort('bogus', 'DESC')).toEqual({ sortBy: 'Name', sortOrder: 'ASC' });
		expect(tableListSort('toString', 'DESC')).toEqual({ sortBy: 'Name', sortOrder: 'ASC' });
		expect(tableListSort(['size'], 'DESC')).toEqual({ sortBy: 'Name', sortOrder: 'ASC' });
	});
});

describe('engineKind', () => {
	it.each([
		['aria', ['MyISAM', 'ISAM', 'HEAP', 'MEMORY', 'ARCHIVE', 'Aria', 'Maria']],
		['innodb', ['InnoDB', 'PBMS', 'TokuDB', 'ROCKSDB']],
		['csv', ['CSV']],
		['merge', ['MRG_MyISAM', 'MRG_MYISAM', 'MERGE', 'BerkeleyDB']],
		['mroonga', ['Mroonga']],
		['unknown', ['BLACKHOLE', 'innodb']],
	])('reads %s sizes for its engines', (kind, engines) => {
		for (const engine of engines) {
			expect(engineKind(engine)).toBe(kind);
		}
	});

	it('treats a missing engine as a view', () => {
		expect(engineKind(null)).toBe('view');
		expect(engineKind(undefined)).toBe('view');
		expect(engineKind('')).toBe('view');
		expect(engineKind('SYSTEM VIEW')).toBe('view');
	});
});

describe('rowCountApproximation', () => {
	const base = { tableRows: 5, engine: 'InnoDB', counted: false, isView: false, maxExactCountViews: 0 };

	it('marks estimated InnoDB, CSV and TokuDB counts as approximate', () => {
		expect(rowCountApproximation(base)).toEqual({ approxRows: true, viewHint: false });
		expect(rowCountApproximation({ ...base, counted: true })).toEqual({ approxRows: false, viewHint: false });
		expect(rowCountApproximation({ ...base, engine: 'MyISAM' })).toEqual({ approxRows: false, viewHint: false });
	});

	it('has nothing to say without rows or, outside views, without an engine', () => {
		expect(rowCountApproximation({ ...base, tableRows: null })).toEqual({ approxRows: false, viewHint: false });
		expect(rowCountApproximation({ ...base, tableRows: undefined })).toEqual({ approxRows: false, viewHint: false });
		expect(rowCountApproximation({ ...base, engine: null })).toEqual({ approxRows: false, viewHint: false });
	});

	it('adds the view hint when a view reaches MaxExactCountViews, false only reaching 0', () => {
		const view = { ...base, engine: null, isView: true };
		expect(rowCountApproximation({ ...view, tableRows: 0 })).toEqual({ approxRows: true, viewHint: true });
		expect(rowCountApproximation({ ...view, tableRows: '3', maxExactCountViews: 5 })).toEqual({ approxRows: false, viewHint: false });
		expect(rowCountApproximation({ ...view, tableRows: false })).toEqual({ approxRows: true, viewHint: true });
		expect(rowCountApproximation({ ...view, tableRows: false, maxExactCountViews: 5 })).toEqual({ approxRows: false, viewHint: false });
	});
});

describe('replicationStatus', () => {
	it('reports nothing without replication', () => {
		expect(replicationStatus({ status: false }, 'db', 't')).toEqual({ do: false, ignored: false });
	});

	it('replicates everything when no filters are set', () => {
		expect(replicationStatus({ status: true }, 'db', 't')).toEqual({ do: true, ignored: false });
	});

	it('applies wildcard rules, ignoring before replicating', () => {
		const info = { status: true, Do_DB: ['db'], Wild_Do_Table: ['db.pre%'], Wild_Ignore_Table: ['db.skip%'] };
		expect(replicationStatus(info, 'db', 'prefixed')).toEqual({ do: true, ignored: false });
		expect(replicationStatus(info, 'db', 'skipped')).toEqual({ do: false, ignored: true });
		expect(replicationStatus(info, 'db', 'other')).toEqual({ do: false, ignored: false });
		expect(replicationStatus(info, 'otherdb', 'prefixed')).toEqual({ do: false, ignored: false });
	});

	it('treats the prefix literally and a rule without a table as matching everything', () => {
		expect(replicationStatus({ status: true, Ignore_DB: ['x'], Wild_Do_Table: ['db.a+%'] }, 'db', 'aa')).toEqual({ do: false, ignored: false });
		expect(replicationStatus({ status: true, Ignore_DB: ['x'], Wild_Do_Table: ['db.a+%'] }, 'db', 'a+b')).toEqual({ do: true, ignored: false });
		expect(replicationStatus({ status: true, Ignore_DB: ['x'], Wild_Do_Table: ['db'] }, 'db', 'any')).toEqual({ do: true, ignored: false });
		expect(replicationStatus({ status: true, Do_DB: ['db'] }, 'db', 'any')).toEqual({ do: false, ignored: false });
	});
});

describe('earliestTime', () => {
	it('keeps the smallest non-empty time', () => {
		expect(earliestTime('', '2024-01-02 00:00:00')).toBe('2024-01-02 00:00:00');
		expect(earliestTime('2024-01-02 00:00:00', '2023-12-31 00:00:00')).toBe('2023-12-31 00:00:00');
		expect(earliestTime('2023-12-31 00:00:00', '2024-01-02 00:00:00')).toBe('2023-12-31 00:00:00');
		expect(earliestTime('2023-12-31 00:00:00', null)).toBe('2023-12-31 00:00:00');
	});
});

describe('mysqlDateToTimestamp', () => {
	it('reads a DATETIME as UTC seconds', () => {
		expect(mysqlDateToTimestamp('2024-01-02 03:04:05')).toBe(1_704_164_645);
	});
});

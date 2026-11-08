import { describe, expect, it } from 'vitest';

import { charsetQueryPart, sortDetails, statisticsColumns } from './databases.ts';
import { phpEmpty, phpFloat, phpInt } from './php.ts';
import {
	isReplicated,
	primaryInfo,
	replicaInfo,
	showBinLogStatusStatement,
	showReplicaStatusStatement,
} from './replication-info.ts';

describe('sortDetails', () => {
	it('only accepts the allow-listed columns and a case-insensitive desc', () => {
		expect(sortDetails(undefined, undefined)).toEqual({ sortBy: 'SCHEMA_NAME', sortOrder: 'asc' });
		expect(sortDetails('SCHEMA_TABLES', 'DESC')).toEqual({ sortBy: 'SCHEMA_TABLES', sortOrder: 'desc' });
		expect(sortDetails('1 OR 1', 'sideways')).toEqual({ sortBy: 'SCHEMA_NAME', sortOrder: 'asc' });
	});
});

describe('statisticsColumns', () => {
	it('starts every column at zero, bytes for sizes and numbers for counts', () => {
		const columns = statisticsColumns();
		expect(Object.keys(columns)).toEqual(['SCHEMA_TABLES', 'SCHEMA_TABLE_ROWS', 'SCHEMA_DATA_LENGTH', 'SCHEMA_INDEX_LENGTH', 'SCHEMA_LENGTH', 'SCHEMA_DATA_FREE']);
		expect(columns.SCHEMA_TABLES).toEqual({ title: 'Tables', format: 'number', raw: 0 });
		expect(columns.SCHEMA_DATA_FREE?.format).toBe('byte');
	});
});

describe('charsetQueryPart', () => {
	it('adds COLLATE only when the collation is more than the charset', () => {
		expect(charsetQueryPart('utf8mb4_bin')).toBe(' CHARSET=utf8mb4 COLLATE utf8mb4_bin');
		expect(charsetQueryPart('binary')).toBe(' CHARSET=binary');
		expect(charsetQueryPart('latin1_swedish_ci', true)).toBe(' CHARACTER SET latin1 COLLATE latin1_swedish_ci');
	});
});

describe('PHP request helpers', () => {
	it('treats empty() values like PHP', () => {
		for (const value of [undefined, null, '', '0', false, 0, []]) {
			expect(phpEmpty(value)).toBe(true);
		}
		for (const value of ['a', '00', 1, ['x']]) {
			expect(phpEmpty(value)).toBe(false);
		}
	});

	it('casts leading numbers', () => {
		expect(phpInt('12abc')).toBe(12);
		expect(phpFloat('1.5e2x')).toBe(150);
	});
});

describe('replication info', () => {
	it('picks the status statements by server flavour and version', () => {
		expect(showBinLogStatusStatement({ isMariaDB: false, version: 80400 })).toBe('SHOW BINARY LOG STATUS');
		expect(showBinLogStatusStatement({ isMariaDB: true, version: 120300 })).toBe('SHOW BINLOG STATUS');
		expect(showBinLogStatusStatement({ isMariaDB: false, version: 50744 })).toBe('SHOW MASTER STATUS');
		expect(showReplicaStatusStatement({ isMariaDB: false, version: 80022 })).toBe('SHOW REPLICA STATUS');
		expect(showReplicaStatusStatement({ isMariaDB: true, version: 100501 })).toBe('SHOW REPLICA STATUS');
		expect(showReplicaStatusStatement({ isMariaDB: false, version: 50744 })).toBe('SHOW SLAVE STATUS');
	});

	it('is off without status rows', () => {
		expect(primaryInfo([])).toEqual({ status: false });
		expect(replicaInfo([])).toEqual({ status: false });
	});

	it('splits the filter columns of the first row', () => {
		expect(primaryInfo([{ Binlog_Do_DB: 'a,b', Binlog_Ignore_DB: '' }])).toEqual({ status: true, Do_DB: ['a', 'b'], Ignore_DB: [] });
		const replica = replicaInfo([{ Replicate_Do_DB: null, Replicate_Ignore_DB: 'x', Replicate_Wild_Do_Table: '0' }]);
		expect(replica.Do_DB).toEqual([]);
		expect(replica.Ignore_DB).toEqual(['x']);
		expect(replica.Wild_Do_Table).toEqual([]);
	});

	it('replicates databases that are not ignored and match Do_DB, or everything without Do_DB', () => {
		expect(isReplicated({ status: true, Do_DB: [], Ignore_DB: ['skip'] }, 'any')).toBe(true);
		expect(isReplicated({ status: true, Do_DB: [], Ignore_DB: ['skip'] }, 'skip')).toBe(false);
		expect(isReplicated({ status: true, Do_DB: ['only'] }, 'only')).toBe(true);
		expect(isReplicated({ status: true, Do_DB: ['only'] }, 'other')).toBe(false);
		expect(isReplicated({ status: true, Ignore_DB: [] }, 'any')).toBe(true);
	});
});

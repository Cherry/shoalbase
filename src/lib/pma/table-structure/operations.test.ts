import { describe, expect, it } from 'vitest';

import {
	type TableAltersInput,
	convertCollationQuery,
	partitionMaintenanceChoices,
	partitioningTableQuery,
	possibleRowFormats,
	reorderingTableQuery,
	tableAltersArray,
	userTableComment,
} from './operations.ts';

describe('possibleRowFormats', () => {
	it('offers DYNAMIC and COMPRESSED for InnoDB only with Barracuda or file-per-table', () => {
		expect(possibleRowFormats(false).INNODB).toEqual({ COMPACT: 'COMPACT', REDUNDANT: 'REDUNDANT' });
		expect(possibleRowFormats(true).INNODB).toEqual({ COMPACT: 'COMPACT', REDUNDANT: 'REDUNDANT', DYNAMIC: 'DYNAMIC', COMPRESSED: 'COMPRESSED' });
	});
});

describe('partitionMaintenanceChoices', () => {
	it('offers DROP for range and list partitions, else COALESCE', () => {
		expect(partitionMaintenanceChoices('RANGE COLUMNS')).toHaveProperty('DROP', 'Drop');
		expect(partitionMaintenanceChoices('HASH')).toHaveProperty('COALESCE', 'Coalesce');
		expect(partitionMaintenanceChoices(null)).not.toHaveProperty('DROP');
	});
});

describe('query builders', () => {
	it('reorders ascending unless desc is asked for', () => {
		expect(reorderingTableQuery('t', 'a', 'desc')).toBe('ALTER TABLE `t` ORDER BY `a` DESC;');
		expect(reorderingTableQuery('t', 'a', null)).toBe('ALTER TABLE `t` ORDER BY `a` ASC;');
	});

	it('coalesces by partition count and lists names for other operations', () => {
		expect(partitioningTableQuery('t', 'COALESCE', ['p0', 'p1'])).toBe('ALTER TABLE `t` COALESCE PARTITION 2');
		expect(partitioningTableQuery('t', 'ANALYZE', ['p0', 'p1'])).toBe('ALTER TABLE `t` ANALYZE PARTITION p0, p1;');
	});

	it('converts to the collation charset', () => {
		expect(convertCollationQuery('t', 'utf8mb4_bin')).toBe('ALTER TABLE `t` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_bin');
		expect(convertCollationQuery('t', 'binary')).toBe('ALTER TABLE `t` CONVERT TO CHARACTER SET binary');
	});
});

describe('userTableComment', () => {
	it('strips the InnoDB free space note', () => {
		expect(userTableComment('mine; InnoDB free: 4096 kB')).toBe('mine');
		expect(userTableComment('InnoDB free: 4096 kB')).toBe('');
		expect(userTableComment('plain')).toBe('plain');
		expect(userTableComment(null)).toBe('');
	});
});

describe('tableAltersArray', () => {
	const base: TableAltersInput = {
		post: {},
		isEngine: () => false,
		storageEngine: 'INNODB',
		packKeys: 'DEFAULT',
		checksum: '0',
		pageChecksum: '',
		delayKeyWrite: '0',
		rowFormat: 'Dynamic',
		newStorageEngine: '',
		transactional: '1',
		collation: 'utf8mb4_bin',
		autoIncrement: '3',
	};

	it('changes nothing for an unchanged form', () => {
		expect(tableAltersArray({ ...base, post: { comment: 'a b', prev_comment: 'a+b', tbl_collation: 'utf8mb4_bin', new_row_format: '' } })).toEqual([]);
	});

	it('collects the changed comment, engine, collation, auto increment and row format', () => {
		const isEngine = (engines: string[]): boolean => engines.includes('INNODB');
		expect(tableAltersArray({
			...base,
			isEngine,
			newStorageEngine: 'MYISAM',
			post: { comment: 'it\'s', prev_comment: 'old%zz', tbl_collation: 'latin1_swedish_ci', new_auto_increment: '10', hidden_auto_increment: '3', new_row_format: 'compact' },
		})).toEqual([
			String.raw`COMMENT = 'it\'s'`,
			'ENGINE = MYISAM',
			'DEFAULT  CHARSET=latin1 COLLATE latin1_swedish_ci',
			'auto_increment = 10',
			'ROW_FORMAT = compact',
		]);
	});

	it('handles the MyISAM and Aria flags', () => {
		const isEngine = (engines: string[]): boolean => engines.includes('ARIA');
		expect(tableAltersArray({
			...base,
			isEngine,
			rowFormat: '',
			post: { new_pack_keys: '1', new_checksum: 'on', new_transactional: '0', new_page_checksum: '1', new_delay_key_write: '1', new_row_format: 'PAGE' },
		})).toEqual([
			'pack_keys = 1',
			'checksum = 1',
			'TRANSACTIONAL = 0',
			'PAGE_CHECKSUM = 1',
			'delay_key_write = 1',
			'ROW_FORMAT = PAGE',
		]);
	});

	it('ignores an auto increment equal to the hidden value', () => {
		const isEngine = (engines: string[]): boolean => engines.includes('INNODB');
		expect(tableAltersArray({ ...base, isEngine, post: { new_auto_increment: '5', hidden_auto_increment: '5', new_row_format: 'dynamic' } })).toEqual([]);
	});
});

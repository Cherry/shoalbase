import { describe, expect, it } from 'vitest';

import {
	type ExistingForeignKey,
	type ForeignKeyRow,
	createForeignKeyQuery,
	planForeignKeyUpdate,
	relationColumnArray,
	tablesWithEngine,
} from './relation.ts';

describe('relationColumnArray', () => {
	const columns = [{ Field: 'b10', Key: '' }, { Field: 'b9', Key: 'MUL' }, { Field: 'a', Key: 'PRI' }];

	it('lists every column for InnoDB after an empty choice, in natural order', () => {
		expect(relationColumnArray(columns, 'INNODB', true).keys().toArray()).toEqual(['', 'a', 'b9', 'b10']);
		expect(relationColumnArray(columns, 'innodb', false).keys().toArray()).toEqual(['', 'b10', 'b9', 'a']);
	});

	it('keeps only indexed columns for other engines', () => {
		expect(relationColumnArray([...columns, { Field: null, Key: null }, { Field: null, Key: 'UNI' }], 'NDB', false).values().toArray()).toEqual(['', 'b9', 'a']);
	});
});

describe('tablesWithEngine', () => {
	it('filters SHOW TABLE STATUS rows by engine', () => {
		const rows = [['t10', 'InnoDB'], ['t9', 'innodb'], ['v', null], ['m', 'MyISAM']];
		expect(tablesWithEngine(rows, 'INNODB', true)).toEqual(['t9', 't10']);
		expect(tablesWithEngine(rows, 'INNODB', false)).toEqual(['t10', 't9']);
		expect(tablesWithEngine([[null, 'MyISAM']], 'MYISAM', false)).toEqual(['']);
	});
});

describe('createForeignKeyQuery', () => {
	it('names the constraint and the other database when given', () => {
		expect(createForeignKeyQuery({
			table: 'c',
			currentDb: 'db',
			fields: ['a', 'b'],
			foreignDb: 'other',
			foreignTable: 'p',
			foreignFields: ['x', 'y'],
			name: 'fk',
			onDelete: 'CASCADE',
			onUpdate: 'SET NULL',
		})).toBe('ALTER TABLE `c` ADD  CONSTRAINT `fk` FOREIGN KEY (`a`, `b`) REFERENCES `other`.`p`(`x`, `y`) ON DELETE CASCADE ON UPDATE SET NULL;');
	});

	it('leaves out empty names and actions in the same database', () => {
		expect(createForeignKeyQuery({ table: 'c', currentDb: 'db', fields: ['a'], foreignDb: 'db', foreignTable: 'p', foreignFields: ['x'], name: '0' }))
			.toBe('ALTER TABLE `c` ADD  FOREIGN KEY (`a`) REFERENCES `p`(`x`);');
	});
});

describe('planForeignKeyUpdate', () => {
	const row = (overrides: Partial<ForeignKeyRow> = {}): ForeignKeyRow => {
		return {
			foreignDb: 'db',
			foreignTable: 'p',
			fields: new Map([['0', 'a']]),
			foreignFields: new Map([['0', 'x']]),
			constraintName: 'fk',
			onDelete: 'CASCADE',
			onUpdate: 'RESTRICT',
			...overrides,
		};
	};
	const existing: ExistingForeignKey = { constraint: 'fk', index_list: ['a'], ref_table_name: 'p', ref_index_list: ['x'], on_delete: 'CASCADE' };

	it('creates a new key', () => {
		expect(planForeignKeyUpdate('c', 'db', row(), undefined)).toEqual({
			drop: null,
			create: 'ALTER TABLE `c` ADD  CONSTRAINT `fk` FOREIGN KEY (`a`) REFERENCES `p`(`x`) ON DELETE CASCADE ON UPDATE RESTRICT;',
			recreate: null,
			fields: ['a'],
		});
	});

	it('leaves an unchanged key alone, treating a missing action as RESTRICT', () => {
		expect(planForeignKeyUpdate('c', 'db', row(), existing)).toEqual({ drop: null, create: null, recreate: null, fields: ['a'] });
	});

	it('drops and recreates a changed key, with a restore statement', () => {
		const plan = planForeignKeyUpdate('c', 'db', row({ onUpdate: 'NO_ACTION' }), { ...existing, ref_db_name: 'db', on_update: 'SET_NULL' });
		expect(plan.drop).toBe('ALTER TABLE `c` DROP FOREIGN KEY `fk`;');
		expect(plan.create).toBe('ALTER TABLE `c` ADD  CONSTRAINT `fk` FOREIGN KEY (`a`) REFERENCES `p`(`x`) ON DELETE CASCADE ON UPDATE NO ACTION;');
		expect(plan.recreate).toBe('# Restoring the dropped constraint...\nALTER TABLE `c` ADD  CONSTRAINT `fk` FOREIGN KEY (`a`) REFERENCES `p`(`x`) ON DELETE CASCADE ON UPDATE SET NULL;');
	});

	it('detects each changed property of an existing key', () => {
		const changes: [Partial<ForeignKeyRow>, ExistingForeignKey][] = [
			[{ foreignDb: 'other' }, existing],
			[{ foreignTable: 'q' }, existing],
			[{ constraintName: 'fk2' }, existing],
			[{ onDelete: 'RESTRICT' }, existing],
			[{}, { ...existing, ref_db_name: 'other', ref_table_name: undefined, index_list: undefined, ref_index_list: undefined }],
		];
		for (const [change, key] of changes) {
			expect(planForeignKeyUpdate('c', 'db', row(change), key).drop).toBe('ALTER TABLE `c` DROP FOREIGN KEY `fk`;');
		}
	});

	it('treats missing parts of an existing key as empty and skips unknown actions', () => {
		const partial: ExistingForeignKey[] = [
			{ constraint: 'fk', ref_table_name: 'p' },
			{ constraint: 'fk', ref_table_name: 'p', ref_index_list: ['x'] },
			{ ref_table_name: 'p', ref_index_list: ['x'], index_list: ['a'] },
		];
		for (const key of partial) {
			const plan = planForeignKeyUpdate('c', 'db', row({ onUpdate: 'bogus' }), key);
			expect(plan.create).not.toContain('ON UPDATE');
			expect(plan.recreate).not.toBeNull();
		}
	});

	it('compares column lists by key and value', () => {
		expect(planForeignKeyUpdate('c', 'db', row({ fields: new Map([['0', 'a'], ['1', 'b']]), foreignFields: new Map([['0', 'x'], ['1', 'y']]) }), existing).drop).not.toBeNull();
		expect(planForeignKeyUpdate('c', 'db', row({ fields: new Map([['1', 'a']]), foreignFields: new Map([['1', 'x']]) }), existing).drop).not.toBeNull();
	});

	it('drops a key whose row was cleared and ignores half-filled rows', () => {
		expect(planForeignKeyUpdate('c', 'db', row({ foreignTable: '' }), existing)).toMatchObject({ drop: 'ALTER TABLE `c` DROP FOREIGN KEY `fk`;', create: null });
		expect(planForeignKeyUpdate('c', 'db', row({ foreignFields: new Map([['0', '']]) }), undefined)).toMatchObject({ drop: null, create: null });
		expect(planForeignKeyUpdate('c', 'db', row({ fields: new Map([['0', '']]) }), undefined)).toMatchObject({ drop: null, create: null });
	});

	it('removes rows where both columns are empty before building the key', () => {
		const plan = planForeignKeyUpdate('c', 'db', row({ fields: new Map([['0', 'a'], ['1', '']]), foreignFields: new Map([['0', 'x']]) }), undefined);
		expect(plan.fields).toEqual(['a']);
		expect(plan.create).toContain('FOREIGN KEY (`a`) REFERENCES `p`(`x`)');
	});

	it('reads defaults for a sparse existing key and unknown actions', () => {
		const plan = planForeignKeyUpdate('c', 'db', row({ onDelete: 'bogus' }), {});
		expect(plan.drop).toBe('ALTER TABLE `c` DROP FOREIGN KEY ;');
		expect(plan.create).toBe('ALTER TABLE `c` ADD  CONSTRAINT `fk` FOREIGN KEY (`a`) REFERENCES `p`(`x`) ON UPDATE RESTRICT;');
		expect(plan.recreate).toBe('# Restoring the dropped constraint...\nALTER TABLE `c` ADD  FOREIGN KEY () REFERENCES ();');
	});
});

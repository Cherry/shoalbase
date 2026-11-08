import { describe, expect, it } from 'vitest';

import { generateAlter, generateFieldSpec, getCharsetQueryPart } from './field-spec.ts';

import type { ServerKind } from './types.ts';

const mysql8: ServerKind = { type: 'MySQL', version: 80400 };
const mysql57: ServerKind = { type: 'MySQL', version: 50744 };
const mariadb: ServerKind = { type: 'MariaDB', version: 110000 };

describe('getCharsetQueryPart', () => {
	it('derives the charset from the collation', () => {
		expect(getCharsetQueryPart('utf8mb4_general_ci')).toBe(' CHARSET=utf8mb4 COLLATE utf8mb4_general_ci');
		expect(getCharsetQueryPart('binary', true)).toBe(' CHARACTER SET binary');
	});
});

describe('generateFieldSpec', () => {
	it('builds a full column definition', () => {
		expect(generateFieldSpec({
			name: 'title',
			type: 'VARCHAR',
			length: '60',
			collation: 'utf8mb4_general_ci',
			nullable: 'NO',
			defaultType: 'USER_DEFINED',
			defaultValue: 'it\'s',
			comment: 'c\'1',
			moveTo: 'id',
		}, mysql8)).toBe('`title` VARCHAR(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT \'it\\\'s\' COMMENT \'c\\\'1\' AFTER `id`');
	});

	it('drops integer display widths on MySQL 8.0.18+ except TINYINT(1)', () => {
		expect(generateFieldSpec({ name: 'a', type: 'INT', length: '11' }, mysql8)).toBe('`a` INT DEFAULT \'\'');
		expect(generateFieldSpec({ name: 'a', type: 'INT', length: '11', defaultType: 'NONE' }, mysql57)).toBe('`a` INT(11)');
		expect(generateFieldSpec({ name: 'a', type: 'TINYINT', length: '1', defaultType: 'NONE' }, mysql8)).toBe('`a` TINYINT(1)');
		expect(generateFieldSpec({ name: 'a', type: 'TEXT', length: '10', defaultType: 'NONE' }, mysql8)).toBe('`a` TEXT');
	});

	it('writes timestamp defaults and fractional seconds', () => {
		expect(generateFieldSpec({ name: 't', type: 'TIMESTAMP', defaultValue: '0' }, mysql8)).toBe('`t` TIMESTAMP DEFAULT 0');
		expect(generateFieldSpec({ name: 't', type: 'TIMESTAMP', defaultValue: '\'2020-01-02 03:04:05.123\'' }, mysql8)).toBe('`t` TIMESTAMP DEFAULT \'2020-01-02 03:04:05.123\'');
		expect(generateFieldSpec({ name: 't', type: 'TIMESTAMP', length: '3', defaultType: 'CURRENT_TIMESTAMP', attribute: 'on update CURRENT_TIMESTAMP' }, mysql8))
			.toBe('`t` TIMESTAMP(3) on update CURRENT_TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3)');
		expect(generateFieldSpec({ name: 'd', type: 'DATETIME', length: '2', defaultType: 'current_timestamp()' }, mariadb)).toBe('`d` DATETIME(2) DEFAULT current_timestamp()');
	});

	it('formats BIT, BOOLEAN and binary defaults', () => {
		expect(generateFieldSpec({ name: 'b', type: 'BIT', length: '3', defaultValue: '1x1' }, mysql8)).toBe('`b` BIT(3) DEFAULT b\'101\'');
		expect(generateFieldSpec({ name: 'b', type: 'BOOLEAN', defaultValue: 'yes' }, mysql8)).toBe('`b` BOOLEAN DEFAULT TRUE');
		expect(generateFieldSpec({ name: 'b', type: 'BOOLEAN', defaultValue: 'false' }, mysql8)).toBe('`b` BOOLEAN DEFAULT FALSE');
		expect(generateFieldSpec({ name: 'b', type: 'BOOLEAN', defaultValue: 'maybe' }, mysql8)).toBe('`b` BOOLEAN DEFAULT \'maybe\'');
		expect(generateFieldSpec({ name: 'v', type: 'VARBINARY', length: '4', defaultValue: 'ABCD' }, mysql8)).toBe('`v` VARBINARY(4) DEFAULT 0xABCD');
	});

	it('writes DEFAULT NULL only while the column stays nullable', () => {
		expect(generateFieldSpec({ name: 'n', type: 'INT', nullable: 'YES', defaultType: 'NULL' }, mysql8)).toBe('`n` INT NULL DEFAULT NULL');
		expect(generateFieldSpec({ name: 'n', type: 'INT', defaultType: 'NULL' }, mysql8)).toBe('`n` INT DEFAULT NULL');
		expect(generateFieldSpec({ name: 'n', type: 'INT', nullable: 'NO', defaultType: 'NULL' }, mysql8)).toBe('`n` INT NOT NULL');
	});

	it('writes UUID defaults and ignores unknown default types', () => {
		expect(generateFieldSpec({ name: 'u', type: 'UUID', defaultType: 'uuid()' }, mariadb)).toBe('`u` UUID DEFAULT uuid()');
		expect(generateFieldSpec({ name: 'u', type: 'UUID', defaultType: 'UUID' }, mariadb)).toBe('`u` UUID DEFAULT uuid()');
		expect(generateFieldSpec({ name: 'u', type: 'INT', defaultType: 'OTHER' }, mysql8)).toBe('`u` INT');
	});

	it('writes a non-timestamp attribute without repeating the length', () => {
		expect(generateFieldSpec({ name: 'a', type: 'INT', length: '11', attribute: 'UNSIGNED', defaultType: 'NONE' }, mysql57)).toBe('`a` INT(11) UNSIGNED');
	});

	it('builds virtual columns, which MariaDB writes without nullability or extra', () => {
		const spec = { name: 'v', type: 'VARCHAR', length: '5', collation: 'utf8mb4_bin', nullable: 'YES', virtuality: 'VIRTUAL', expression: 'concat(a)', extra: 'AUTO_INCREMENT UNIQUE' };
		expect(generateFieldSpec(spec, mysql8)).toBe('`v` VARCHAR(5) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin AS (concat(a)) VIRTUAL NULL UNIQUE');
		expect(generateFieldSpec(spec, mariadb)).toBe('`v` VARCHAR(5) CHARACTER SET utf8mb4 AS (concat(a)) VIRTUAL');
		// Upstream's $expression defaults to '', leaving an empty generation expression.
		expect(generateFieldSpec({ name: 'v', type: 'INT', virtuality: 'STORED' }, mariadb)).toBe('`v` INT AS () STORED');
	});

	it('moves the column first and skips a NULL collation', () => {
		expect(generateFieldSpec({ name: 'f', type: 'CHAR', collation: 'NULL', defaultType: 'NONE', moveTo: '-first' }, mysql8)).toBe('`f` CHAR FIRST');
	});

	it('adds a primary key for a new AUTO_INCREMENT column without an index', () => {
		expect(generateFieldSpec({ name: 'id', type: 'INT', defaultType: 'NONE', extra: 'AUTO_INCREMENT', columnsWithIndex: ['other'] }, mysql8)).toBe('`id` INT AUTO_INCREMENT, ADD PRIMARY KEY (`id`)');
		expect(generateFieldSpec({ name: 'id', type: 'INT', defaultType: 'NONE', extra: 'AUTO_INCREMENT', columnsWithIndex: ['id'] }, mysql8)).toBe('`id` INT AUTO_INCREMENT');
	});
});

describe('generateAlter', () => {
	it('prefixes the old name and checks its index', () => {
		expect(generateAlter('old', { name: 'new', type: 'INT', defaultType: 'NONE', extra: 'AUTO_INCREMENT', columnsWithIndex: ['old'] }, mysql8)).toBe('`old` `new` INT AUTO_INCREMENT');
	});
});

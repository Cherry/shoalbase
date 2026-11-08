import { describe, expect, it } from 'vitest';

import {
	databaseChildCountQuery,
	databaseChildListQuery,
	databaseCountQuery,
	databaseListQuery,
	databasePositionQuery,
	databaseWhereClause,
	indexListQuery,
	pageIndexNames,
	tableChildCountQuery,
	tableChildListQuery,
} from './navigation-sql.ts';

describe('database list queries', () => {
	it('filters schema names with an escaped LIKE', () => {
		expect(databaseWhereClause('')).toBe('WHERE TRUE ');
		expect(databaseWhereClause('o\'k')).toBe('WHERE TRUE AND `SCHEMA_NAME` LIKE \'%o\\\'k%\' ');
	});

	it('pages whole first-level groups of databases', () => {
		expect(databaseListQuery('_', '', 100, 100)).toBe(
			'SELECT `SCHEMA_NAME` FROM `INFORMATION_SCHEMA`.`SCHEMATA`, (SELECT DB_first_level FROM ( SELECT DISTINCT SUBSTRING_INDEX(SCHEMA_NAME, \'_\', 1) DB_first_level'
			+ ' FROM INFORMATION_SCHEMA.SCHEMATA WHERE TRUE ) t ORDER BY DB_first_level ASC LIMIT 100, 100) t2 WHERE TRUE AND 1 = LOCATE(CONCAT(DB_first_level, \'_\'),'
			+ ' CONCAT(SCHEMA_NAME, \'_\')) ORDER BY SCHEMA_NAME ASC',
		);
	});

	it('counts first-level groups, leaving the separator unescaped like upstream', () => {
		expect(databaseCountQuery('\'', 'cust')).toBe('SELECT COUNT(*) FROM ( SELECT DISTINCT SUBSTRING_INDEX(SCHEMA_NAME, \'\'\', 1) DB_first_level FROM INFORMATION_SCHEMA.SCHEMATA WHERE TRUE AND `SCHEMA_NAME` LIKE \'%cust%\' ) t ');
	});

	it('finds the page of the current database', () => {
		expect(databasePositionQuery('_', 100, 'customer_db')).toBe('SELECT (COUNT(DB_first_level) DIV 100) * 100 from (  SELECT distinct SUBSTRING_INDEX(SCHEMA_NAME,  \'_\', 1)  DB_first_level  FROM INFORMATION_SCHEMA.SCHEMATA  WHERE `SCHEMA_NAME` < \'customer_db\' ) t ');
	});
});

describe('database child queries', () => {
	it('counts tables and views by table type', () => {
		expect(databaseChildCountQuery('tables', 'db', '', '')).toBe('SELECT COUNT(*) FROM `INFORMATION_SCHEMA`.`TABLES` WHERE `TABLE_SCHEMA`=\'db\' AND `TABLE_TYPE` IN(\'BASE TABLE\', \'SYSTEM VERSIONED\') ');
		expect(databaseChildCountQuery('views', 'db', '', 'v')).toBe('SELECT COUNT(*) FROM `INFORMATION_SCHEMA`.`TABLES` WHERE `TABLE_SCHEMA`=\'db\' AND `TABLE_TYPE` NOT IN(\'BASE TABLE\', \'SYSTEM VERSIONED\') AND `TABLE_NAME` LIKE \'%v%\'');
	});

	it('checks one known table by exact name when asked for a single item', () => {
		expect(databaseChildCountQuery('tables', 'db', '', 'players', true)).toContain('AND `TABLE_NAME` = \'players\'');
	});

	it('counts routines and events with the information_schema collation', () => {
		expect(databaseChildCountQuery('procedures', 'db', 'COLLATE utf8_bin', '')).toBe('SELECT COUNT(*) FROM `INFORMATION_SCHEMA`.`ROUTINES` WHERE `ROUTINE_SCHEMA` COLLATE utf8_bin=\'db\'AND `ROUTINE_TYPE`=\'PROCEDURE\' ');
		expect(databaseChildCountQuery('functions', 'db', '', 'f')).toBe('SELECT COUNT(*) FROM `INFORMATION_SCHEMA`.`ROUTINES` WHERE `ROUTINE_SCHEMA` =\'db\' AND `ROUTINE_TYPE`=\'FUNCTION\' AND `ROUTINE_NAME` LIKE \'%f%\'');
		expect(databaseChildCountQuery('events', 'db', '', 'e')).toBe('SELECT COUNT(*) FROM `INFORMATION_SCHEMA`.`EVENTS` WHERE `EVENT_SCHEMA` =\'db\' AND `EVENT_NAME` LIKE \'%e%\'');
	});

	it('lists names ordered by name, with an optional filter', () => {
		expect(databaseChildListQuery('tables', 'db', '', 'pl')).toBe('SELECT `TABLE_NAME` AS `name` FROM `INFORMATION_SCHEMA`.`TABLES` WHERE `TABLE_SCHEMA`=\'db\' AND `TABLE_TYPE` IN(\'BASE TABLE\', \'SYSTEM VERSIONED\') AND `TABLE_NAME` LIKE \'%pl%\'ORDER BY `TABLE_NAME` ASC ');
		expect(databaseChildListQuery('views', 'db', '', '')).toContain('NOT IN(');
		expect(databaseChildListQuery('procedures', 'db', '', '')).toBe('SELECT `ROUTINE_NAME` AS `name` FROM `INFORMATION_SCHEMA`.`ROUTINES` WHERE `ROUTINE_SCHEMA` =\'db\'AND `ROUTINE_TYPE`=\'PROCEDURE\' ORDER BY `ROUTINE_NAME` ASC ');
		expect(databaseChildListQuery('functions', 'db', '', '')).toContain('`ROUTINE_TYPE`=\'FUNCTION\' ');
		expect(databaseChildListQuery('events', 'db', 'COLLATE utf8_bin', '')).toBe('SELECT `EVENT_NAME` AS `name` FROM `INFORMATION_SCHEMA`.`EVENTS` WHERE `EVENT_SCHEMA` COLLATE utf8_bin=\'db\' ORDER BY `EVENT_NAME` ASC ');
	});
});

describe('table child queries', () => {
	it('counts columns, indexes and triggers', () => {
		expect(tableChildCountQuery('columns', 'db', 't\'1', '')).toBe('SELECT COUNT(*) FROM `INFORMATION_SCHEMA`.`COLUMNS` WHERE `TABLE_NAME`=\'t\\\'1\' AND `TABLE_SCHEMA`=\'db\'');
		expect(tableChildCountQuery('indexes', 'd`b', 't', '')).toBe('SHOW INDEXES FROM `t` FROM `d``b`');
		expect(tableChildCountQuery('triggers', 'db', 't', '')).toBe('SELECT COUNT(*) FROM `INFORMATION_SCHEMA`.`TRIGGERS` WHERE `EVENT_OBJECT_SCHEMA` =\'db\' AND `EVENT_OBJECT_TABLE` =\'t\'');
		expect(indexListQuery('db', 't')).toBe('SHOW INDEXES FROM `t` FROM `db`');
	});

	it('pages columns and triggers in SQL', () => {
		expect(tableChildListQuery('columns', 'db', 't', '', 50, 50)).toBe(
			'SELECT `COLUMN_NAME` AS `name` ,`COLUMN_KEY` AS `key` ,`DATA_TYPE` AS `type` ,`COLUMN_DEFAULT` AS `default` ,IF (`IS_NULLABLE` = \'NO\', \'\', \'nullable\') AS `nullable` '
			+ 'FROM `INFORMATION_SCHEMA`.`COLUMNS` WHERE `TABLE_NAME`=\'t\' AND `TABLE_SCHEMA`=\'db\' ORDER BY `COLUMN_NAME` ASC LIMIT 50, 50',
		);
		expect(tableChildListQuery('triggers', 'db', 't', '', 0, 50)).toBe('SELECT `TRIGGER_NAME` AS `name` FROM `INFORMATION_SCHEMA`.`TRIGGERS` WHERE `EVENT_OBJECT_SCHEMA` =\'db\' AND `EVENT_OBJECT_TABLE` =\'t\' ORDER BY `TRIGGER_NAME` ASC LIMIT 0, 50');
	});

	it('pages distinct index names, one row per indexed column', () => {
		const rows = ['PRIMARY', 'idx', 'idx', 'u1', 'u2'];
		expect(pageIndexNames(rows, 0, 50)).toEqual(['PRIMARY', 'idx', 'u1', 'u2']);
		expect(pageIndexNames(rows, 1, 2)).toEqual(['idx', 'u1']);
	});
});

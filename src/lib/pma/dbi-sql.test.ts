import { describe, expect, it } from 'vitest';

import {
	type DbiRow,
	currentDatabaseAndTable,
	escapeMysqlLikeString,
	escapeString,
	formatError,
	getCollateForIS,
	getColumnsSql,
	getISCompatForGetTablesFull,
	getInformationSchemaColumnsFullRequest,
	getInformationSchemaDataForCreateRequest,
	getInformationSchemaDataForGranteeRequest,
	getInformationSchemaDatabasesFullRequest,
	getSqlForTablesFull,
	getSystemSchemas,
	getTableCondition,
	getTableIndexesSql,
	isSystemSchema,
	parseServerVersion,
	usortComparison,
	validIdentifier,
	versionToInt,
} from './dbi-sql.ts';

const routeUrl = (route: string): string => `index.php?route=${route}`;

// Expected SQL was produced by phpMyAdmin 5.2.3's Query\Generator in the oracle container.
describe(String.raw`Query\Generator SQL`, () => {
	const collate = getCollateForIS('0');

	it('builds table conditions', () => {
		expect(getTableCondition(['a', 'b'], false, null, collate)).toBe('AND t.`TABLE_NAME` COLLATE utf8_bin IN (\'a\', \'b\')');
		expect(getTableCondition('t_1', true, 'view', collate)).toBe('AND t.`TABLE_NAME` LIKE \'t\\_1%\' AND t.`TABLE_TYPE` NOT IN (\'BASE TABLE\', \'SYSTEM VERSIONED\')');
		expect(getTableCondition('players', false, 'table', collate)).toBe('AND t.`TABLE_NAME` COLLATE utf8_bin = \'players\' AND t.`TABLE_TYPE` IN (\'BASE TABLE\', \'SYSTEM VERSIONED\')');
		expect(getTableCondition('', false, null, collate)).toBe('');
		// PHP treats "0" and an empty list as no filter.
		expect(getTableCondition('0', false, null, collate)).toBe('');
		expect(getTableCondition([], false, null, collate)).toBe('');
	});

	it('builds the getTablesFull() query', () => {
		expect(getSqlForTablesFull(['customer_db'], '', collate)).toBe('SELECT *, `TABLE_SCHEMA`       AS `Db`, `TABLE_NAME`         AS `Name`, `TABLE_TYPE`         AS `TABLE_TYPE`, `ENGINE`             AS `Engine`, `ENGINE`             AS `Type`, `VERSION`            AS `Version`, `ROW_FORMAT`         AS `Row_format`, `TABLE_ROWS`         AS `Rows`, `AVG_ROW_LENGTH`     AS `Avg_row_length`, `DATA_LENGTH`        AS `Data_length`, `MAX_DATA_LENGTH`    AS `Max_data_length`, `INDEX_LENGTH`       AS `Index_length`, `DATA_FREE`          AS `Data_free`, `AUTO_INCREMENT`     AS `Auto_increment`, `CREATE_TIME`        AS `Create_time`, `UPDATE_TIME`        AS `Update_time`, `CHECK_TIME`         AS `Check_time`, `TABLE_COLLATION`    AS `Collation`, `CHECKSUM`           AS `Checksum`, `CREATE_OPTIONS`     AS `Create_options`, `TABLE_COMMENT`      AS `Comment` FROM `information_schema`.`TABLES` t WHERE `TABLE_SCHEMA` COLLATE utf8_bin IN (\'customer_db\') ');
	});

	it('builds index and column queries', () => {
		expect(getTableIndexesSql('d', 't', 'Key_name = "PRIMARY"')).toBe('SHOW INDEXES FROM `d`.`t` WHERE (Key_name = "PRIMARY")');
		expect(getTableIndexesSql('d', 't')).toBe('SHOW INDEXES FROM `d`.`t`');
		expect(getColumnsSql('d', 'my`t')).toBe('SHOW  COLUMNS FROM `d`.`my``t`');
		expect(getColumnsSql('d', 't', 'c%', true)).toBe('SHOW FULL COLUMNS FROM `d`.`t` LIKE \'c%\'');
	});

	it('builds the privilege probes', () => {
		expect(getInformationSchemaDataForCreateRequest('customer', '%', 'utf8mb4_0900_ai_ci')).toBe('SELECT 1 FROM `INFORMATION_SCHEMA`.`USER_PRIVILEGES` WHERE `PRIVILEGE_TYPE` = \'CREATE USER\' AND \'\'\'customer\'\'@\'\'%\'\'\' LIKE `GRANTEE` UNION SELECT 1 FROM mysql.user WHERE `create_user_priv` = \'Y\' COLLATE utf8mb4_0900_ai_ci AND \'customer\' LIKE `User` AND \'\' LIKE `Host` LIMIT 1');
		expect(getInformationSchemaDataForGranteeRequest('customer', '%', 'utf8mb4_0900_ai_ci')).toBe('SELECT 1 FROM (SELECT `GRANTEE`, `IS_GRANTABLE` FROM `INFORMATION_SCHEMA`.`COLUMN_PRIVILEGES` UNION SELECT `GRANTEE`, `IS_GRANTABLE` FROM `INFORMATION_SCHEMA`.`TABLE_PRIVILEGES` UNION SELECT `GRANTEE`, `IS_GRANTABLE` FROM `INFORMATION_SCHEMA`.`SCHEMA_PRIVILEGES` UNION SELECT `GRANTEE`, `IS_GRANTABLE` FROM `INFORMATION_SCHEMA`.`USER_PRIVILEGES`) t WHERE `IS_GRANTABLE` = \'YES\' AND \'\'\'customer\'\'@\'\'%\'\'\' LIKE `GRANTEE`  UNION SELECT 1 FROM mysql.user WHERE `create_user_priv` = \'Y\' COLLATE utf8mb4_0900_ai_ci AND \'customer\' LIKE `User` AND \'\' LIKE `Host` LIMIT 1');
	});

	it('builds the databases query, including the missing space upstream leaves before WHERE', () => {
		expect(getInformationSchemaDatabasesFullRequest(true, 'WHERE `SCHEMA_NAME` LIKE \'x\'', 'SCHEMA_NAME', 'ASC', ' LIMIT 5 OFFSET 0')).toBe('SELECT *, CAST(BIN_NAME AS CHAR CHARACTER SET utf8) AS SCHEMA_NAME FROM (SELECT BINARY s.SCHEMA_NAME AS BIN_NAME, s.DEFAULT_COLLATION_NAME, COUNT(t.TABLE_SCHEMA)  AS SCHEMA_TABLES, SUM(t.TABLE_ROWS)      AS SCHEMA_TABLE_ROWS, SUM(t.DATA_LENGTH)     AS SCHEMA_DATA_LENGTH, SUM(t.MAX_DATA_LENGTH) AS SCHEMA_MAX_DATA_LENGTH, SUM(t.INDEX_LENGTH)    AS SCHEMA_INDEX_LENGTH, SUM(t.DATA_LENGTH + t.INDEX_LENGTH) AS SCHEMA_LENGTH, SUM(IF(t.ENGINE <> \'InnoDB\', t.DATA_FREE, 0)) AS SCHEMA_DATA_FREE FROM `information_schema`.SCHEMATA s  LEFT JOIN `information_schema`.TABLES t ON BINARY t.TABLE_SCHEMA = BINARY s.SCHEMA_NAMEWHERE `SCHEMA_NAME` LIKE \'x\' GROUP BY BINARY s.SCHEMA_NAME, s.DEFAULT_COLLATION_NAME ORDER BY BINARY `SCHEMA_NAME` ASC LIMIT 5 OFFSET 0) a');
		expect(getInformationSchemaDatabasesFullRequest(false, '', 'SCHEMA_TABLES', 'DESC', '')).toBe('SELECT *, CAST(BIN_NAME AS CHAR CHARACTER SET utf8) AS SCHEMA_NAME FROM (SELECT BINARY s.SCHEMA_NAME AS BIN_NAME, s.DEFAULT_COLLATION_NAME FROM `information_schema`.SCHEMATA s  GROUP BY BINARY s.SCHEMA_NAME, s.DEFAULT_COLLATION_NAME ORDER BY `SCHEMA_TABLES` DESC) a');
	});

	it('builds the information_schema columns query with the unfiltered parts as result keys', () => {
		expect(getInformationSchemaColumnsFullRequest('d', null, null)).toEqual([
			'SELECT *, `COLUMN_NAME`       AS `Field`, `COLUMN_TYPE`       AS `Type`, `COLLATION_NAME`    AS `Collation`, `IS_NULLABLE`       AS `Null`, `COLUMN_KEY`        AS `Key`, `COLUMN_DEFAULT`    AS `Default`, `EXTRA`             AS `Extra`, `PRIVILEGES`        AS `Privileges`, `COLUMN_COMMENT`    AS `Comment` FROM `information_schema`.`COLUMNS`\n WHERE `TABLE_SCHEMA` = \'d\' ',
			['TABLE_NAME', 'COLUMN_NAME'],
		]);
		const [unfiltered, keys] = getInformationSchemaColumnsFullRequest(null, null, null);
		expect(unfiltered.endsWith('FROM `information_schema`.`COLUMNS`')).toBe(true);
		expect(keys).toEqual(['TABLE_SCHEMA', 'TABLE_NAME', 'COLUMN_NAME']);
		expect(getInformationSchemaColumnsFullRequest('d', 't', 'c')[0]).toContain('WHERE `TABLE_SCHEMA` = \'d\'  AND `TABLE_NAME` = \'t\'  AND `COLUMN_NAME` = \'c\' ');
	});

	it('picks the information_schema collation from lower_case_table_names', () => {
		expect(getCollateForIS('2')).toBe('COLLATE utf8_general_ci');
		expect(getCollateForIS('1')).toBe('');
	});
});

describe(String.raw`Query\Utilities`, () => {
	it('formats driver errors like upstream', () => {
		expect(formatError(1045, 'Access denied for user \'x\'@\'y\' <b>', routeUrl)).toBe('#1045 - Access denied for user &#039;x&#039;@&#039;y&#039; &lt;b&gt;');
		expect(formatError(2002, 'No such file', routeUrl)).toBe('#2002 - No such file &mdash; The server is not responding (or the local server\'s socket is not correctly configured).');
		expect(formatError(2003, 'Refused', routeUrl)).toBe('#2003 - Refused &mdash; The server is not responding.');
		expect(formatError(1005, 'Can\'t create (errno: 13)', routeUrl)).toBe('#1005 - Can&#039;t create (errno: 13) &mdash; Please check privileges of directory containing database.');
		expect(formatError(1005, 'Can\'t create', routeUrl)).toBe('#1005 - Can&#039;t create (<a href="index.php?route=/server/engines/InnoDB/Status">Details…</a>)');
		expect(formatError(1698, 'Denied', routeUrl)).toBe('#1698 - Denied &mdash; <a href="index.php?route=/logout" class="disableAjax">Logout and try as another user.</a>');
	});

	it('turns version strings into numbers', () => {
		expect(versionToInt('8.4.13')).toBe(80413);
		expect(versionToInt('10.11.6-MariaDB-1:10.11.6+maria~ubu2204')).toBe(101106);
		expect(versionToInt('5.7.44-log')).toBe(50744);
		expect(versionToInt('')).toBe(0);
	});

	it('reads the server flavour from the version row', () => {
		expect(parseServerVersion({ '@@version': '10.11.6-MariaDB', '@@version_comment': 'mariadb.org binary distribution' })).toEqual({
			versionString: '10.11.6-MariaDB',
			versionInt: 101106,
			versionComment: 'mariadb.org binary distribution',
			isMariaDb: true,
			isPercona: false,
		});
		expect(parseServerVersion({ '@@version': '8.0.36-28', '@@version_comment': 'Percona Server (GPL)' })).toMatchObject({ isMariaDb: false, isPercona: true });
		expect(parseServerVersion(null)).toMatchObject({ versionString: '', versionInt: 0, versionComment: '' });
	});

	it('recognises system schemas', () => {
		expect(isSystemSchema('INFORMATION_SCHEMA')).toBe(true);
		expect(isSystemSchema('sys')).toBe(true);
		expect(isSystemSchema('performance_schema')).toBe(true);
		expect(isSystemSchema('mysql')).toBe(false);
		expect(isSystemSchema('mysql', true)).toBe(true);
		expect(isSystemSchema('customer_db', true)).toBe(false);
		expect(getSystemSchemas()).toEqual(['information_schema', 'performance_schema', 'mysql', 'sys']);
	});

	it('sorts rows naturally or case-insensitively and leaves rows without the key in place', () => {
		const rows = [{ SCHEMA_NAME: 'db10' }, { SCHEMA_NAME: 'DB9' }, { SCHEMA_NAME: 'db1' }];
		expect(rows.toSorted((first, second) => usortComparison(first, second, 'SCHEMA_NAME', 'ASC', true)).map(row => row.SCHEMA_NAME)).toEqual(['db1', 'DB9', 'db10']);
		expect(rows.toSorted((first, second) => usortComparison(first, second, 'SCHEMA_NAME', 'DESC', false)).map(row => row.SCHEMA_NAME)).toEqual(['DB9', 'db10', 'db1']);
		expect(usortComparison({ a: null }, { a: 'x' }, 'a', 'ASC', true)).toBe(0);
	});
});

describe('escaping', () => {
	it('escapes like mysqli::real_escape_string()', () => {
		expect(escapeString('a\'b"c\\d\0e\nf\rg\u{1A}h')).toBe(String.raw`a\'b\"c\\d\0e\nf\rg\Zh`);
	});

	it('escapes LIKE wildcards before the string', () => {
		expect(escapeMysqlLikeString(String.raw`a_b%c\d'`)).toBe(String.raw`a\\_b\\%c\\\\d\'`);
	});
});

describe('Compatibility::getISCompatForGetTablesFull', () => {
	it('adds information_schema names to SHOW TABLE STATUS rows', () => {
		const status = new Map<string, DbiRow>([
			['t', { Name: 't', Engine: 'InnoDB', Rows: '3', Comment: '' }],
			['v', { Name: 'v', Engine: null, Comment: 'VIEW' }],
			['old', { Name: 'old', Type: 'MyISAM', Comment: null }],
		]);
		const tables = getISCompatForGetTablesFull(status, 'customer_db');
		expect(tables.get('t')).toMatchObject({ Type: 'InnoDB', TABLE_SCHEMA: 'customer_db', TABLE_NAME: 't', ENGINE: 'InnoDB', TABLE_ROWS: '3', TABLE_TYPE: 'BASE TABLE', CHECK_TIME: null });
		expect(tables.get('v')).toMatchObject({ TABLE_TYPE: 'VIEW', ENGINE: null });
		expect(tables.get('old')).toMatchObject({ Engine: 'MyISAM', ENGINE: 'MyISAM' });
		expect(getISCompatForGetTablesFull(new Map([['COLUMNS', { Name: 'COLUMNS', Engine: 'MEMORY' }]]), 'information_schema').get('COLUMNS')?.TABLE_TYPE).toBe('SYSTEM VIEW');
	});
});

describe('current database and table', () => {
	it('keeps names that DatabaseName and TableName accept', () => {
		expect(currentDatabaseAndTable('customer_db', 'players')).toEqual({ db: 'customer_db', table: 'players' });
		expect(validIdentifier('é'.repeat(64))).toBe('é'.repeat(64));
	});

	it('drops empty, too long, space-terminated and non-string names', () => {
		expect(validIdentifier('')).toBe('');
		expect(validIdentifier('x'.repeat(65))).toBe('');
		expect(validIdentifier('db ')).toBe('');
		expect(validIdentifier(['db'])).toBe('');
		expect(validIdentifier(undefined)).toBe('');
	});

	it('ignores the table without a valid database', () => {
		expect(currentDatabaseAndTable('', 'players')).toEqual({ db: '', table: '' });
		expect(currentDatabaseAndTable('customer_db', 'bad ')).toEqual({ db: 'customer_db', table: '' });
	});
});

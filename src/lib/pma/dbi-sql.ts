// Pure parts of DatabaseInterface: Query\Generator SQL, Query\Utilities, Query\Compatibility and mysqli escaping.
import { strcasecmp, strnatcasecmp } from './php-compare.ts';
import { htmlspecialchars } from '../twig/php.ts';
import { backquote, escapeMysqlWildcards } from '../twig/sanitize.ts';

/** A row as mysqli returns it: every value a string, NULL as null. */
export type DbiRow = Record<string, string | null>;

const escapes: Record<string, string> = {
	'\0': String.raw`\0`,
	'\n': String.raw`\n`,
	'\r': String.raw`\r`,
	'\\': '\\\\',
	'\'': String.raw`\'`,
	'"': String.raw`\"`,
	'\u{1A}': String.raw`\Z`,
};

/** mysqli::real_escape_string() for a utf8mb4 connection without NO_BACKSLASH_ESCAPES. */
export function escapeString(value: string): string {
	return Array.from(value, character => escapes[character] ?? character).join('');
}

/** DatabaseInterface::escapeMysqlLikeString(). */
export function escapeMysqlLikeString(value: string): string {
	return escapeString(value.replaceAll(/[\\_%]/g, character => `\\${character}`));
}

/** Utilities::formatError(); the URL builder resolves routes like Url::getFromRoute(). */
export function formatError(errorNumber: number, errorMessage: string, routeUrl: (route: string) => string): string {
	const message = htmlspecialchars(errorMessage);
	const separator = ' &mdash; ';
	let error = `#${errorNumber} - ${message}`;
	if (errorNumber === 2002) {
		error += `${separator}The server is not responding (or the local server's socket is not correctly configured).`;
	} else if (errorNumber === 2003) {
		error += `${separator}The server is not responding.`;
	} else if (errorNumber === 1698) {
		error += `${separator}<a href="${routeUrl('/logout')}" class="disableAjax">Logout and try as another user.</a>`;
	} else if (errorNumber === 1005) {
		if (errorMessage.includes('errno: 13')) {
			error += `${separator}Please check privileges of directory containing database.`;
		} else {
			error += ` (<a href="${routeUrl('/server/engines/InnoDB/Status')}">Details…</a>)`;
		}
	}
	return error;
}

/** Utilities::versionToInt(), e.g. "8.4.7" and "10.11.6-MariaDB" become 80407 and 101106. */
export function versionToInt(version: string): number {
	const [major = '', minor = '', patch = ''] = version.split('.', 3);
	const part = (value: string): number => Number.parseInt(value, 10) || 0;
	return Number(`${part(major)}${String(part(minor)).padStart(2, '0')}${String(part(patch)).padStart(2, '0')}`);
}

export interface ServerVersion {
	versionString: string;
	versionInt: number;
	versionComment: string;
	isMariaDb: boolean;
	isPercona: boolean;
}

/** DatabaseInterface::setVersion() from the `SELECT @@version, @@version_comment` row. */
export function parseServerVersion(row: DbiRow | null): ServerVersion {
	const versionString = row?.['@@version'] ?? '';
	const versionComment = row?.['@@version_comment'] ?? '';
	return {
		versionString,
		versionInt: versionToInt(versionString),
		versionComment,
		isMariaDb: versionString.toLowerCase().includes('mariadb'),
		isPercona: versionComment.toLowerCase().includes('percona'),
	};
}

/** Utilities::isSystemSchema(). */
export function isSystemSchema(schemaName: string, testForMysqlSchema = false): boolean {
	const name = schemaName.toLowerCase();
	return name === 'information_schema' || name === 'performance_schema' || name === 'sys' || (testForMysqlSchema && name === 'mysql');
}

/** Utilities::getSystemSchemas(). */
export function getSystemSchemas(): string[] {
	return ['information_schema', 'performance_schema', 'mysql', 'sys'];
}

/** Util::getCollateForIS() for the server's lower_case_table_names. */
export function getCollateForIS(lowerCaseNames: string): string {
	if (lowerCaseNames === '0') {
		return 'COLLATE utf8_bin';
	}
	if (lowerCaseNames === '2') {
		return 'COLLATE utf8_general_ci';
	}
	return '';
}

/** Generator::getTableCondition(); table names must already be escaped. */
export function getTableCondition(escapedTables: string | string[], tblIsGroup: boolean, tableType: string | null, collate: string): string {
	let where = '';
	if (Array.isArray(escapedTables) && escapedTables.length > 0) {
		where = `AND t.\`TABLE_NAME\` ${collate} IN ('${escapedTables.join('\', \'')}')`;
	} else if (typeof escapedTables === 'string' && escapedTables !== '' && escapedTables !== '0') {
		if (tblIsGroup) {
			where = `AND t.\`TABLE_NAME\` LIKE '${escapeMysqlWildcards(escapedTables)}%'`;
		} else {
			where = `AND t.\`TABLE_NAME\` ${collate} = '${escapedTables}'`;
		}
	}
	if (tableType === 'view') {
		where += ' AND t.`TABLE_TYPE` NOT IN (\'BASE TABLE\', \'SYSTEM VERSIONED\')';
	} else if (tableType === 'table') {
		where += ' AND t.`TABLE_TYPE` IN (\'BASE TABLE\', \'SYSTEM VERSIONED\')';
	}
	return where;
}

/** Generator::getSqlForTablesFull(). */
export function getSqlForTablesFull(escapedDatabases: string[], sqlWhereTable: string, collate: string): string {
	return 'SELECT *,'
		+ ' `TABLE_SCHEMA`       AS `Db`,'
		+ ' `TABLE_NAME`         AS `Name`,'
		+ ' `TABLE_TYPE`         AS `TABLE_TYPE`,'
		+ ' `ENGINE`             AS `Engine`,'
		+ ' `ENGINE`             AS `Type`,'
		+ ' `VERSION`            AS `Version`,'
		+ ' `ROW_FORMAT`         AS `Row_format`,'
		+ ' `TABLE_ROWS`         AS `Rows`,'
		+ ' `AVG_ROW_LENGTH`     AS `Avg_row_length`,'
		+ ' `DATA_LENGTH`        AS `Data_length`,'
		+ ' `MAX_DATA_LENGTH`    AS `Max_data_length`,'
		+ ' `INDEX_LENGTH`       AS `Index_length`,'
		+ ' `DATA_FREE`          AS `Data_free`,'
		+ ' `AUTO_INCREMENT`     AS `Auto_increment`,'
		+ ' `CREATE_TIME`        AS `Create_time`,'
		+ ' `UPDATE_TIME`        AS `Update_time`,'
		+ ' `CHECK_TIME`         AS `Check_time`,'
		+ ' `TABLE_COLLATION`    AS `Collation`,'
		+ ' `CHECKSUM`           AS `Checksum`,'
		+ ' `CREATE_OPTIONS`     AS `Create_options`,'
		+ ' `TABLE_COMMENT`      AS `Comment`'
		+ ' FROM `information_schema`.`TABLES` t'
		+ ` WHERE \`TABLE_SCHEMA\` ${collate}`
		+ ` IN ('${escapedDatabases.join('\', \'')}')`
		+ ` ${sqlWhereTable}`;
}

/** Generator::getTableIndexesSql(). */
export function getTableIndexesSql(database: string, table: string, where: string | null = null): string {
	let sql = `SHOW INDEXES FROM ${backquote(database)}.${backquote(table)}`;
	if (where) {
		sql += ` WHERE (${where})`;
	}
	return sql;
}

/** Generator::getColumnsSql(); note the double space upstream leaves when $full is false. */
export function getColumnsSql(database: string, table: string, escapedColumn: string | null = null, full = false): string {
	let sql = `SHOW ${full ? 'FULL' : ''} COLUMNS FROM ${backquote(database)}.${backquote(table)}`;
	if (escapedColumn !== null) {
		sql += ` LIKE '${escapedColumn}'`;
	}
	return sql;
}

/** Generator::getInformationSchemaDataForCreateRequest(). */
export function getInformationSchemaDataForCreateRequest(user: string, host: string, collation: string): string {
	return 'SELECT 1 FROM `INFORMATION_SCHEMA`.`USER_PRIVILEGES` '
		+ 'WHERE `PRIVILEGE_TYPE` = \'CREATE USER\' AND '
		+ `'''${user}''@''${host}''' LIKE \`GRANTEE\``
		+ ' UNION '
		+ 'SELECT 1 FROM mysql.user '
		+ `WHERE \`create_user_priv\` = 'Y' COLLATE ${collation} AND `
		+ `'${user}' LIKE \`User\` AND '' LIKE \`Host\``
		+ ' LIMIT 1';
}

/** Generator::getInformationSchemaDataForGranteeRequest(). */
export function getInformationSchemaDataForGranteeRequest(user: string, host: string, collation: string): string {
	return 'SELECT 1 FROM ('
		+ 'SELECT `GRANTEE`, `IS_GRANTABLE` FROM '
		+ '`INFORMATION_SCHEMA`.`COLUMN_PRIVILEGES` UNION '
		+ 'SELECT `GRANTEE`, `IS_GRANTABLE` FROM '
		+ '`INFORMATION_SCHEMA`.`TABLE_PRIVILEGES` UNION '
		+ 'SELECT `GRANTEE`, `IS_GRANTABLE` FROM '
		+ '`INFORMATION_SCHEMA`.`SCHEMA_PRIVILEGES` UNION '
		+ 'SELECT `GRANTEE`, `IS_GRANTABLE` FROM '
		+ '`INFORMATION_SCHEMA`.`USER_PRIVILEGES`) t '
		+ 'WHERE `IS_GRANTABLE` = \'YES\' AND '
		+ `'''${user}''@''${host}''' LIKE \`GRANTEE\` `
		+ ' UNION '
		+ 'SELECT 1 FROM mysql.user '
		+ `WHERE \`create_user_priv\` = 'Y' COLLATE ${collation} AND `
		+ `'${user}' LIKE \`User\` AND '' LIKE \`Host\``
		+ ' LIMIT 1';
}

/** Generator::getInformationSchemaDatabasesFullRequest(). */
export function getInformationSchemaDatabasesFullRequest(forceStats: boolean, sqlWhereSchema: string, sortBy: string, sortOrder: string, limit: string): string {
	let sql = 'SELECT *, CAST(BIN_NAME AS CHAR CHARACTER SET utf8) AS SCHEMA_NAME FROM (';
	sql += 'SELECT BINARY s.SCHEMA_NAME AS BIN_NAME, s.DEFAULT_COLLATION_NAME';
	if (forceStats) {
		sql += ','
			+ ' COUNT(t.TABLE_SCHEMA)  AS SCHEMA_TABLES,'
			+ ' SUM(t.TABLE_ROWS)      AS SCHEMA_TABLE_ROWS,'
			+ ' SUM(t.DATA_LENGTH)     AS SCHEMA_DATA_LENGTH,'
			+ ' SUM(t.MAX_DATA_LENGTH) AS SCHEMA_MAX_DATA_LENGTH,'
			+ ' SUM(t.INDEX_LENGTH)    AS SCHEMA_INDEX_LENGTH,'
			+ ' SUM(t.DATA_LENGTH + t.INDEX_LENGTH) AS SCHEMA_LENGTH,'
			+ ' SUM(IF(t.ENGINE <> \'InnoDB\', t.DATA_FREE, 0)) AS SCHEMA_DATA_FREE';
	}
	sql += ' FROM `information_schema`.SCHEMATA s ';
	if (forceStats) {
		sql += ' LEFT JOIN `information_schema`.TABLES t ON BINARY t.TABLE_SCHEMA = BINARY s.SCHEMA_NAME';
	}
	sql += `${sqlWhereSchema} GROUP BY BINARY s.SCHEMA_NAME, s.DEFAULT_COLLATION_NAME ORDER BY `;
	if (sortBy === 'SCHEMA_NAME' || sortBy === 'DEFAULT_COLLATION_NAME') {
		sql += 'BINARY ';
	}
	return `${sql}${backquote(sortBy)} ${sortOrder}${limit}) a`;
}

/** Generator::getInformationSchemaColumnsFullRequest(): the SQL and the fetchResult() key columns. */
export function getInformationSchemaColumnsFullRequest(escapedDatabase: string | null, escapedTable: string | null, escapedColumn: string | null): [string, string[]] {
	const wheres: string[] = [];
	const keys: string[] = [];
	for (const [column, value] of [['TABLE_SCHEMA', escapedDatabase], ['TABLE_NAME', escapedTable], ['COLUMN_NAME', escapedColumn]] as const) {
		if (value === null) {
			keys.push(column);
		} else {
			wheres.push(`\`${column}\` = '${value}' `);
		}
	}
	let sql = 'SELECT *,'
		+ ' `COLUMN_NAME`       AS `Field`,'
		+ ' `COLUMN_TYPE`       AS `Type`,'
		+ ' `COLLATION_NAME`    AS `Collation`,'
		+ ' `IS_NULLABLE`       AS `Null`,'
		+ ' `COLUMN_KEY`        AS `Key`,'
		+ ' `COLUMN_DEFAULT`    AS `Default`,'
		+ ' `EXTRA`             AS `Extra`,'
		+ ' `PRIVILEGES`        AS `Privileges`,'
		+ ' `COLUMN_COMMENT`    AS `Comment`'
		+ ' FROM `information_schema`.`COLUMNS`';
	if (wheres.length > 0) {
		sql += `\n WHERE ${wheres.join(' AND ')}`;
	}
	return [sql, keys];
}

// PHP's isset(): neither missing nor NULL.
const isSet = (value: string | null | undefined): value is string => value !== null && value !== undefined;

const tableAliases: [string, string][] = [
	['TABLE_NAME', 'Name'],
	['ENGINE', 'Engine'],
	['VERSION', 'Version'],
	['ROW_FORMAT', 'Row_format'],
	['TABLE_ROWS', 'Rows'],
	['AVG_ROW_LENGTH', 'Avg_row_length'],
	['DATA_LENGTH', 'Data_length'],
	['MAX_DATA_LENGTH', 'Max_data_length'],
	['INDEX_LENGTH', 'Index_length'],
	['DATA_FREE', 'Data_free'],
	['AUTO_INCREMENT', 'Auto_increment'],
	['CREATE_TIME', 'Create_time'],
	['UPDATE_TIME', 'Update_time'],
	['CHECK_TIME', 'Check_time'],
	['TABLE_COLLATION', 'Collation'],
	['CHECKSUM', 'Checksum'],
	['CREATE_OPTIONS', 'Create_options'],
	['TABLE_COMMENT', 'Comment'],
];

/** Compatibility::getISCompatForGetTablesFull(): SHOW TABLE STATUS rows with the information_schema names added. */
export function getISCompatForGetTablesFull(tables: Map<string, DbiRow>, database: string): Map<string, DbiRow> {
	const result = new Map<string, DbiRow>();
	for (const [name, status] of tables) {
		const row: DbiRow = { ...status };
		if (!isSet(row.Type) && isSet(row.Engine)) {
			row.Type = row.Engine;
		} else if (!isSet(row.Engine) && isSet(row.Type)) {
			row.Engine = row.Type;
		}
		row.TABLE_SCHEMA = database;
		for (const [alias, source] of tableAliases) {
			row[alias] = row[source] ?? null;
		}
		if ((row.Comment ?? '').toUpperCase() === 'VIEW' && !isSet(row.Engine)) {
			row.TABLE_TYPE = 'VIEW';
		} else if (database === 'information_schema') {
			row.TABLE_TYPE = 'SYSTEM VIEW';
		} else {
			row.TABLE_TYPE = 'BASE TABLE';
		}
		result.set(name, row);
	}
	return result;
}

/** Utilities::usortComparisonCallback(); rows missing the sort key compare as equal. */
export function usortComparison(first: DbiRow, second: DbiRow, sortBy: string, sortOrder: string, naturalOrder: boolean): number {
	const left = first[sortBy];
	const right = second[sortBy];
	if (!isSet(left) || !isSet(right)) {
		return 0;
	}
	const compare = naturalOrder ? strnatcasecmp(left, right) : strcasecmp(left, right);
	return (sortOrder === 'ASC' ? 1 : -1) * compare;
}

const IDENTIFIER_MAX_LENGTH = 64;

/** Dbal\DatabaseName / TableName validation as Common::setDatabaseAndTableFromRequest() applies it; invalid names become ''. */
export function validIdentifier(value: unknown): string {
	if (typeof value !== 'string' || value === '' || [...value].length > IDENTIFIER_MAX_LENGTH || value.endsWith(' ')) {
		return '';
	}
	return value;
}

/** The request's current database and table; a table is only kept alongside a valid database. */
export function currentDatabaseAndTable(db: unknown, table: unknown): { db: string; table: string; } {
	const database = validIdentifier(db);
	if (database === '') {
		return { db: '', table: '' };
	}
	return { db: database, table: validIdentifier(table) };
}

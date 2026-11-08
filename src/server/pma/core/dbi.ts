// Port of PhpMyAdmin\DatabaseInterface over the request's mysql2 connection, with mysqli's view of results:
// every value is a string or null, and binary-charset values are byte strings (one char per byte, decode with latin1).
import { getIndexesFromDbi } from './index.ts';
import {
	type DbiRow,
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
	getTableCondition,
	getTableIndexesSql,
	parseServerVersion,
	usortComparison,
} from '../../../lib/pma/dbi-sql.ts';
import { FieldMetadata, MysqlType } from '../../../lib/pma/field-metadata.ts';
import { phpCompareStrings, strnatcasecmp } from '../../../lib/pma/php-compare.ts';
import { type UserPrivileges, analyseShowGrants, unrestrictedPrivileges } from '../../../lib/pma/user-privileges.ts';
import { backquote } from '../../../lib/twig/sanitize.ts';

import type { PmaConfig } from '../../../lib/pma/config.ts';
import type { Connection, FieldPacket, ResultSetHeader } from 'mysql2/promise';

export type { DbiRow } from '../../../lib/pma/dbi-sql.ts';
export type DbiValue = string | null;

export const FETCH_ASSOC = 'ASSOC';
export const FETCH_NUM = 'NUM';

export const GETVAR_SESSION = 1;
export const GETVAR_GLOBAL = 2;

/** mysqli's errno and error after a failed statement. */
export interface DbiError {
	errno: number;
	message: string;
}

/** Thrown by query() where upstream calls Generator::mysqlDie(); the caller renders the error page. */
export class DbiQueryError extends Error {
	constructor(readonly error: DbiError, readonly formatted: string, readonly query: string) {
		super(formatted);
		this.name = 'DbiQueryError';
	}
}

const BINARY_CHARSET = 63;

// JSON arrives with the binary charset but is UTF-8 text, which PHP treats as an ordinary string.
function decodeValue(value: Buffer | null, field: FieldPacket): DbiValue {
	if (value === null) {
		return null;
	}
	// mysqlnd hands BIT columns of text-protocol results to PHP as decimal integer strings.
	if (field.columnType === MysqlType.BIT) {
		return BigInt(`0x${value.toString('hex') || '0'}`).toString();
	}
	if (field.characterSet === BINARY_CHARSET && field.columnType !== MysqlType.JSON) {
		return value.toString('latin1');
	}
	return value.toString('utf8');
}

function toFieldMetadata(field: FieldPacket): FieldMetadata {
	return new FieldMetadata(field.columnType ?? 0, field.flags as number, {
		name: field.name,
		orgname: field.orgName,
		table: field.table,
		orgtable: field.orgTable,
		charsetnr: field.characterSet ?? -1,
		decimals: field.decimals,
		length: field.columnLength ?? 0,
	});
}

/** Port of Dbal\MysqliResult: a buffered result with a read cursor. */
export class DbiResult {
	private position = 0;

	constructor(private readonly rows: DbiValue[][], private readonly fields: FieldPacket[]) {}

	private assoc(row: DbiValue[]): DbiRow {
		const result: DbiRow = {};
		for (const [index, field] of this.fields.entries()) {
			result[field.name] = row[index];
		}
		return result;
	}

	/** The next row by column name, or null after the last row (PHP's empty array). */
	fetchAssoc(): DbiRow | null {
		const row = this.rows.at(this.position);
		if (row === undefined) {
			return null;
		}
		this.position++;
		return this.assoc(row);
	}

	/** The next row by column index, or null after the last row. */
	fetchRow(): DbiValue[] | null {
		const row = this.rows.at(this.position);
		if (row === undefined) {
			return null;
		}
		this.position++;
		return [...row];
	}

	/** MysqliResult::fetchValue(): a missing row or a NULL value both give false. */
	fetchValue(field: number | string = 0): DbiValue | false {
		const row = typeof field === 'string' ? this.fetchAssoc() : this.fetchRow();
		if (row === null) {
			return false;
		}
		const value = (row as Record<string | number, DbiValue>)[field];
		return value ?? false;
	}

	/** Every row from the start, like fetch_all(MYSQLI_ASSOC). */
	fetchAllAssoc(): DbiRow[] {
		this.position = this.rows.length;
		return this.rows.map(row => this.assoc(row));
	}

	fetchAllColumn(): DbiValue[] {
		this.position = this.rows.length;
		return this.rows.map(row => row[0]);
	}

	/** First column as key, second as value. */
	fetchAllKeyPair(): Map<string, DbiValue> {
		this.position = this.rows.length;
		return new Map(this.rows.map(row => [row[0] ?? '', row[1]]));
	}

	numRows(): number {
		return this.rows.length;
	}

	numFields(): number {
		return this.fields.length;
	}

	seek(offset: number): boolean {
		if (offset < 0 || offset >= this.rows.length) {
			return false;
		}
		this.position = offset;
		return true;
	}

	getFieldsMeta(): FieldMetadata[] {
		return this.fields.map(field => toFieldMetadata(field));
	}

	getFieldNames(): string[] {
		return this.fields.map(field => field.name);
	}

	*[Symbol.iterator](): Iterator<DbiRow> {
		for (const row of this.rows) {
			yield this.assoc(row);
		}
	}
}

/** The nested shape fetchResult() builds for a list of key columns. */
export type FetchResultTree<T> = Map<string, FetchResultTree<T> | T> | (FetchResultTree<T> | T)[];

export interface DatabaseInterfaceOptions {
	connect: () => Promise<Connection>;
	config: PmaConfig;
	/** Url::getFromRoute() for links inside formatted errors. */
	routeUrl: (route: string) => string;
	/** Language::getMySQLLocale() for SET lc_messages; English is en_US. */
	mysqlLocale?: string;
	/** SessionCache for the current server: values upstream keeps in $_SESSION['cache'] between requests. */
	sessionCache?: { get(name: string): unknown; set(name: string, value: unknown): void; };
}

interface QueryOutcome {
	rows: DbiValue[][];
	fields: FieldPacket[];
	affectedRows: number;
	warningCount: number;
}

const mysqlError = (error: unknown): DbiError | null => {
	const candidate = error as { errno?: unknown; sqlMessage?: unknown; };
	if (typeof candidate.errno === 'number' && typeof candidate.sqlMessage === 'string') {
		return { errno: candidate.errno, message: candidate.sqlMessage };
	}
	return null;
};

/** DatabaseInterface for one request; the per-session caches upstream keeps (SessionCache) live for the request only. */
export class DatabaseInterface {
	private connection: Connection | undefined;
	private connecting: Promise<Connection> | undefined;
	private ready = false;
	private lastError: DbiError | null = null;
	private cachedAffectedRows = -1;
	private lastWarningCount = 0;
	private versionString = '';
	private versionInt = 0;
	private versionComment = '';
	private mariaDb = false;
	private percona = false;
	private lowerCaseTableNames: string | undefined;
	private currentUser: string | undefined;
	private currentRoles: string[] | undefined;
	private readonly memo = new Map<string, Promise<unknown>>();
	private readonly tableCache = new Map<string, Map<string, DbiRow>>();
	/** $GLOBALS['collation_connection'] after postConnect(). */
	collationConnection = '';
	/** $GLOBALS['charset_connection'] after postConnect(). */
	charsetConnection = '';

	constructor(private readonly options: DatabaseInterfaceOptions) {}

	private async openAndPostConnect(): Promise<Connection> {
		this.connection = await this.options.connect();
		await this.postConnect();
		this.ready = true;
		return this.connection;
	}

	/** DatabaseInterface::postConnect(): version detection, connection charset and message locale. */
	private async postConnect(): Promise<void> {
		const version = parseServerVersion(await this.fetchSingleRow('SELECT @@version, @@version_comment'));
		this.versionString = version.versionString;
		this.versionInt = version.versionInt;
		this.versionComment = version.versionComment;
		this.mariaDb = version.isMariaDb;
		this.percona = version.isPercona;
		let charset = 'utf8';
		let collation = 'utf8_general_ci';
		if (this.versionInt > 50503) {
			charset = 'utf8mb4';
			collation = 'utf8mb4_general_ci';
		}
		this.collationConnection = collation;
		this.charsetConnection = charset;
		await this.query(`SET NAMES '${charset}' COLLATE '${collation}';`);
		await this.tryQuery(`SET lc_messages = '${this.options.mysqlLocale ?? 'en_US'}';`);
		const timeZone = this.options.config.Server.SessionTimeZone;
		if (timeZone !== '') {
			await this.tryQuery(`SET ${backquote('time_zone')} = '${escapeString(timeZone)}'`);
		}
		// Config::loadUserPreferences() ends with setConnectionCollation() right after the link is up.
		const preferred = this.options.config.DefaultConnectionCollation;
		if (preferred !== '' && preferred !== this.collationConnection) {
			await this.setCollation(preferred);
		}
	}

	private async link(): Promise<Connection> {
		// postConnect() runs its own statements on the fresh link before connect() resolves, so it must not wait for itself.
		if (this.connection === undefined || this.ready) {
			await this.connect();
		}
		return this.connection as Connection;
	}

	/** DatabaseInterface::attachIndexInfoToColumns(): later columns of a multi-column index get a Key too. */
	private async attachIndexInfoToColumns(database: string, table: string, fields: Map<string, DbiRow>): Promise<Map<string, DbiRow>> {
		if (fields.size === 0) {
			return fields;
		}
		const indexes = await getIndexesFromDbi(this, table, database);
		for (const [name, field] of fields) {
			if (![undefined, null, '', '0'].includes(field.Key)) {
				continue;
			}
			for (const index of indexes.values()) {
				const column = index.getColumns().get(name);
				if (column === undefined || Number(column.getSeqInIndex()) <= 1) {
					continue;
				}
				if (index.isUnique()) {
					field.Key = 'UNI';
				} else {
					field.Key = 'MUL';
				}
			}
		}
		return fields;
	}

	private async run(sql: string): Promise<QueryOutcome | false> {
		const connection = await this.link();
		try {
			const [result, fields] = await connection.query({ sql, rowsAsArray: true, typeCast: false });
			this.lastError = null;
			return this.outcome(result, fields);
		} catch (error) {
			const sqlError = mysqlError(error);
			if (sqlError === null) {
				throw error;
			}
			this.lastError = sqlError;
			return false;
		}
	}

	private outcome(result: unknown, fields: unknown): QueryOutcome {
		let rows = result;
		let columns = fields;
		// A CALL returns several result sets; mysqli's query() only reads the first one.
		if (Array.isArray(fields) && Array.isArray(fields[0])) {
			rows = (result as unknown[])[0];
			columns = fields[0];
		}
		if (!Array.isArray(rows)) {
			const header = rows as ResultSetHeader;
			return { rows: [], fields: [], affectedRows: header.affectedRows, warningCount: header.warningStatus };
		}
		const fieldList = (columns ?? []) as FieldPacket[];
		const decoded = (rows as (Buffer | null)[][]).map(row => row.map((value, index) => decodeValue(value, fieldList[index])));
		// mysqli reports the row count of a buffered SELECT as its affected rows.
		return { rows: decoded, fields: fieldList, affectedRows: decoded.length, warningCount: 0 };
	}

	private fetchList(result: DbiResult | false, value: string | number | null): unknown[] {
		if (result === false) {
			return [];
		}
		// No nested array when the result has a single column.
		if (result.numFields() === 1) {
			return result.fetchAllColumn();
		}
		return result.fetchAllAssoc().map(row => (value === null ? row : row[value] ?? null));
	}

	// A null key level appends to a list ($a[] = ...), any other level keys a Map by that column.
	private fetchTree(result: DbiResult | false, keys: (string | number | null)[], value: string | number | null): unknown {
		type Node = unknown[] | Map<string, unknown>;
		const createNode = (key: string | number | null | undefined): Node => (key === null ? [] : new Map());
		const root = createNode(keys[0]);
		if (result === false) {
			return root;
		}
		for (let row = result.fetchAssoc(); row !== null; row = result.fetchAssoc()) {
			const leaf = value === null ? row : row[value] ?? null;
			let target = root;
			for (const [index, key] of keys.entries()) {
				const isLast = index === keys.length - 1;
				if (Array.isArray(target)) {
					const child = isLast ? leaf : createNode(keys[index + 1]);
					target.push(child);
					target = child as Node;
				} else {
					const name = row[key as string] ?? '';
					if (isLast) {
						target.set(name, leaf);
					} else if (!target.has(name)) {
						target.set(name, createNode(keys[index + 1]));
					}
					target = target.get(name) as Node;
				}
			}
		}
		return root;
	}

	private remember<T>(key: string, compute: () => Promise<T>): Promise<T> {
		let pending = this.memo.get(key) as Promise<T> | undefined;
		if (pending === undefined) {
			pending = compute();
			this.memo.set(key, pending);
		}
		return pending;
	}

	private async hasPrivilegeRow(buildQuery: (user: string, host: string, collation: string) => string): Promise<boolean> {
		const collation = await this.getServerCollation();
		const [user = '', host = ''] = await this.getCurrentUserAndHost();
		const result = await this.tryQuery(buildQuery(user, host, collation));
		if (result !== false && result.numRows() > 0) {
			return true;
		}
		for (const [role = '', roleHost = ''] of await this.getCurrentRolesAndHost()) {
			const roleResult = await this.tryQuery(buildQuery(role, roleHost, collation));
			if (roleResult !== false && roleResult.numRows() > 0) {
				return true;
			}
		}
		return false;
	}

	private sortByKey(tables: Map<string, DbiRow>, sortOrder: string): Map<string, DbiRow> {
		const sorted = [...tables].toSorted(([left], [right]) => strnatcasecmp(left, right));
		return new Map(sortOrder === 'DESC' ? sorted.toReversed() : sorted);
	}

	private async getTableStatusFallback(database: string, table: string | string[], tblIsGroup: boolean, tableType: string | null, sortBy: string, sortOrder: string, count: number | boolean, offset: number): Promise<Map<string, DbiRow>> {
		let sql = `SHOW TABLE STATUS FROM ${backquote(database)}`;
		const hasTable = Array.isArray(table) ? table.length > 0 : table !== '';
		if (hasTable || tblIsGroup || tableType) {
			sql += ' WHERE';
			if (hasTable || tblIsGroup) {
				if (Array.isArray(table)) {
					sql += ` \`Name\` IN ('${table.map(name => escapeString(name)).join('\', \'')}')`;
				} else {
					sql += ` \`Name\` LIKE '${escapeMysqlLikeString(table)}%'`;
				}
				if (tableType) {
					sql += ' AND';
				}
			}
			if (tableType === 'view') {
				sql += ' `Comment` = \'VIEW\'';
			} else if (tableType === 'table') {
				sql += ' `Comment` != \'VIEW\'';
			}
		}
		let tables = await this.fetchResult(sql, 'Name');
		if (sortBy === 'Name' && this.options.config.NaturalOrder) {
			tables = this.sortByKey(tables, sortOrder);
		} else {
			const sortValue = (row: DbiRow): string => {
				if (sortBy === 'Data_length') {
					return String(Number(row.Data_length) + Number(row.Index_length));
				}
				return (row[sortBy] ?? '').toLowerCase();
			};
			// array_multisort() applies the direction to the sort values only; ties compare the rows, so their names, ascending.
			const direction = sortOrder === 'DESC' ? -1 : 1;
			tables = new Map([...tables].toSorted(([leftName, left], [rightName, right]) => (direction * phpCompareStrings(sortValue(left), sortValue(right))) || phpCompareStrings(leftName, rightName)));
		}
		if (count) {
			tables = new Map([...tables].slice(offset, offset + Number(count)));
		}
		return getISCompatForGetTablesFull(tables, database);
	}

	/** Query\Cache::cacheTableData(), so later table lookups can skip SHOW TABLE STATUS. */
	private cacheTableData(database: string, tables: Map<string, DbiRow>): void {
		const cached = this.tableCache.get(database) ?? new Map<string, DbiRow>();
		for (const [name, row] of tables) {
			cached.set(name, row);
		}
		this.tableCache.set(database, cached);
	}

	/** DatabaseInterface::setCollation(); a failure keeps the previous collation, where upstream also raises a warning. */
	async setCollation(collation: string): Promise<void> {
		let applied = collation;
		if (this.charsetConnection === 'utf8' && applied.startsWith('utf8mb4_')) {
			applied = `utf8_${applied.slice(8)}`;
		}
		const result = await this.tryQuery(`SET collation_connection = '${escapeString(applied)}';`);
		if (result !== false) {
			this.collationConnection = applied;
		}
	}

	/** DatabaseInterface::connect(CONNECT_USER): opens the link once and runs postConnect(); connection errors propagate. */
	async connect(): Promise<void> {
		this.connecting ??= this.openAndPostConnect();
		await this.connecting;
	}

	isConnected(): boolean {
		return this.connection !== undefined;
	}

	/** DatabaseInterface::tryQuery(): false on SQL errors, with getError() describing them. */
	async tryQuery(sql: string, cacheAffectedRows = true): Promise<DbiResult | false> {
		const outcome = await this.run(sql);
		if (outcome === false) {
			if (cacheAffectedRows) {
				this.cachedAffectedRows = -1;
			}
			return false;
		}
		this.lastWarningCount = outcome.warningCount;
		if (cacheAffectedRows) {
			this.cachedAffectedRows = outcome.affectedRows;
		}
		return new DbiResult(outcome.rows, outcome.fields);
	}

	/** DatabaseInterface::query(): throws DbiQueryError where upstream would die with the MySQL error page. */
	async query(sql: string, cacheAffectedRows = true): Promise<DbiResult> {
		const result = await this.tryQuery(sql, cacheAffectedRows);
		if (result === false) {
			throw new DbiQueryError(this.lastError as DbiError, this.getError(), sql);
		}
		return result;
	}

	/** Every result set of one statement, such as a CALL, as tryMultiQuery()/storeResult()/nextResult() walk them; false on error. */
	async tryQueryResultSets(sql: string): Promise<DbiResult[] | false> {
		const connection = await this.link();
		try {
			const [result, fields] = await connection.query({ sql, rowsAsArray: true, typeCast: false });
			this.lastError = null;
			if (Array.isArray(fields) && Array.isArray(fields[0])) {
				return (result as unknown[]).map((rows, index) => {
					const outcome = this.outcome(rows, fields[index]);
					return new DbiResult(outcome.rows, outcome.fields);
				});
			}
			const outcome = this.outcome(result, fields);
			return [new DbiResult(outcome.rows, outcome.fields)];
		} catch (error) {
			const sqlError = mysqlError(error);
			if (sqlError === null) {
				throw error;
			}
			this.lastError = sqlError;
			return false;
		}
	}

	/** DatabaseInterface::getError(): the formatted last error, or ''. */
	getError(): string {
		if (this.lastError === null || this.lastError.errno === 0 || this.lastError.message === '') {
			return '';
		}
		return formatError(this.lastError.errno, this.lastError.message, this.options.routeUrl);
	}

	/** mysqli's errno and error of the last statement, or null when it succeeded ($GLOBALS['errno']). */
	getLastError(): DbiError | null {
		return this.lastError;
	}

	/** DatabaseInterface::affectedRows(): the count cached by the last query()/tryQuery(), -1 after an error. */
	affectedRows(): number {
		return this.cachedAffectedRows;
	}

	/** $link->warning_count of the last statement. */
	warningCount(): number {
		return this.lastWarningCount;
	}

	/** DatabaseInterface::insertId() via LAST_INSERT_ID(), which survives BIGINT keys. */
	async insertId(): Promise<number> {
		return Number(await this.fetchValue('SELECT LAST_INSERT_ID();')) || 0;
	}

	/** DatabaseInterface::fetchValue(). */
	async fetchValue(sql: string, field: number | string = 0): Promise<DbiValue | false> {
		const result = await this.tryQuery(sql, false);
		if (result === false) {
			return false;
		}
		return result.fetchValue(field);
	}

	/** DatabaseInterface::fetchSingleRow(): null for an empty result or an error. */
	async fetchSingleRow(sql: string, type?: typeof FETCH_ASSOC): Promise<DbiRow | null>;
	async fetchSingleRow(sql: string, type: typeof FETCH_NUM): Promise<DbiValue[] | null>;
	async fetchSingleRow(sql: string, type: typeof FETCH_ASSOC | typeof FETCH_NUM = FETCH_ASSOC): Promise<DbiRow | DbiValue[] | null> {
		const result = await this.tryQuery(sql, false);
		if (result === false) {
			return null;
		}
		return type === FETCH_NUM ? result.fetchRow() : result.fetchAssoc();
	}

	/**
	 * DatabaseInterface::fetchResult(). Without a key the rows (or the single column) come as a list; with a key column
	 * they are keyed by it in a Map, which keeps PHP's insertion order even for numeric-looking keys.
	 */
	async fetchResult<T = DbiRow>(sql: string, key?: null, value?: string | number | null): Promise<T[]>;
	async fetchResult<T = DbiRow>(sql: string, key: string | number, value?: string | number | null): Promise<Map<string, T>>;
	async fetchResult<T = DbiRow>(sql: string, key: [string, string], value?: string | number | null): Promise<Map<string, Map<string, T>>>;
	async fetchResult<T = DbiRow>(sql: string, key: (string | number | null)[], value?: string | number | null): Promise<FetchResultTree<T>>;
	async fetchResult(sql: string, key: string | number | (string | number | null)[] | null = null, value: string | number | null = null): Promise<unknown> {
		const result = await this.tryQuery(sql, false);
		if (key === null || key === undefined) {
			return this.fetchList(result, value);
		}
		if (Array.isArray(key)) {
			return this.fetchTree(result, key, value);
		}
		const rows = new Map<string, unknown>();
		if (result === false) {
			return rows;
		}
		// An integer key reads rows by position, as upstream switches to FETCH_NUM.
		const next = typeof key === 'number' ? () => result.fetchRow() : () => result.fetchAssoc();
		for (let row = next(); row !== null; row = next()) {
			const record = row as Record<string | number, DbiValue>;
			const name = (Reflect.get(record, key) as DbiValue | undefined) ?? '';
			rows.set(name, value === null ? row : record[value] ?? null);
		}
		return rows;
	}

	/** DatabaseInterface::getVariable(). */
	async getVariable(name: string, type: number = GETVAR_SESSION): Promise<DbiValue | false> {
		let modifier = '';
		if (type === GETVAR_SESSION) {
			modifier = ' SESSION';
		} else if (type === GETVAR_GLOBAL) {
			modifier = ' GLOBAL';
		}
		return this.fetchValue(`SHOW${modifier} VARIABLES LIKE '${name}';`, 1);
	}

	async selectDb(database: string): Promise<boolean> {
		let sql = `USE ${backquote(database)}`;
		// mysqli's COM_INIT_DB fails an empty name with ER_NO_DB_ERROR, which MariaDB's SHOW WARNINGS still reports after a table-less SELECT.
		if (database === '') {
			sql = 'SIGNAL SQLSTATE \'3D000\' SET MYSQL_ERRNO = 1046, MESSAGE_TEXT = \'No database selected\'';
		}
		return (await this.tryQuery(sql, false)) !== false;
	}

	escapeString(value: string): string {
		return escapeString(value);
	}

	escapeMysqlLikeString(value: string): string {
		return escapeMysqlLikeString(value);
	}

	getVersion(): number {
		return this.versionInt;
	}

	getVersionString(): string {
		return this.versionString;
	}

	getVersionComment(): string {
		return this.versionComment;
	}

	isMariaDB(): boolean {
		return this.mariaDb;
	}

	isMySql(): boolean {
		return !this.mariaDb;
	}

	isPercona(): boolean {
		return this.percona;
	}

	/** SELECT @@lower_case_table_names, as a string ('' when unknown). */
	async getLowerCaseNames(): Promise<string> {
		if (this.lowerCaseTableNames === undefined) {
			const value = await this.fetchValue('SELECT @@lower_case_table_names');
			// Upstream's `?: ''` also turns '0' into '', so Util::getCollateForIS() adds no COLLATE on case-sensitive servers.
			this.lowerCaseTableNames = value && String(value) !== '0' ? String(value) : '';
		}
		return this.lowerCaseTableNames;
	}

	/** Util::getCollateForIS(). */
	async getCollateForIS(): Promise<string> {
		return getCollateForIS(await this.getLowerCaseNames());
	}

	async getServerCollation(): Promise<string> {
		return String((await this.fetchValue('SELECT @@collation_server')) || '');
	}

	async getDbCollation(database: string): Promise<string> {
		const sql = `SELECT DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '${escapeString(database)}' LIMIT 1`;
		return String((await this.fetchValue(sql)) || '');
	}

	/** DatabaseInterface::getCurrentUser(), e.g. "customer@%"; "@" when unknown. */
	async getCurrentUser(): Promise<string> {
		if (this.currentUser === undefined) {
			const user = await this.fetchValue('SELECT CURRENT_USER();');
			if (user === false || user === null) {
				return '@';
			}
			this.currentUser = user;
		}
		return this.currentUser;
	}

	/** DatabaseInterface::getCurrentUserAndHost(): explode('@', CURRENT_USER()). */
	async getCurrentUserAndHost(): Promise<string[]> {
		const user = await this.getCurrentUser();
		return user.split('@');
	}

	/** DatabaseInterface::getCurrentRoles(); MySQL 8 and MariaDB 10.5 or later. */
	async getCurrentRoles(): Promise<string[]> {
		if ((this.mariaDb && this.versionInt < 100500) || this.versionInt < 80000) {
			return [];
		}
		if (this.currentRoles === undefined) {
			const role = await this.fetchValue('SELECT CURRENT_ROLE();');
			if (typeof role !== 'string' || role === 'NONE') {
				return [];
			}
			this.currentRoles = role.replaceAll('`', '').split(',').map(item => item.trim());
		}
		return this.currentRoles;
	}

	async getCurrentRolesAndHost(): Promise<string[][]> {
		const roles = await this.getCurrentRoles();
		return roles.map(role => role.split('@'));
	}

	/** DatabaseInterface::isSuperUser(): whether mysql.user is readable. */
	async isSuperUser(): Promise<boolean> {
		return this.remember('is_superuser', async () => {
			const result = await this.tryQuery('SELECT 1 FROM mysql.user LIMIT 1');
			return result !== false && result.numRows() > 0;
		});
	}

	/** DatabaseInterface::isGrantUser(). */
	async isGrantUser(): Promise<boolean> {
		return this.remember('is_grantuser', () => this.hasPrivilegeRow(getInformationSchemaDataForGranteeRequest));
	}

	/** DatabaseInterface::isCreateUser(). */
	async isCreateUser(): Promise<boolean> {
		return this.remember('is_createuser', () => this.hasPrivilegeRow(getInformationSchemaDataForCreateRequest));
	}

	/** CheckUserPrivileges::getPrivileges(); note its USE probes change the connection's default database, as upstream. */
	async getUserPrivileges(): Promise<UserPrivileges> {
		return this.remember('user_privileges', async () => {
			const [username = ''] = await this.getCurrentUserAndHost();
			if (username === '') {
				return unrestrictedPrivileges();
			}
			// analyseShowGrant() reuses the SessionCache result, so later requests skip SHOW GRANTS and its USE probes.
			const cached = this.options.sessionCache?.get('user_privileges');
			if (cached !== undefined) {
				return cached as UserPrivileges;
			}
			const grants = await this.tryQuery('SHOW GRANTS');
			const rows = grants === false ? null : grants.fetchAllColumn().map(value => value ?? '');
			const privileges = await analyseShowGrants(rows, async (sql) => {
				const used = await this.tryQuery(sql);
				return used === false ? this.getError() : null;
			});
			this.options.sessionCache?.set('user_privileges', privileges);
			return privileges;
		});
	}

	/** Whether the account may create a database: $GLOBALS['is_create_db_priv']. */
	async isCreateDatabaseUser(): Promise<boolean> {
		const privileges = await this.getUserPrivileges();
		return privileges.isCreateDbPriv;
	}

	/** $GLOBALS['dblist']->databases: ListDatabase, sorted like upstream, without only_db/hide_db (unset in production). */
	async getDatabaseList(): Promise<string[]> {
		return this.remember('dblist', async () => {
			await this.getUserPrivileges();
			const names = await this.fetchResult<string>('SELECT `SCHEMA_NAME` FROM `INFORMATION_SCHEMA`.`SCHEMATA`');
			const list = names.map(String);
			if (this.options.config.NaturalOrder) {
				return list.toSorted(strnatcasecmp);
			}
			return list.toSorted(phpCompareStrings);
		});
	}

	/**
	 * DatabaseInterface::getDatabasesFull() with information_schema. With $cfg['NaturalOrder'] (the default) upstream
	 * sorts and pages in PHP, which also turns the result into a list.
	 */
	async getDatabasesFull(database: string | null = null, forceStats = false, sortBy = 'SCHEMA_NAME', sortOrder = 'ASC', limitOffset = 0, limitCount: number | boolean = false): Promise<DbiRow[]> {
		const order = sortOrder.toUpperCase();
		const count = limitCount === true ? this.options.config.MaxDbList : limitCount;
		const natural = this.options.config.NaturalOrder;
		let limit = '';
		if (!natural && count) {
			limit = ` LIMIT ${count} OFFSET ${limitOffset}`;
		}
		let where = '';
		if (database !== null) {
			where = `WHERE \`SCHEMA_NAME\` LIKE '${escapeString(database)}'`;
		}
		const sql = getInformationSchemaDatabasesFullRequest(forceStats, where, sortBy, order, limit);
		const rows = await this.fetchResult(sql, 'SCHEMA_NAME');
		const allowed = new Set(await this.getDatabaseList());
		let databases = [...rows].filter(([name]) => allowed.has(name)).map(([, row]) => row);
		if (natural) {
			databases = databases.toSorted((first, second) => usortComparison(first, second, sortBy, order, true));
			if (count) {
				databases = databases.slice(limitOffset, limitOffset + Number(count));
			}
		}
		return databases;
	}

	/** DatabaseInterface::getTables(): table names of a database. */
	async getTables(database: string): Promise<string[]> {
		if (database === '') {
			return [];
		}
		const names = await this.fetchResult<string>(`SHOW TABLES FROM ${backquote(database)};`, null, 0);
		const tables = names.map(String);
		if (this.options.config.NaturalOrder) {
			return tables.toSorted(strnatcasecmp);
		}
		return tables;
	}

	/**
	 * DatabaseInterface::getTablesFull() for one database, keyed by table name. Falls back to SHOW TABLE STATUS when
	 * information_schema returns nothing, exactly as upstream does (also for empty databases).
	 */
	async getTablesFull(database: string, table: string | string[] = '', tblIsGroup = false, limitOffset = 0, limitCount: number | boolean = false, sortBy = 'Name', sortOrder = 'ASC', tableType: string | null = null): Promise<Map<string, DbiRow>> {
		const count = limitCount === true ? this.options.config.MaxTableList : limitCount;
		let names = table;
		let pagingApplied = false;
		if (count && Array.isArray(names) && sortBy === 'Name') {
			names = sortOrder === 'DESC' ? names.toReversed() : names;
			names = names.slice(limitOffset, limitOffset + Number(count));
			pagingApplied = true;
		}
		const collate = await this.getCollateForIS();
		const escapedNames = Array.isArray(names) ? names.map(name => escapeString(name)) : escapeString(names);
		let sql = getSqlForTablesFull([escapeString(database)], getTableCondition(escapedNames, tblIsGroup, tableType, collate), collate);
		sql += ` ORDER BY ${sortBy} ${sortOrder}`;
		if (count && !pagingApplied) {
			sql += ` LIMIT ${count} OFFSET ${limitOffset}`;
		}
		const bySchema = await this.fetchResult(sql, ['TABLE_SCHEMA', 'TABLE_NAME']);
		let tables = bySchema.get(database) ?? bySchema.get(database.toLowerCase()) ?? new Map<string, DbiRow>();
		if (sortBy === 'Name' && this.options.config.NaturalOrder) {
			tables = this.sortByKey(tables, sortOrder);
		} else if (sortBy === 'Data_length') {
			const size = (row: DbiRow): number => Number(row.Data_length) + Number(row.Index_length);
			const sorted = [...tables].toSorted(([, left], [, right]) => Math.sign(size(left) - size(right)));
			tables = new Map(sortOrder === 'DESC' ? sorted.toReversed() : sorted);
		}
		// Permission problems on any database directory empty information_schema, so upstream asks SHOW TABLE STATUS instead.
		if (tables.size === 0) {
			tables = await this.getTableStatusFallback(database, names, tblIsGroup, tableType, sortBy, sortOrder, pagingApplied ? false : count, limitOffset);
		}
		if (tables.size > 0) {
			this.cacheTableData(database, tables);
		}
		return tables;
	}

	/** Query\Cache::getCachedTableContent([db, table]). */
	getCachedTableContent(database: string, table: string): DbiRow | undefined {
		return this.tableCache.get(database)?.get(table);
	}

	/** Query\Cache::cacheTableContent([db, table, key], value), such as Table::countRecords()'s ExactRows. */
	cacheTableValue(database: string, table: string, key: string, value: string): void {
		const tables = this.tableCache.get(database) ?? new Map<string, DbiRow>();
		tables.set(table, { ...tables.get(table), [key]: value });
		this.tableCache.set(database, tables);
	}

	/** Query\Cache::clearTableCache(), after a change such as ALTER TABLE makes the cached status stale. */
	clearTableCache(): void {
		this.tableCache.clear();
	}

	/** DatabaseInterface::getColumns(). */
	async getColumns(database: string, table: string, full = false): Promise<Map<string, DbiRow>> {
		const fields = await this.fetchResult(getColumnsSql(database, table, null, full), 'Field');
		return this.attachIndexInfoToColumns(database, table, fields);
	}

	/** DatabaseInterface::getColumnNames(). */
	async getColumnNames(database: string, table: string): Promise<string[]> {
		const names = await this.fetchResult<string>(getColumnsSql(database, table), null, 'Field');
		return names.map(String);
	}

	/** DatabaseInterface::getColumnsFull() with information_schema, keyed by column name for a single table. */
	async getColumnsFull(database: string, table: string): Promise<Map<string, DbiRow>> {
		const [sql, keys] = getInformationSchemaColumnsFullRequest(escapeString(database), escapeString(table), null);
		// eslint-disable-next-line antislop/no-chained-type-assertions -- with the database and table fixed the request keys only by COLUMN_NAME, so the tree is one Map deep.
		return await this.fetchResult(sql, keys) as unknown as Map<string, DbiRow>;
	}

	/** DatabaseInterface::getTableIndexes(). */
	async getTableIndexes(database: string, table: string): Promise<DbiRow[]> {
		return this.fetchResult(getTableIndexesSql(database, table));
	}

	/** DatabaseInterface::getWarnings() as raw SHOW WARNINGS rows. */
	async getWarnings(): Promise<DbiRow[]> {
		const result = await this.tryQuery('SHOW WARNINGS', false);
		return result === false ? [] : result.fetchAllAssoc();
	}
}

// Pure parts of PhpMyAdmin\Server\Privileges: the grant tables, privilege extraction and request parsing.
import { backquote } from '../../twig/sanitize.ts';
import { escapeString } from '../dbi-sql.ts';
import { isNumericString } from '../php-compare.ts';
import { phpToInt } from '../sprintf.ts';

import type { RequestParams, RequestValue } from '../../pma-request.ts';

/** A privilege table row, or the $GLOBALS/$_POST values standing in for one. */
export type PrivRow = Record<string, unknown>;

/** [column, privilege name, description] as in Privileges::getGrantsArray(). */
export type Grant = readonly [string, string, string];

export const GRANTS: readonly Grant[] = [
	['Select_priv', 'SELECT', 'Allows reading data.'],
	['Insert_priv', 'INSERT', 'Allows inserting and replacing data.'],
	['Update_priv', 'UPDATE', 'Allows changing data.'],
	['Delete_priv', 'DELETE', 'Allows deleting data.'],
	['Create_priv', 'CREATE', 'Allows creating new databases and tables.'],
	['Drop_priv', 'DROP', 'Allows dropping databases and tables.'],
	['Reload_priv', 'RELOAD', 'Allows reloading server settings and flushing the server\'s caches.'],
	['Shutdown_priv', 'SHUTDOWN', 'Allows shutting down the server.'],
	['Process_priv', 'PROCESS', 'Allows viewing processes of all users.'],
	['File_priv', 'FILE', 'Allows importing data from and exporting data into files.'],
	['References_priv', 'REFERENCES', 'Has no effect in this MySQL version.'],
	['Index_priv', 'INDEX', 'Allows creating and dropping indexes.'],
	['Alter_priv', 'ALTER', 'Allows altering the structure of existing tables.'],
	['Show_db_priv', 'SHOW DATABASES', 'Gives access to the complete list of databases.'],
	['Super_priv', 'SUPER', 'Allows connecting, even if maximum number of connections is reached; required for most administrative operations like setting global variables or killing threads of other users.'],
	['Create_tmp_table_priv', 'CREATE TEMPORARY TABLES', 'Allows creating temporary tables.'],
	['Lock_tables_priv', 'LOCK TABLES', 'Allows locking tables for the current thread.'],
	['Repl_slave_priv', 'REPLICATION SLAVE', 'Needed for the replication replicas.'],
	['Repl_client_priv', 'REPLICATION CLIENT', 'Allows the user to ask where the replicas / primaries are.'],
	['Create_view_priv', 'CREATE VIEW', 'Allows creating new views.'],
	['Event_priv', 'EVENT', 'Allows to set up events for the event scheduler.'],
	['Trigger_priv', 'TRIGGER', 'Allows creating and dropping triggers.'],
	['Create View_priv', 'CREATE VIEW', 'Allows creating new views.'],
	['Show_view_priv', 'SHOW VIEW', 'Allows performing SHOW CREATE VIEW queries.'],
	['Show view_priv', 'SHOW VIEW', 'Allows performing SHOW CREATE VIEW queries.'],
	['Delete_history_priv', 'DELETE HISTORY', 'Allows deleting historical rows.'],
	['Delete versioning rows_priv', 'DELETE HISTORY', 'Allows deleting historical rows.'],
	['Create_routine_priv', 'CREATE ROUTINE', 'Allows creating stored routines.'],
	['Alter_routine_priv', 'ALTER ROUTINE', 'Allows altering and dropping stored routines.'],
	['Create_user_priv', 'CREATE USER', 'Allows creating, dropping and renaming user accounts.'],
	['Execute_priv', 'EXECUTE', 'Allows executing stored routines.'],
];

export const TABLE_GRANTS: readonly Grant[] = [
	['Delete', 'DELETE', 'Allows deleting data.'],
	['Create', 'CREATE', 'Allows creating new tables.'],
	['Drop', 'DROP', 'Allows dropping tables.'],
	['Index', 'INDEX', 'Allows creating and dropping indexes.'],
	['Alter', 'ALTER', 'Allows altering the structure of existing tables.'],
	['Create View', 'CREATE_VIEW', 'Allows creating new views.'],
	['Show view', 'SHOW_VIEW', 'Allows performing SHOW CREATE VIEW queries.'],
	['Trigger', 'TRIGGER', 'Allows creating and dropping triggers.'],
];

/** PHP's isset() for one array entry. */
export function isSet(value: unknown): boolean {
	return value !== undefined && value !== null;
}

/** PHP's empty() for scalars and arrays. */
export function isEmpty(value: unknown): boolean {
	if (Array.isArray(value)) {
		return value.length === 0;
	}
	return [undefined, null, false, 0, '', '0'].includes(value as never);
}

/** `$count == $value` with PHP 8 semantics, where $value is a request value or null. */
export function looseCountEquals(count: number, value: unknown): boolean {
	if (value === undefined || value === null) {
		return count === 0;
	}
	if (typeof value === 'number') {
		return count === value;
	}
	if (typeof value !== 'string') {
		return false;
	}
	if (isNumericString(value)) {
		return count === Number(value);
	}
	return String(count) === value;
}

/** `$left == $right` for two strings: numeric strings compare as numbers. */
export function looseStringEquals(left: string, right: string): boolean {
	if (isNumericString(left) && isNumericString(right)) {
		return Number(left) === Number(right);
	}
	return left === right;
}

/** `$left == $right` for two request values: arrays compare element by element, and never equal a string. */
export function looseRequestEquals(left: RequestValue, right: RequestValue): boolean {
	if (typeof left === 'string' && typeof right === 'string') {
		return looseStringEquals(left, right);
	}
	if (Array.isArray(left) && Array.isArray(right)) {
		return left.length === right.length && left.every((value, index) => looseStringEquals(value, right[index]));
	}
	return false;
}

/** The checks Privileges::updatePassword() makes before the change: the error text, or null to go ahead. */
export function updatePasswordError(post: RequestParams): string | null {
	const { pma_pw: password, pma_pw2: confirmation } = post;
	if (password === undefined || confirmation === undefined || !isEmpty(post.nopass)) {
		return null;
	}
	if (!looseRequestEquals(password, confirmation)) {
		return 'The passwords aren\'t the same!';
	}
	if (isEmpty(password) || isEmpty(confirmation)) {
		return 'The password is empty!';
	}
	return null;
}

/** The request-level inputs extractPrivInfo() reads besides the row. */
export interface ExtractEnv {
	/** $GLOBALS entries set from $_POST (privilege and max_ fields) and from a copied user's row. */
	globals: ReadonlyMap<string, unknown>;
	/** $_REQUEST['column_count']. */
	columnCount?: unknown;
	/** $_POST['grant_count']. */
	grantCount?: unknown;
}

function dfn(grant: Grant): string {
	return `<dfn title="${grant[2]}">${grant[1]}</dfn>`;
}

/** Privileges::extractPrivInfo() for a row already passed through fillInTablePrivileges(). */
export function extractPrivInfo(row: PrivRow | null, enableHtml: boolean, tablePrivs: boolean, env: ExtractEnv): string[] {
	const grants = tablePrivs ? TABLE_GRANTS : GRANTS;
	const { globals } = env;
	const privs: string[] = [];
	let allPrivileges = true;
	for (const grant of grants) {
		const name = grant[0];
		if ((row === null || !isSet(row[name])) && (row !== null || !isSet(globals.get(name)))) {
			continue;
		}
		const value = row === null ? globals.get(name) : row[name];
		const noneEmpty = isEmpty(globals.get(`${name}_none`));
		const columnsCovered = Array.isArray(value) && looseCountEquals(value.length, env.columnCount) && noneEmpty;
		if (value === 'Y' || (row === null && columnsCovered)) {
			privs.push(enableHtml ? dfn(grant) : grant[1]);
			continue;
		}
		const globalValue = globals.get(name);
		if (!isEmpty(globalValue) && Array.isArray(globalValue) && noneEmpty) {
			const columns = (globalValue as unknown[]).map(column => backquote(column)).join(', ');
			privs.push(`${enableHtml ? dfn(grant) : grant[1]} (${columns})`);
			continue;
		}
		allPrivileges = false;
	}
	if (privs.length === 0) {
		if (enableHtml) {
			return ['<dfn title="No privileges.">USAGE</dfn>'];
		}
		return ['USAGE'];
	}
	if (allPrivileges && (!isSet(env.grantCount) || looseCountEquals(privs.length, env.grantCount))) {
		if (enableHtml) {
			return ['<dfn title="Includes all privileges except GRANT.">ALL PRIVILEGES</dfn>'];
		}
		return ['ALL PRIVILEGES'];
	}
	return privs;
}

/** The SET members of mysql.tables_priv.Table_priv from its SHOW COLUMNS type, as fillInTablePrivileges() slices them. */
export function parseTablePrivTypes(type: string): string[] {
	// The members sit between "('" and "')", so the quotes next to the parentheses are skipped.
	return type.slice(type.indexOf('(') + 2, type.indexOf(')') - 1).split('\',\'');
}

/** Privileges::fillInTablePrivileges(): one Y/N entry per available table privilege instead of Table_priv. */
export function fillInTablePrivileges(row: PrivRow, availableGrants: string[]): PrivRow {
	const filled: PrivRow = { ...row };
	const userGrants = new Set(String(row.Table_priv ?? '').split(','));
	for (const grant of availableGrants) {
		filled[`${grant}_priv`] = userGrants.has(grant) ? 'Y' : 'N';
	}
	delete filled.Table_priv;
	return filled;
}

/** Privileges::parseProcPriv(). */
export function parseProcPriv(privs: unknown): PrivRow {
	const result: PrivRow = { Alter_routine_priv: 'N', Execute_priv: 'N', Grant_priv: 'N' };
	for (const priv of String(privs ?? '').split(',')) {
		if (priv === 'Alter Routine') {
			result.Alter_routine_priv = 'Y';
		} else {
			result[`${priv}_priv`] = 'Y';
		}
	}
	return result;
}

/** Util::unescapeMysqlWildcards(). */
export function unescapeMysqlWildcards(name: string): string {
	return name.replaceAll(/\\([_%])/g, '$1');
}

/** Privileges::wildcardEscapeForGrant(). */
export function wildcardEscapeForGrant(dbname: string, tablename: string): string {
	if (dbname === '') {
		return '*.*';
	}
	if (tablename !== '') {
		return `${backquote(unescapeMysqlWildcards(dbname))}.${backquote(tablename)}`;
	}
	return `${backquote(dbname)}.*`;
}

/** Privileges::rangeOfUsers(). */
export function rangeOfUsers(initial: string | null): string {
	if (initial === null) {
		return '';
	}
	if (initial === '') {
		return ' WHERE `User` = \'\'';
	}
	const like = `${initial.replaceAll(/[_%\\]/g, character => `\\${character}`)}%`;
	return ` WHERE \`User\` LIKE '${escapeString(like)}' OR \`User\` LIKE '${escapeString(like.toLowerCase())}'`;
}

/** PHP's (string) cast of a request value: arrays become "Array". */
function requestString(value: RequestValue): string {
	if (Array.isArray(value)) {
		return 'Array';
	}
	return value;
}

/** A request value that is a non-empty string. */
function nonEmptyString(value: RequestValue | undefined): string | null {
	if (typeof value === 'string' && value !== '') {
		return value;
	}
	return null;
}

/** array_filter() keeps every entry: no '' or '0'. */
function allTruthy(values: string[]): boolean {
	return values.every(value => value !== '' && value !== '0');
}

/** preg_match('/(?<!\\\\)(?:_|%)/', $dbname): an unescaped wildcard. */
export function isWildcardDbname(dbname: string): boolean {
	return /(?<!\\)[_%]/.test(dbname);
}

export interface DbInfo {
	username: string | null;
	hostname: string | null;
	dbname: string | string[] | null;
	tablename: string | null;
	routinename: string | null;
	dbnameIsWildcard: boolean;
}

/** Privileges::getDataForDBInfo() without the unused db_and_table value. */
export function getDataForDbInfo(post: RequestParams, request: RequestParams): DbInfo {
	let username: string | null = null;
	let hostname: string | null = null;
	if (request.username !== undefined) {
		username = requestString(request.username);
	}
	if (request.hostname !== undefined) {
		hostname = requestString(request.hostname);
	}
	let tablename = nonEmptyString(post.pred_tablename) ?? nonEmptyString(request.tablename);
	const routinename = nonEmptyString(post.pred_routinename) ?? nonEmptyString(request.routinename);
	let dbname: string | string[] | null = null;
	const predDbname = post.pred_dbname;
	if (Array.isArray(predDbname) && allTruthy(predDbname)) {
		dbname = predDbname;
		if (predDbname.length === 1) {
			dbname = predDbname[0];
		}
	}
	const requestDbname = request.dbname;
	if (dbname === null && Array.isArray(requestDbname)) {
		if (allTruthy(requestDbname)) {
			dbname = requestDbname;
		}
	} else if (dbname === null) {
		dbname = nonEmptyString(requestDbname);
	}
	if (dbname === null) {
		tablename = null;
	}
	const dbnameIsWildcard = typeof dbname === 'string' && isWildcardDbname(dbname);
	return { username, hostname, dbname, tablename, routinename, dbnameIsWildcard };
}

/** Privileges::getRequireClause(); $source is $_POST when it has ssl_type, else $GLOBALS. */
export function getRequireClause(post: RequestParams, globals: ReadonlyMap<string, unknown>): string {
	const read = (key: string): unknown => {
		if (post.ssl_type !== undefined) {
			return post[key];
		}
		return globals.get(key);
	};
	const sslType = read('ssl_type');
	if (sslType === 'SPECIFIED') {
		const require: string[] = [];
		if (!isEmpty(read('ssl_cipher'))) {
			require.push(`CIPHER '${escapeString(String(read('ssl_cipher')))}'`);
		}
		if (!isEmpty(read('x509_issuer'))) {
			require.push(`ISSUER '${escapeString(String(read('x509_issuer')))}'`);
		}
		if (!isEmpty(read('x509_subject'))) {
			require.push(`SUBJECT '${escapeString(String(read('x509_subject')))}'`);
		}
		if (require.length > 0) {
			return ` REQUIRE ${require.join(' AND ')}`;
		}
		return ' REQUIRE NONE';
	}
	if (sslType === 'X509') {
		return ' REQUIRE X509';
	}
	if (sslType === 'ANY') {
		return ' REQUIRE SSL';
	}
	return ' REQUIRE NONE';
}

/** Whether the server needs ALTER USER for limits and GRANT OPTION: MySQL or Percona 8.0.11 and later. */
export function needsAlterUser(isMariaDb: boolean, version: number): boolean {
	return !isMariaDb && version >= 80011;
}

/** $_POST['Grant_priv'] or $GLOBALS['Grant_priv'] is 'Y'. */
export function hasGrantOption(post: RequestParams, globals: ReadonlyMap<string, unknown>): boolean {
	return post.Grant_priv === 'Y' || globals.get('Grant_priv') === 'Y';
}

/** Privileges::getWithClauseForAddUserAndUpdatePrivs(). */
export function getWithClause(post: RequestParams, globals: ReadonlyMap<string, unknown>, isMariaDb: boolean, version: number): string {
	let sql = '';
	if (hasGrantOption(post, globals) && !needsAlterUser(isMariaDb, version)) {
		sql += ' GRANT OPTION';
	}
	const limits: [string, string][] = [
		['max_questions', 'MAX_QUERIES_PER_HOUR'],
		['max_connections', 'MAX_CONNECTIONS_PER_HOUR'],
		['max_updates', 'MAX_UPDATES_PER_HOUR'],
		['max_user_connections', 'MAX_USER_CONNECTIONS'],
	];
	for (const [field, clause] of limits) {
		const value = post[field] ?? globals.get(field);
		if (!isSet(value)) {
			continue;
		}
		sql += ` ${clause} ${Math.max(0, phpToInt(value))}`;
	}
	if (sql === '') {
		return '';
	}
	return ` WITH${sql}`;
}

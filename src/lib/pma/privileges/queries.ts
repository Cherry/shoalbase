// SQL that PhpMyAdmin\Server\Privileges builds from the request, kept apart from running it.
import { backquote, escapeMysqlWildcards } from '../../twig/sanitize.ts';
import { escapeString } from '../dbi-sql.ts';
import { sprintf } from '../sprintf.ts';
import {
	getRequireClause,
	getWithClause,
	hasGrantOption,
	isSet,
	needsAlterUser,
} from './grants.ts';

import type { RequestParams } from '../../pma-request.ts';

/** The server facts the statements depend on. */
export interface ServerFlavor {
	isMariaDb: boolean;
	version: number;
}

/** `'user'@'host'` with both parts escaped. */
export function userHost(username: string, hostname: string): string {
	return `'${escapeString(username)}'@'${escapeString(hostname)}'`;
}

/** Privileges::getSqlQueryForDisplayPrivTable(). */
export function getSqlQueryForDisplayPrivTable(db: string, table: string, username: string, hostname: string): string {
	const condition = ` WHERE \`User\` = '${escapeString(username)}' AND \`Host\` = '${escapeString(hostname)}'`;
	if (db === '*') {
		return `SELECT * FROM \`mysql\`.\`user\`${condition};`;
	}
	if (table === '*') {
		return `SELECT * FROM \`mysql\`.\`db\`${condition} AND \`Db\` = '${escapeString(db)}'`;
	}
	return `SELECT \`Table_priv\` FROM \`mysql\`.\`tables_priv\`${condition} AND \`Db\` = '${escapeString(db.replaceAll(/\\([_%])/g, '$1'))}' AND \`Table_name\` = '${escapeString(table)}';`;
}

/** Whether 'IDENTIFIED BY' style statements (5.7.6+ MySQL, 5.2+ MariaDB) are used for new accounts. */
function usesCreateUserPassword(server: ServerFlavor): boolean {
	return (!server.isMariaDb && server.version >= 50706) || (server.isMariaDb && server.version >= 50200);
}

export interface AddUserInput {
	username: string;
	hostname: string;
	/** The kept password (hash) for a copied user, '' otherwise. */
	password: string;
	server: ServerFlavor;
	/** checkIfMariaDBPwdCheckPluginActive(). */
	mariaDbPwdPluginActive: boolean;
	/** extractPrivInfo() for the posted privileges. */
	privileges: string[];
	post: RequestParams;
	globals: ReadonlyMap<string, unknown>;
	isGrantUser: boolean;
	/** getHashedPassword($_POST['pma_pw']) when needsHashedPassword() said so. */
	hashedPassword?: string;
}

export interface AddUserQueries {
	createUserReal: string;
	createUserShow: string;
	realSqlQuery: string;
	sqlQuery: string;
	passwordSetReal: string | null;
	passwordSetShow: string | null;
	alterRealSqlQuery: string;
	alterSqlQuery: string;
}

/** Whether getSqlQueriesForDisplayAndAddUser() asks the server for PASSWORD($_POST['pma_pw']). */
export function needsHashedPassword(server: ServerFlavor, mariaDbPwdPluginActive: boolean, predPassword: unknown): boolean {
	if (predPassword === 'keep' || predPassword === 'none') {
		return false;
	}
	if (!usesCreateUserPassword(server)) {
		return true;
	}
	return !((server.isMariaDb && mariaDbPwdPluginActive) || needsAlterUser(server.isMariaDb, server.version));
}

/** Privileges::getSqlQueriesForDisplayAndAddUser() after its queries ran. */
export function getSqlQueriesForDisplayAndAddUser(input: AddUserInput): AddUserQueries {
	const { server, post, globals } = input;
	const slashedUsername = escapeString(input.username);
	const slashedHostname = escapeString(input.hostname);
	const slashedPassword = escapeString(input.password);
	const plugin = post.authentication_plugin;
	const hasPlugin = plugin !== undefined;
	let createUserStmt = sprintf('CREATE USER \'%s\'@\'%s\'', slashedUsername, slashedHostname);
	if (!server.isMariaDb && server.version >= 50507 && hasPlugin) {
		createUserStmt += ` IDENTIFIED WITH ${String(plugin)}`;
	}
	if (server.isMariaDb && server.version >= 50200 && hasPlugin && !input.mariaDbPwdPluginActive) {
		createUserStmt += ` IDENTIFIED VIA ${String(plugin)}`;
	}
	let createUserReal = createUserStmt;
	let createUserShow = createUserStmt;
	const passwordSetStmt = 'SET PASSWORD FOR \'%s\'@\'%s\' = \'%s\'';
	let passwordSetShow: string | null = sprintf(passwordSetStmt, slashedUsername, slashedHostname, '***');
	let passwordSetReal: string | null = null;
	const grantStmt = sprintf('GRANT %s ON *.* TO \'%s\'@\'%s\'', input.privileges.join(', '), slashedUsername, slashedHostname);
	let realSqlQuery = grantStmt;
	let sqlQuery = grantStmt;
	const predPassword = post.pred_password;
	const isMySql8 = needsAlterUser(server.isMariaDb, server.version);
	if (usesCreateUserPassword(server)) {
		createUserStmt = createUserStmt.replaceAll('%', '%%');
		if (server.isMariaDb && !input.mariaDbPwdPluginActive && hasPlugin) {
			createUserStmt += ' USING \'%s\'';
		} else if (server.isMariaDb || (isMySql8 && !createUserStmt.includes('IDENTIFIED'))) {
			// MariaDB without the USING form, or MySQL 8 when no plugin was posted.
			createUserStmt += ' IDENTIFIED BY \'%s\'';
		} else if (isMySql8) {
			createUserStmt += ' BY \'%s\'';
		} else {
			createUserStmt += ' AS \'%s\'';
		}
		let password = input.hashedPassword ?? '';
		if (predPassword === 'keep') {
			password = slashedPassword;
		} else if (predPassword === 'none') {
			password = '';
		} else if ((server.isMariaDb && input.mariaDbPwdPluginActive) || isMySql8) {
			// MySQL 8 and MariaDB's password check plugins take the cleartext password, unescaped as upstream sends it.
			password = String(post.pma_pw ?? '');
		}
		createUserReal = sprintf(createUserStmt, password);
		createUserShow = sprintf(createUserStmt, '***');
	} else if (predPassword === 'keep') {
		passwordSetReal = sprintf(passwordSetStmt, slashedUsername, slashedHostname, slashedPassword);
	} else if (predPassword === 'none') {
		passwordSetReal = sprintf(passwordSetStmt, slashedUsername, slashedHostname, '');
	} else {
		passwordSetReal = sprintf(passwordSetStmt, slashedUsername, slashedHostname, input.hashedPassword ?? '');
	}

	let alterRealSqlQuery = '';
	let alterSqlQuery = '';
	if (isMySql8) {
		if (hasGrantOption(post, globals)) {
			realSqlQuery += ' WITH GRANT OPTION';
			sqlQuery += ' WITH GRANT OPTION';
		}
		alterRealSqlQuery = sprintf('ALTER USER \'%s\'@\'%s\'', slashedUsername, slashedHostname);
		alterSqlQuery = alterRealSqlQuery;
	}
	const clauses = getRequireClause(post, globals) + getWithClause(post, globals, server.isMariaDb, server.version);
	if (isMySql8) {
		alterRealSqlQuery += `${clauses};`;
		alterSqlQuery += `${clauses};`;
	} else {
		realSqlQuery += clauses;
		sqlQuery += clauses;
	}
	createUserReal += ';';
	createUserShow += ';';
	realSqlQuery += ';';
	sqlQuery += ';';
	if (!input.isGrantUser) {
		realSqlQuery = '';
		sqlQuery = '';
	}
	if (usesCreateUserPassword(server)) {
		passwordSetReal = null;
		passwordSetShow = null;
	} else {
		passwordSetReal += ';';
		passwordSetShow += ';';
	}
	return { createUserReal, createUserShow, realSqlQuery, sqlQuery, passwordSetReal, passwordSetShow, alterRealSqlQuery, alterSqlQuery };
}

/** The `SET old_passwords` statement setProperPasswordHashing() runs for an authentication plugin. */
export function passwordHashingQuery(plugin: unknown): string {
	if (plugin === 'sha256_password') {
		return 'SET `old_passwords` = 2;';
	}
	if (plugin === 'mysql_old_password') {
		return 'SET `old_passwords` = 1;';
	}
	return 'SET `old_passwords` = 0;';
}

export interface UpdatePrivilegesInput {
	itemType: string;
	dbAndTable: string;
	username: string;
	hostname: string;
	dbname: string;
	privileges: string[];
	server: ServerFlavor;
	post: RequestParams;
	globals: ReadonlyMap<string, unknown>;
}

/** Privileges::generateQueriesForUpdatePrivileges(): the GRANT and, on MySQL 8, the ALTER USER. */
export function generateQueriesForUpdatePrivileges(input: UpdatePrivilegesInput): [string, string | null] {
	const { post, globals, server } = input;
	const account = userHost(input.username, input.hostname);
	let grantBackQuery = `GRANT ${input.privileges.join(', ')} ON ${input.itemType} ${input.dbAndTable} TO ${account}`;
	const useAlter = needsAlterUser(server.isMariaDb, server.version);
	let alterUserQuery: string | null = null;
	let clauses = '';
	if (input.dbname === '') {
		clauses += getRequireClause(post, globals);
	}
	const hasLimits = ['max_questions', 'max_connections', 'max_updates', 'max_user_connections'].some(key => post[key] !== undefined);
	if (post.Grant_priv === 'Y' || (input.dbname === '' && hasLimits)) {
		clauses += getWithClause(post, globals, server.isMariaDb, server.version);
	}
	if (useAlter) {
		alterUserQuery = `ALTER USER ${account} ${clauses};`;
	} else {
		grantBackQuery += clauses;
	}
	return [`${grantBackQuery};`, alterUserQuery];
}

/** REVOKE ALL PRIVILEGES and REVOKE GRANT OPTION as updatePrivileges() and the revoke action send them. */
export function revokeQueries(itemType: string, dbAndTable: string, username: string, hostname: string): [string, string] {
	const account = userHost(username, hostname);
	return [
		`REVOKE ALL PRIVILEGES ON ${itemType} ${dbAndTable} FROM ${account};`,
		`REVOKE GRANT OPTION ON ${itemType} ${dbAndTable} FROM ${account};`,
	];
}

/** Privileges::getDataForDeleteUsers(): the DROP USER (and DROP DATABASE) statements, or null for its TypeError. */
export function deleteUsersQueries(selectedUsers: unknown[], queries: string[], dropUsersDb: boolean): string[] | null {
	const result = [...queries];
	for (const eachUser of selectedUsers) {
		// explode() of an array, or escapeString() of the missing host after it, is a TypeError.
		if (typeof eachUser !== 'string' || !eachUser.includes('&amp;#27;')) {
			return null;
		}
		const [thisUser, thisHost] = eachUser.split('&amp;#27;', 2);
		result.push(`# Deleting '${thisUser}'@'${thisHost}' ...`, `DROP USER ${userHost(thisUser, thisHost)};`);
		if (dropUsersDb) {
			result.push(`DROP DATABASE IF EXISTS ${backquote(thisUser)};`);
		}
	}
	return result;
}

/** The user and host of one selected_usr[] entry, split as getListForExportUserDefinition() does. */
export function exportUserParts(exportUser: string): [string, string] {
	const ampersand = exportUser.indexOf('&');
	const user = exportUser.slice(0, Math.max(ampersand, 0));
	// mb_strrpos() gives false without a semicolon, and false + 1 starts at the second character.
	const semicolon = exportUser.lastIndexOf(';');
	const host = exportUser.slice(semicolon === -1 ? 1 : semicolon + 1);
	return [user, host];
}

/** Privileges::getUserSpecificRights(): the UNION over the other privilege tables and the main rights query. */
export function userSpecificRightsQueries(username: string, hostname: string, type: string, dbname: string, mysqlTables: string[]): { union: string; main: string; key: string; } {
	let condition = ` WHERE \`User\` = '${escapeString(username)}' AND \`Host\` = '${escapeString(hostname)}'`;
	let searchIn = ['tables_priv', 'columns_priv', 'procs_priv'];
	let key = 'Db';
	if (type === 'table') {
		condition += ` AND \`Db\` LIKE '${escapeString(dbname)}'`;
		searchIn = ['columns_priv'];
		key = 'Table_name';
	} else if (type !== 'database') {
		condition += ` AND \`Db\` LIKE '${escapeString(dbname)}'`;
		searchIn = ['procs_priv'];
		key = 'Routine_name';
	}
	const parts = searchIn.filter(table => mysqlTables.includes(table)).map(table => `
                SELECT DISTINCT \`${key}\`
                FROM \`mysql\`.${backquote(table)}${condition}`);
	const union = `(${parts.join(') UNION (')}) ORDER BY \`${key}\` ASC`;
	let main = `SELECT * FROM \`mysql\`.\`db\`${condition} ORDER BY \`Db\` ASC`;
	if (type === 'table') {
		main = `SELECT \`Table_name\`, \`Table_priv\`, IF(\`Column_priv\` = _latin1 '', 0, 1) AS 'Column_priv' FROM \`mysql\`.\`tables_priv\`${condition} ORDER BY \`Table_name\` ASC;`;
	} else if (type !== 'database') {
		main = `SELECT \`Routine_name\`, \`Proc_priv\` FROM \`mysql\`.\`procs_priv\`${condition} ORDER BY \`Routine_name\``;
	}
	return { union, main, key };
}

/** The account list query of getDbRightsForUserOverview(). */
export function dbRightsForUserOverviewQuery(mysqlTables: string[], range: string): string {
	const parts = ['user', 'db', 'tables_priv', 'columns_priv', 'procs_priv']
		.filter(table => mysqlTables.includes(table))
		.map(table => `SELECT DISTINCT \`User\`, \`Host\` FROM \`mysql\`.\`${table}\` ${range}`);
	return `(${parts.join(') UNION (')}) ORDER BY \`User\` ASC, \`Host\` ASC`;
}

/** The two user list queries of getHtmlForUserOverview(): filtered by initial, and all users. */
export function userOverviewQueries(server: ServerFlavor, range: string): [string, string] {
	let passwordColumn = 'Password';
	if (!server.isMariaDb && server.version >= 50706) {
		passwordColumn = 'authentication_string';
	}
	const base = `SELECT *, IF(\`${passwordColumn}\` = _latin1 '', 'N', 'Y') AS 'Password' FROM \`mysql\`.\`user\``;
	return [`${base}${range} ORDER BY \`User\` ASC, \`Host\` ASC;`, `${base} ;`];
}

/** The GRANT for one database row when copying a user, from getDbSpecificPrivsQueriesForChangeOrCopyUser(). */
export function copyDatabaseGrant(privileges: string[], db: string, username: string, hostname: string, withGrant: boolean): string {
	return `GRANT ${privileges.join(', ')} ON ${backquote(db)}.* TO ${userHost(username, hostname)}${withGrant ? ' WITH GRANT OPTION;' : ';'}`;
}

export interface ColumnPrivs {
	Select: string[];
	Insert: string[];
	Update: string[];
	References: string[];
}

/** The GRANT for one tables_priv row when copying a user, from getTablePrivsQueriesForChangeOrCopyUser(). */
export function copyTableGrant(privileges: string[], columns: ColumnPrivs, row: { Db: string; Table_name: string; Table_priv: string; }, username: string, hostname: string): string {
	const privs = [...privileges];
	for (const name of ['Select', 'Insert', 'Update', 'References'] as const) {
		const upper = name.toUpperCase();
		if (columns[name].length > 0 && !privs.includes(upper)) {
			privs.push(`${upper} (\`${columns[name].join('`, `')}\`)`);
		}
	}
	const withGrant = row.Table_priv.split(',').includes('Grant');
	return `GRANT ${privs.join(', ')} ON ${backquote(row.Db)}.${backquote(row.Table_name)} TO ${userHost(username, hostname)}${withGrant ? ' WITH GRANT OPTION;' : ';'}`;
}

/** Adds one columns_priv row's Column_priv to the per-privilege column lists. */
export function addColumnPrivs(columns: ColumnPrivs, columnName: string, columnPriv: string): void {
	const privs = new Set(columnPriv.split(','));
	for (const name of ['Select', 'Insert', 'Update', 'References'] as const) {
		if (privs.has(name)) {
			columns[name].push(columnName);
		}
	}
}

/** The statements of addUserAndCreateDatabase() for the "database for user account" options. */
export function createDatabaseQueries(username: string, hostname: string, dbname: unknown, options: { createDb1: boolean; createDb2: boolean; createDb3: boolean; }): { createDatabase?: string; grants: string[]; } {
	const account = userHost(username, hostname);
	const grants: string[] = [];
	let createDatabase: string | undefined;
	if (options.createDb1) {
		createDatabase = `CREATE DATABASE IF NOT EXISTS ${backquote(username)};`;
		grants.push(`GRANT ALL PRIVILEGES ON ${backquote(escapeMysqlWildcards(username))}.* TO ${account};`);
	}
	if (options.createDb2) {
		grants.push(`GRANT ALL PRIVILEGES ON ${backquote(String.raw`${escapeMysqlWildcards(username)}\_%`)}.* TO ${account};`);
	}
	if (options.createDb3) {
		grants.push(`GRANT ALL PRIVILEGES ON ${backquote(dbname)}.* TO ${account};`);
	}
	return { createDatabase, grants };
}

/** What updatePassword() runs and shows for one server type. */
export interface PasswordQueries {
	/** The query shown on failure. */
	sqlQuery: string;
	localQuery: string;
}

/** The ALTER USER / SET PASSWORD statements of updatePassword() for servers that need no extra queries. */
export function passwordQueries(server: ServerFlavor, username: string, hostname: string, plugin: string, password: string): PasswordQueries | null {
	const account = `'${escapeString(username)}'@'${escapeString(hostname)}'`;
	if (!server.isMariaDb && server.version >= 50706) {
		let prefix = `ALTER USER ${account} IDENTIFIED BY '`;
		if (plugin !== 'mysql_old_password') {
			prefix = `ALTER USER ${account} IDENTIFIED WITH ${plugin} BY '`;
		}
		return { sqlQuery: `${prefix}*'`, localQuery: `${prefix}${escapeString(password)}'` };
	}
	if (server.isMariaDb && server.version >= 10000) {
		const query = `SET PASSWORD FOR  ${account} = PASSWORD ('${escapeString(password)}')`;
		return { sqlQuery: query, localQuery: query };
	}
	return null;
}

/** The SET PASSWORD shown for old servers, which hides the password behind asterisks. */
export function maskedSetPassword(username: string, hostname: string, password: string): string {
	let value = '\'\'';
	if (password !== '') {
		// preg_replace('@.@s') without the u modifier masks every byte.
		value = `PASSWORD('${'*'.repeat(new TextEncoder().encode(password).length)}')`;
	}
	return `SET PASSWORD FOR '${escapeString(username)}'@'${escapeString(hostname)}' = ${value}`;
}

/** Whether a mysql.user row (as fetched) has a password, as getUsersOverview() decides. */
export function rowHasPassword(row: Record<string, unknown> | null): boolean {
	if (row === null) {
		return false;
	}
	const filled = (value: unknown): boolean => isSet(value) && value !== '' && value !== '0';
	return filled(row.authentication_string) || filled(row.Password);
}

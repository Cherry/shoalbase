import { describe, expect, it } from 'vitest';

import {
	type AddUserInput,
	addColumnPrivs,
	copyDatabaseGrant,
	copyTableGrant,
	createDatabaseQueries,
	dbRightsForUserOverviewQuery,
	deleteUsersQueries,
	exportUserParts,
	generateQueriesForUpdatePrivileges,
	getSqlQueriesForDisplayAndAddUser,
	getSqlQueryForDisplayPrivTable,
	maskedSetPassword,
	needsHashedPassword,
	passwordHashingQuery,
	passwordQueries,
	revokeQueries,
	rowHasPassword,
	userHost,
	userOverviewQueries,
	userSpecificRightsQueries,
} from './queries.ts';

const MYSQL84 = { isMariaDb: false, version: 80400 };
const MYSQL57 = { isMariaDb: false, version: 50744 };
const MYSQL55 = { isMariaDb: false, version: 50540 };
const MARIADB = { isMariaDb: true, version: 120303 };

function addUser(input: Partial<AddUserInput>) {
	return getSqlQueriesForDisplayAndAddUser({
		username: 'u',
		hostname: '%',
		password: '',
		server: MYSQL84,
		mariaDbPwdPluginActive: false,
		privileges: ['SELECT'],
		post: {},
		globals: new Map(),
		isGrantUser: true,
		...input,
	});
}

describe('account and privilege table queries', () => {
	it('escapes the account parts', () => {
		expect(userHost('o\'neil', '%')).toBe(String.raw`'o\'neil'@'%'`);
	});

	it('reads the user, database or table privilege row', () => {
		expect(getSqlQueryForDisplayPrivTable('*', '*', 'u', 'h')).toBe('SELECT * FROM `mysql`.`user` WHERE `User` = \'u\' AND `Host` = \'h\';');
		expect(getSqlQueryForDisplayPrivTable(String.raw`d\_b`, '*', 'u', 'h')).toBe('SELECT * FROM `mysql`.`db` WHERE `User` = \'u\' AND `Host` = \'h\' AND `Db` = \'d\\\\_b\'');
		expect(getSqlQueryForDisplayPrivTable(String.raw`d\_b`, 't', 'u', 'h')).toBe('SELECT `Table_priv` FROM `mysql`.`tables_priv` WHERE `User` = \'u\' AND `Host` = \'h\' AND `Db` = \'d_b\' AND `Table_name` = \'t\';');
	});
});

describe('getSqlQueriesForDisplayAndAddUser', () => {
	it('uses IDENTIFIED WITH ... BY with the cleartext password and ALTER USER on MySQL 8', () => {
		const post = { authentication_plugin: 'caching_sha2_password', pred_password: 'userdefined', pma_pw: 'p\'w', Grant_priv: 'Y', max_questions: '3', ssl_type: 'ANY' };
		const sql = addUser({ post, hostname: '10.%' });
		expect(sql.createUserReal).toBe('CREATE USER \'u\'@\'10.%\' IDENTIFIED WITH caching_sha2_password BY \'p\'w\';');
		expect(sql.createUserShow).toBe('CREATE USER \'u\'@\'10.%\' IDENTIFIED WITH caching_sha2_password BY \'***\';');
		expect(sql.realSqlQuery).toBe('GRANT SELECT ON *.* TO \'u\'@\'10.%\' WITH GRANT OPTION;');
		expect(sql.alterRealSqlQuery).toBe('ALTER USER \'u\'@\'10.%\' REQUIRE SSL WITH MAX_QUERIES_PER_HOUR 3;');
		expect(sql.passwordSetReal).toBeNull();
		expect(sql.passwordSetShow).toBeNull();
	});

	it('adds IDENTIFIED BY on MySQL 8 when no plugin was posted, and keeps a copied hash', () => {
		const sql = addUser({ post: { pred_password: 'keep' }, password: 'h\'ash' });
		expect(sql.createUserReal).toBe(String.raw`CREATE USER 'u'@'%' IDENTIFIED BY 'h\'ash';`);
		expect(sql.alterSqlQuery).toBe('ALTER USER \'u\'@\'%\' REQUIRE NONE;');
		expect(addUser({ post: { pred_password: 'userdefined' } }).createUserReal).toBe('CREATE USER \'u\'@\'%\' IDENTIFIED BY \'\';');
	});

	it('uses VIA ... USING with the hashed password on MariaDB', () => {
		const post = { authentication_plugin: 'mysql_native_password', pred_password: 'userdefined', Grant_priv: 'Y' };
		const sql = addUser({ server: MARIADB, post, hashedPassword: '*HASH' });
		expect(sql.createUserReal).toBe('CREATE USER \'u\'@\'%\' IDENTIFIED VIA mysql_native_password USING \'*HASH\';');
		expect(sql.realSqlQuery).toBe('GRANT SELECT ON *.* TO \'u\'@\'%\' REQUIRE NONE WITH GRANT OPTION;');
		expect(sql.alterRealSqlQuery).toBe('');
	});

	it('sends the cleartext password with IDENTIFIED BY when a MariaDB password check plugin is active', () => {
		const post = { authentication_plugin: 'mysql_native_password', pred_password: 'userdefined', pma_pw: 'clear' };
		expect(addUser({ server: MARIADB, post, mariaDbPwdPluginActive: true }).createUserReal).toBe('CREATE USER \'u\'@\'%\' IDENTIFIED BY \'clear\';');
		expect(addUser({ server: MARIADB, post: { pred_password: 'none' } }).createUserReal).toBe('CREATE USER \'u\'@\'%\' IDENTIFIED BY \'\';');
	});

	it('uses IDENTIFIED WITH ... AS on MySQL 5.7', () => {
		const post = { authentication_plugin: 'mysql_native_password', pred_password: 'userdefined' };
		expect(addUser({ server: MYSQL57, post, hashedPassword: '*H' }).createUserReal).toBe('CREATE USER \'u\'@\'%\' IDENTIFIED WITH mysql_native_password AS \'*H\';');
		expect(addUser({ server: MYSQL57, post: { pred_password: 'none' } }).createUserReal).toBe('CREATE USER \'u\'@\'%\' AS \'\';');
	});

	it('sets the password separately before MySQL 5.7.6', () => {
		const keep = addUser({ server: MYSQL55, post: { pred_password: 'keep' }, password: '*OLD' });
		expect(keep.createUserReal).toBe('CREATE USER \'u\'@\'%\';');
		expect(keep.passwordSetReal).toBe('SET PASSWORD FOR \'u\'@\'%\' = \'*OLD\';');
		expect(keep.passwordSetShow).toBe('SET PASSWORD FOR \'u\'@\'%\' = \'***\';');
		expect(addUser({ server: MYSQL55, post: { pred_password: 'none' } }).passwordSetReal).toBe('SET PASSWORD FOR \'u\'@\'%\' = \'\';');
		expect(addUser({ server: MYSQL55, post: {}, hashedPassword: '*NEW' }).passwordSetReal).toBe('SET PASSWORD FOR \'u\'@\'%\' = \'*NEW\';');
		expect(addUser({ server: MYSQL55, post: {} }).passwordSetReal).toBe('SET PASSWORD FOR \'u\'@\'%\' = \'\';');
	});

	it('leaves out the GRANT for accounts without the global grant option', () => {
		const sql = addUser({ isGrantUser: false, post: { pred_password: 'none' } });
		expect(sql.realSqlQuery).toBe('');
		expect(sql.sqlQuery).toBe('');
	});

	it('only hashes a typed password where the server needs a hash', () => {
		expect(needsHashedPassword(MYSQL84, false, 'userdefined')).toBe(false);
		expect(needsHashedPassword(MYSQL57, false, 'userdefined')).toBe(true);
		expect(needsHashedPassword(MARIADB, false, undefined)).toBe(true);
		expect(needsHashedPassword(MARIADB, true, 'userdefined')).toBe(false);
		expect(needsHashedPassword(MYSQL55, false, 'userdefined')).toBe(true);
		expect(needsHashedPassword(MYSQL57, false, 'keep')).toBe(false);
		expect(needsHashedPassword(MYSQL57, false, 'none')).toBe(false);
	});

	it('picks old_passwords for the hashing plugin', () => {
		expect(passwordHashingQuery('sha256_password')).toBe('SET `old_passwords` = 2;');
		expect(passwordHashingQuery('mysql_old_password')).toBe('SET `old_passwords` = 1;');
		expect(passwordHashingQuery('caching_sha2_password')).toBe('SET `old_passwords` = 0;');
	});
});

describe('privilege updates', () => {
	const base = { itemType: '', dbAndTable: '*.*', username: 'u', hostname: '%', dbname: '', privileges: ['SELECT'], globals: new Map() };

	it('moves REQUIRE and WITH into ALTER USER on MySQL 8', () => {
		const post = { Grant_priv: 'Y', max_questions: '1', ssl_type: 'X509' };
		expect(generateQueriesForUpdatePrivileges({ ...base, server: MYSQL84, post })).toEqual([
			'GRANT SELECT ON  *.* TO \'u\'@\'%\';',
			'ALTER USER \'u\'@\'%\'  REQUIRE X509 WITH MAX_QUERIES_PER_HOUR 1;',
		]);
		expect(generateQueriesForUpdatePrivileges({ ...base, dbname: 'd', dbAndTable: '`d`.*', server: MYSQL84, post: {} })).toEqual([
			'GRANT SELECT ON  `d`.* TO \'u\'@\'%\';',
			'ALTER USER \'u\'@\'%\' ;',
		]);
	});

	it('appends REQUIRE and WITH to the GRANT elsewhere', () => {
		const post = { Grant_priv: 'Y' };
		expect(generateQueriesForUpdatePrivileges({ ...base, itemType: 'PROCEDURE', dbname: 'd', dbAndTable: '`d`.`p`', server: MARIADB, post })).toEqual([
			'GRANT SELECT ON PROCEDURE `d`.`p` TO \'u\'@\'%\' WITH GRANT OPTION;',
			null,
		]);
		expect(generateQueriesForUpdatePrivileges({ ...base, server: MARIADB, post: {} })).toEqual(['GRANT SELECT ON  *.* TO \'u\'@\'%\' REQUIRE NONE;', null]);
	});

	it('revokes all privileges and the grant option', () => {
		expect(revokeQueries('FUNCTION', '`d`.`f`', 'u', 'h')).toEqual([
			'REVOKE ALL PRIVILEGES ON FUNCTION `d`.`f` FROM \'u\'@\'h\';',
			'REVOKE GRANT OPTION ON FUNCTION `d`.`f` FROM \'u\'@\'h\';',
		]);
	});
});

describe('account removal and export', () => {
	it('drops each selected account, and its database on request', () => {
		expect(deleteUsersQueries(['a&amp;#27;%', 'b`c&amp;#27;h'], ['first'], true)).toEqual([
			'first',
			'# Deleting \'a\'@\'%\' ...',
			'DROP USER \'a\'@\'%\';',
			'DROP DATABASE IF EXISTS `a`;',
			'# Deleting \'b`c\'@\'h\' ...',
			'DROP USER \'b`c\'@\'h\';',
			'DROP DATABASE IF EXISTS `b``c`;',
		]);
		// explode() keeps only the part before a second separator as the host.
		expect(deleteUsersQueries(['a&amp;#27;h&amp;#27;x'], [], false)).toEqual(['# Deleting \'a\'@\'h\' ...', 'DROP USER \'a\'@\'h\';']);
	});

	it('gives null for the entries upstream fails on with a TypeError, before dropping anyone', () => {
		expect(deleteUsersQueries(['a&amp;#27;%', 'x'], [], false)).toBeNull();
		expect(deleteUsersQueries([['a&amp;#27;%']], [], false)).toBeNull();
	});

	it('splits an exported account at the first ampersand and the last semicolon', () => {
		expect(exportUserParts('pma&amp;#27;local;host')).toEqual(['pma', 'host']);
		expect(exportUserParts('plain')).toEqual(['', 'lain']);
	});
});

describe('user listing queries', () => {
	it('unions the privilege tables that exist for database rights', () => {
		const { union, main, key } = userSpecificRightsQueries('u', 'h', 'database', '', ['db', 'tables_priv', 'procs_priv']);
		expect(key).toBe('Db');
		expect(union).toContain('SELECT DISTINCT `Db`\n                FROM `mysql`.`tables_priv` WHERE `User` = \'u\' AND `Host` = \'h\') UNION (');
		expect(union).not.toContain('columns_priv');
		expect(union.endsWith(') ORDER BY `Db` ASC')).toBe(true);
		expect(main).toBe('SELECT * FROM `mysql`.`db` WHERE `User` = \'u\' AND `Host` = \'h\' ORDER BY `Db` ASC');
	});

	it('limits table and routine rights to the database', () => {
		const table = userSpecificRightsQueries('u', 'h', 'table', 'd_b', ['columns_priv']);
		expect(table.key).toBe('Table_name');
		expect(table.main).toBe('SELECT `Table_name`, `Table_priv`, IF(`Column_priv` = _latin1 \'\', 0, 1) AS \'Column_priv\' FROM `mysql`.`tables_priv` WHERE `User` = \'u\' AND `Host` = \'h\' AND `Db` LIKE \'d_b\' ORDER BY `Table_name` ASC;');
		const routine = userSpecificRightsQueries('u', 'h', 'routine', 'd', ['procs_priv']);
		expect(routine.union).toContain('SELECT DISTINCT `Routine_name`');
		expect(routine.main).toBe('SELECT `Routine_name`, `Proc_priv` FROM `mysql`.`procs_priv` WHERE `User` = \'u\' AND `Host` = \'h\' AND `Db` LIKE \'d\' ORDER BY `Routine_name`');
	});

	it('lists the accounts of every privilege table', () => {
		expect(dbRightsForUserOverviewQuery(['user', 'db'], ' WHERE `User` = \'\'')).toBe('(SELECT DISTINCT `User`, `Host` FROM `mysql`.`user`  WHERE `User` = \'\') UNION (SELECT DISTINCT `User`, `Host` FROM `mysql`.`db`  WHERE `User` = \'\') ORDER BY `User` ASC, `Host` ASC');
	});

	it('reads the password column the server has', () => {
		expect(userOverviewQueries(MYSQL84, '')).toEqual([
			'SELECT *, IF(`authentication_string` = _latin1 \'\', \'N\', \'Y\') AS \'Password\' FROM `mysql`.`user` ORDER BY `User` ASC, `Host` ASC;',
			'SELECT *, IF(`authentication_string` = _latin1 \'\', \'N\', \'Y\') AS \'Password\' FROM `mysql`.`user` ;',
		]);
		expect(userOverviewQueries(MARIADB, ' WHERE x')[0]).toBe('SELECT *, IF(`Password` = _latin1 \'\', \'N\', \'Y\') AS \'Password\' FROM `mysql`.`user` WHERE x ORDER BY `User` ASC, `Host` ASC;');
	});
});

describe('copying an account', () => {
	it('grants the database privileges of the old account', () => {
		expect(copyDatabaseGrant(['SELECT'], 'd_b', 'n', '%', true)).toBe('GRANT SELECT ON `d_b`.* TO \'n\'@\'%\' WITH GRANT OPTION;');
		expect(copyDatabaseGrant(['ALL PRIVILEGES'], 'd', 'n', '%', false)).toBe('GRANT ALL PRIVILEGES ON `d`.* TO \'n\'@\'%\';');
	});

	it('adds column privileges the table grant does not already cover', () => {
		const columns = { Select: [], Insert: [], Update: [], References: [] };
		addColumnPrivs(columns, 'a', 'Select,Update');
		addColumnPrivs(columns, 'b', 'Update,References,Insert');
		expect(columns).toEqual({ Select: ['a'], Insert: ['b'], Update: ['a', 'b'], References: ['b'] });
		const row = { Db: 'd', Table_name: 't', Table_priv: 'Select,Grant' };
		expect(copyTableGrant(['SELECT'], columns, row, 'n', 'h')).toBe('GRANT SELECT, INSERT (`b`), UPDATE (`a`, `b`), REFERENCES (`b`) ON `d`.`t` TO \'n\'@\'h\' WITH GRANT OPTION;');
		expect(copyTableGrant(['USAGE'], { Select: [], Insert: [], Update: [], References: [] }, { ...row, Table_priv: '' }, 'n', 'h')).toBe('GRANT USAGE ON `d`.`t` TO \'n\'@\'h\';');
	});
});

describe('database for a new account', () => {
	it('creates the same-name database and grants on it, the wildcard name and the chosen database', () => {
		const queries = createDatabaseQueries('my_user', '%', 'other', { createDb1: true, createDb2: true, createDb3: true });
		expect(queries).toEqual({
			createDatabase: 'CREATE DATABASE IF NOT EXISTS `my_user`;',
			grants: [
				'GRANT ALL PRIVILEGES ON `my\\_user`.* TO \'my_user\'@\'%\';',
				'GRANT ALL PRIVILEGES ON `my\\_user\\_%`.* TO \'my_user\'@\'%\';',
				'GRANT ALL PRIVILEGES ON `other`.* TO \'my_user\'@\'%\';',
			],
		});
		expect(createDatabaseQueries('u', '%', null, { createDb1: false, createDb2: false, createDb3: false })).toEqual({ createDatabase: undefined, grants: [] });
	});
});

describe('password changes', () => {
	it('uses ALTER USER on MySQL 5.7.6 and later, hiding the password in the shown query', () => {
		expect(passwordQueries(MYSQL84, 'u', '%', 'caching_sha2_password', 'p\'w')).toEqual({
			sqlQuery: 'ALTER USER \'u\'@\'%\' IDENTIFIED WITH caching_sha2_password BY \'*\'',
			localQuery: String.raw`ALTER USER 'u'@'%' IDENTIFIED WITH caching_sha2_password BY 'p\'w'`,
		});
		expect(passwordQueries(MYSQL57, 'u', '%', 'mysql_old_password', 'x')?.localQuery).toBe('ALTER USER \'u\'@\'%\' IDENTIFIED BY \'x\'');
	});

	it('uses SET PASSWORD on MariaDB 10, showing the password as upstream does', () => {
		const query = 'SET PASSWORD FOR  \'u\'@\'%\' = PASSWORD (\'x\')';
		expect(passwordQueries(MARIADB, 'u', '%', 'mysql_native_password', 'x')).toEqual({ sqlQuery: query, localQuery: query });
	});

	it('leaves older servers to the legacy statements', () => {
		expect(passwordQueries(MYSQL55, 'u', '%', 'mysql_native_password', 'x')).toBeNull();
		expect(maskedSetPassword('u', '%', '')).toBe('SET PASSWORD FOR \'u\'@\'%\' = \'\'');
		expect(maskedSetPassword('u', '%', 'aé')).toBe('SET PASSWORD FOR \'u\'@\'%\' = PASSWORD(\'***\')');
	});
});

describe('rowHasPassword', () => {
	it('checks authentication_string and the old Password column', () => {
		expect(rowHasPassword(null)).toBe(false);
		expect(rowHasPassword({ authentication_string: '', Password: '*X' })).toBe(true);
		expect(rowHasPassword({ authentication_string: '$A$hash' })).toBe(true);
		expect(rowHasPassword({ authentication_string: '0', Password: null })).toBe(false);
	});
});

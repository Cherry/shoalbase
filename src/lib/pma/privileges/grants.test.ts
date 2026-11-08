import { describe, expect, it } from 'vitest';

import {
	extractPrivInfo,
	fillInTablePrivileges,
	getDataForDbInfo,
	getRequireClause,
	getWithClause,
	hasGrantOption,
	isEmpty,
	isSet,
	isWildcardDbname,
	looseCountEquals,
	looseRequestEquals,
	looseStringEquals,
	needsAlterUser,
	parseProcPriv,
	parseTablePrivTypes,
	rangeOfUsers,
	unescapeMysqlWildcards,
	updatePasswordError,
	wildcardEscapeForGrant,
} from './grants.ts';

const noGlobals = { globals: new Map<string, unknown>() };

describe('PHP value helpers', () => {
	it('treats null and undefined as unset', () => {
		expect(isSet(null)).toBe(false);
		expect(isSet(undefined)).toBe(false);
		expect(isSet('')).toBe(true);
	});

	it('follows empty() for strings, numbers and arrays', () => {
		expect(['', '0', 0, false, null, undefined, []].every(value => isEmpty(value))).toBe(true);
		expect(isEmpty('00')).toBe(false);
		expect(isEmpty(['a'])).toBe(false);
	});

	it('compares a count with a request value like PHP 8 ==', () => {
		expect(looseCountEquals(0, undefined)).toBe(true);
		expect(looseCountEquals(2, null)).toBe(false);
		expect(looseCountEquals(3, 3)).toBe(true);
		expect(looseCountEquals(3, ' 3')).toBe(true);
		expect(looseCountEquals(3, '3abc')).toBe(false);
		expect(looseCountEquals(3, ['3'])).toBe(false);
	});

	it('compares numeric strings as numbers', () => {
		expect(looseStringEquals('1', '01')).toBe(true);
		expect(looseStringEquals('a', 'A')).toBe(false);
	});

	it('compares request arrays element by element and never equal to a string', () => {
		expect(looseRequestEquals(['1', 'a'], ['01', 'a'])).toBe(true);
		expect(looseRequestEquals(['a'], ['a', 'b'])).toBe(false);
		expect(looseRequestEquals(['a'], ['b'])).toBe(false);
		expect(looseRequestEquals(['a'], 'a')).toBe(false);
	});
});

describe('updatePasswordError', () => {
	it('compares the two fields loosely, so equal numeric strings match', () => {
		expect(updatePasswordError({ pma_pw: '10', pma_pw2: '1e1' })).toBeNull();
		expect(updatePasswordError({ pma_pw: 'a', pma_pw2: 'b' })).toBe('The passwords aren\'t the same!');
	});

	it('rejects an empty password, including "0"', () => {
		expect(updatePasswordError({ pma_pw: '', pma_pw2: '' })).toBe('The password is empty!');
		expect(updatePasswordError({ pma_pw: '0', pma_pw2: '0' })).toBe('The password is empty!');
		expect(updatePasswordError({ pma_pw: [], pma_pw2: [] })).toBe('The password is empty!');
	});

	it('skips the checks without both fields or with nopass', () => {
		expect(updatePasswordError({ pma_pw: 'a' })).toBeNull();
		expect(updatePasswordError({ pma_pw: 'a', pma_pw2: 'b', nopass: '1' })).toBeNull();
		expect(updatePasswordError({ pma_pw: ['a'], pma_pw2: ['a'] })).toBeNull();
	});
});

describe('extractPrivInfo', () => {
	it('lists the Y privileges of a row with their descriptions', () => {
		const row = { Select_priv: 'Y', Insert_priv: 'N', Grant_priv: 'Y' };
		expect(extractPrivInfo(row, false, false, noGlobals)).toEqual(['SELECT']);
		expect(extractPrivInfo(row, true, false, noGlobals)).toEqual(['<dfn title="Allows reading data.">SELECT</dfn>']);
	});

	it('gives USAGE without any granted privilege', () => {
		expect(extractPrivInfo({ Select_priv: 'N' }, false, false, noGlobals)).toEqual(['USAGE']);
		expect(extractPrivInfo({}, true, false, noGlobals)).toEqual(['<dfn title="No privileges.">USAGE</dfn>']);
	});

	it('collapses a full row into ALL PRIVILEGES unless grant_count disagrees', () => {
		const row = { Select_priv: 'Y', Execute_priv: 'Y' };
		expect(extractPrivInfo(row, false, false, noGlobals)).toEqual(['ALL PRIVILEGES']);
		expect(extractPrivInfo(row, true, false, noGlobals)).toEqual(['<dfn title="Includes all privileges except GRANT.">ALL PRIVILEGES</dfn>']);
		expect(extractPrivInfo(row, false, false, { ...noGlobals, grantCount: '2' })).toEqual(['ALL PRIVILEGES']);
		expect(extractPrivInfo(row, false, false, { ...noGlobals, grantCount: '29' })).toEqual(['SELECT', 'EXECUTE']);
	});

	it('reads the posted privileges from the globals when there is no row', () => {
		const globals = new Map<string, unknown>([['Select_priv', 'Y'], ['Update_priv', 'N'], ['Create_user_priv', 'Y']]);
		expect(extractPrivInfo(null, false, false, { globals })).toEqual(['SELECT', 'CREATE USER']);
	});

	it('turns column lists into column privileges, or the whole privilege when every column is chosen', () => {
		const globals = new Map<string, unknown>([['Select_priv', ['a', 'b']], ['Insert_priv', ['a`b']]]);
		expect(extractPrivInfo(null, false, false, { globals, columnCount: '2', grantCount: '13' })).toEqual(['SELECT', 'INSERT (`a``b`)']);
		// Column lists do not stop the ALL PRIVILEGES shortcut when no grant_count is posted.
		expect(extractPrivInfo(null, false, false, { globals, columnCount: '2' })).toEqual(['ALL PRIVILEGES']);
		expect(extractPrivInfo(null, true, false, { globals, columnCount: '3', grantCount: '13' })).toEqual([
			'<dfn title="Allows reading data.">SELECT</dfn> (`a`, `b`)',
			'<dfn title="Allows inserting and replacing data.">INSERT</dfn> (`a``b`)',
		]);
	});

	it('ignores column lists flagged with a _none global', () => {
		const globals = new Map<string, unknown>([['Select_priv', ['a']], ['Select_priv_none', '1']]);
		expect(extractPrivInfo(null, false, false, { globals, columnCount: '1' })).toEqual(['USAGE']);
	});

	it('also applies posted column lists to a row that lacks the privilege', () => {
		const globals = new Map<string, unknown>([['Select_priv', ['a']]]);
		expect(extractPrivInfo({ Select_priv: 'N' }, false, false, { globals, grantCount: '13' })).toEqual(['SELECT (`a`)']);
	});

	it('uses the table grant names for table privileges', () => {
		const row = { 'Delete': 'Y', 'Create': 'N', 'Create View': 'Y' };
		expect(extractPrivInfo(row, false, true, noGlobals)).toEqual(['DELETE', 'CREATE_VIEW']);
	});
});

describe('table and routine privileges', () => {
	it('reads the members of the Table_priv SET type', () => {
		expect(parseTablePrivTypes('set(\'Select\',\'Insert\',\'Create View\')')).toEqual(['Select', 'Insert', 'Create View']);
	});

	it('replaces Table_priv with one Y/N entry per available privilege', () => {
		const filled = fillInTablePrivileges({ Table_name: 't', Table_priv: 'Select,Grant' }, ['Select', 'Insert', 'Grant']);
		expect(filled).toEqual({ Table_name: 't', Select_priv: 'Y', Insert_priv: 'N', Grant_priv: 'Y' });
		expect(fillInTablePrivileges({ Table_priv: null }, ['Select'])).toEqual({ Select_priv: 'N' });
	});

	it('maps Proc_priv names to their privilege columns', () => {
		expect(parseProcPriv('Execute,Alter Routine,Grant')).toEqual({ Alter_routine_priv: 'Y', Execute_priv: 'Y', Grant_priv: 'Y' });
		// An empty Proc_priv still yields a stray "_priv" entry, as upstream's explode() does.
		expect(parseProcPriv(null)).toEqual({ Alter_routine_priv: 'N', Execute_priv: 'N', Grant_priv: 'N', _priv: 'Y' });
	});
});

describe('names in GRANT statements', () => {
	it('unescapes wildcards only where a backslash precedes them', () => {
		expect(unescapeMysqlWildcards(String.raw`a\_b\%c_d\x`)).toBe(String.raw`a_b%c_d\x`);
	});

	it('quotes the database and table of a grant', () => {
		expect(wildcardEscapeForGrant('', 't')).toBe('*.*');
		expect(wildcardEscapeForGrant(String.raw`my\_db`, 't`1')).toBe('`my_db`.`t``1`');
		expect(wildcardEscapeForGrant(String.raw`my\_db`, '')).toBe('`my\\_db`.*');
	});

	it('tells unescaped wildcards apart from escaped ones', () => {
		expect(isWildcardDbname('a_b')).toBe(true);
		expect(isWildcardDbname('a%')).toBe(true);
		expect(isWildcardDbname(String.raw`a\_b`)).toBe(false);
	});

	it('limits the user list to an initial', () => {
		expect(rangeOfUsers(null)).toBe('');
		expect(rangeOfUsers('')).toBe(' WHERE `User` = \'\'');
		expect(rangeOfUsers('P')).toBe(' WHERE `User` LIKE \'P%\' OR `User` LIKE \'p%\'');
		// Both the LIKE escape and escapeString() add a backslash.
		expect(rangeOfUsers('_')).toBe(' WHERE `User` LIKE \'\\\\_%\' OR `User` LIKE \'\\\\_%\'');
		expect(rangeOfUsers('\'')).toBe(' WHERE `User` LIKE \'\\\'%\' OR `User` LIKE \'\\\'%\'');
	});
});

describe('getDataForDbInfo', () => {
	it('reads the account and object names from the request', () => {
		const info = getDataForDbInfo({}, { username: 'u', hostname: '%', dbname: 'db_1', tablename: 't', routinename: 'r' });
		expect(info).toEqual({ username: 'u', hostname: '%', dbname: 'db_1', tablename: 't', routinename: 'r', dbnameIsWildcard: true });
	});

	it('prefers the dropdown values and drops the table without a database', () => {
		const post = { pred_tablename: 'pt', pred_routinename: 'pr' };
		expect(getDataForDbInfo(post, { tablename: 't', routinename: 'r', dbname: '' })).toEqual({
			username: null, hostname: null, dbname: null, tablename: null, routinename: 'pr', dbnameIsWildcard: false,
		});
		expect(getDataForDbInfo(post, { dbname: 'db' }).tablename).toBe('pt');
	});

	it('takes several posted databases as a list and a single one as a name', () => {
		expect(getDataForDbInfo({ pred_dbname: ['a', 'b'] }, {}).dbname).toEqual(['a', 'b']);
		expect(getDataForDbInfo({ pred_dbname: ['a'] }, {}).dbname).toBe('a');
		expect(getDataForDbInfo({ pred_dbname: ['a', ''] }, { dbname: 'x' }).dbname).toBe('x');
	});

	it('accepts a dbname list only without empty entries', () => {
		expect(getDataForDbInfo({}, { dbname: ['a', 'b'] }).dbname).toEqual(['a', 'b']);
		expect(getDataForDbInfo({}, { dbname: ['a', '0'] }).dbname).toBeNull();
	});

	it('casts list account names like PHP', () => {
		expect(getDataForDbInfo({}, { username: ['x'], hostname: ['y'] })).toMatchObject({ username: 'Array', hostname: 'Array' });
	});
});

describe('REQUIRE and WITH clauses', () => {
	it('builds the SPECIFIED requirements from the post', () => {
		const post = { ssl_type: 'SPECIFIED', ssl_cipher: 'AES\'', x509_issuer: 'CA', x509_subject: 'me' };
		expect(getRequireClause(post, new Map())).toBe(String.raw` REQUIRE CIPHER 'AES\'' AND ISSUER 'CA' AND SUBJECT 'me'`);
		expect(getRequireClause({ ssl_type: 'SPECIFIED', ssl_cipher: '' }, new Map())).toBe(' REQUIRE NONE');
	});

	it('falls back to the copied user row when ssl_type is not posted', () => {
		const globals = new Map<string, unknown>([['ssl_type', 'X509'], ['ssl_cipher', 'x']]);
		expect(getRequireClause({}, globals)).toBe(' REQUIRE X509');
		expect(getRequireClause({}, new Map([['ssl_type', 'ANY']]))).toBe(' REQUIRE SSL');
		expect(getRequireClause({}, new Map([['ssl_type', '']]))).toBe(' REQUIRE NONE');
		expect(getRequireClause({ ssl_type: 'NONE' }, globals)).toBe(' REQUIRE NONE');
	});

	it('uses ALTER USER only on MySQL 8.0.11 and later', () => {
		expect(needsAlterUser(false, 80011)).toBe(true);
		expect(needsAlterUser(false, 80010)).toBe(false);
		expect(needsAlterUser(true, 120303)).toBe(false);
	});

	it('detects GRANT OPTION from the post or the copied row', () => {
		expect(hasGrantOption({ Grant_priv: 'Y' }, new Map())).toBe(true);
		expect(hasGrantOption({}, new Map([['Grant_priv', 'Y']]))).toBe(true);
		expect(hasGrantOption({ Grant_priv: 'N' }, new Map())).toBe(false);
	});

	it('adds GRANT OPTION before MySQL 8 and clamps negative limits', () => {
		const post = { Grant_priv: 'Y', max_questions: '-5', max_updates: '2x', max_connections: '3' };
		const globals = new Map<string, unknown>([['max_user_connections', '4']]);
		expect(getWithClause(post, globals, true, 120303)).toBe(' WITH GRANT OPTION MAX_QUERIES_PER_HOUR 0 MAX_CONNECTIONS_PER_HOUR 3 MAX_UPDATES_PER_HOUR 2 MAX_USER_CONNECTIONS 4');
		expect(getWithClause(post, new Map(), false, 80400)).toBe(' WITH MAX_QUERIES_PER_HOUR 0 MAX_CONNECTIONS_PER_HOUR 3 MAX_UPDATES_PER_HOUR 2');
		expect(getWithClause({}, new Map(), false, 80400)).toBe('');
	});
});

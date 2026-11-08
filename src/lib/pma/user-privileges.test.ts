import {
	describe,
	expect,
	it,
	vi,
} from 'vitest';

import {
	analyseShowGrants,
	checkRequiredPrivilegesForAdjust,
	getItemsFromShowGrantsRow,
	unrestrictedPrivileges,
} from './user-privileges.ts';

describe('getItemsFromShowGrantsRow', () => {
	// Expected values were produced by phpMyAdmin 5.2.3 in the oracle container, including its odd parse of role grants.
	it.each([
		['GRANT USAGE ON *.* TO `customer`@`%`', ['USAGE', '*', '*']],
		['GRANT ALL PRIVILEGES ON `customer\\_db`.* TO `customer`@`%`', ['ALL PRIVILEGES', String.raw`customer\_db`, '*']],
		['GRANT SELECT ON `db`.`tbl` TO `u`@`h`', ['SELECT', 'db', 'tbl']],
		['GRANT SELECT, INSERT ON `a.b`.`c.d` TO `u`@`%`', ['SELECT, INSERT', 'a.b', 'c.d']],
		['GRANT `role1`@`%` TO `u`@`%`', ['`role1`@`%` TO `', 'T `role1`@`%` TO `u`', 'RANT `role1`@`%`']],
		['GRANT PROXY ON \'\'@\'\' TO \'root\'@\'localhost\' WITH GRANT OPTION', ['PROXY', '\'\'@\'\' TO \'root\'@\'localhost\' WI', 'RANT PROXY ON \'\'@\'\'']],
		['GRANT SELECT (`id`) ON `db`.`t` TO `u`@`%`', ['SELECT (`id`)', 'db', 't']],
	])('splits %j', (row, expected) => {
		expect(getItemsFromShowGrantsRow(row)).toEqual(expected);
	});
});

describe('analyseShowGrants', () => {
	it('finds the customer database exists, so there is nothing to create', async () => {
		const useDatabase = vi.fn(async () => null);
		const privileges = await analyseShowGrants([
			'GRANT USAGE ON *.* TO `customer`@`%`',
			'GRANT ALL PRIVILEGES ON `customer\\_db`.* TO `customer`@`%`',
		], useDatabase);

		expect(useDatabase).toHaveBeenCalledWith('USE `customer_db`');
		expect(privileges).toEqual({
			isCreateDbPriv: false,
			isReloadPriv: false,
			dbToCreate: '',
			dbsWhereCreateTableAllowed: [String.raw`customer\_db`],
			dbsToTest: ['information_schema', 'performance_schema', 'mysql', 'sys', String.raw`customer\_db`],
			dbPriv: false,
			colPriv: false,
			tablePriv: false,
			procPriv: false,
		});
	});

	it('offers a missing database for creation and treats access denied as existing', async () => {
		const missing = await analyseShowGrants(['GRANT CREATE, SELECT ON `new\\_db`.* TO `u`@`%`'], async () => '#1049 - Unknown database');
		expect(missing).toMatchObject({ isCreateDbPriv: true, dbToCreate: 'new_db' });

		const denied = await analyseShowGrants(['GRANT CREATE ON `other`.* TO `u`@`%`'], async () => '#1044 - Access denied');
		expect(denied).toMatchObject({ isCreateDbPriv: false, dbToCreate: '' });
	});

	it('turns a wildcard grant into a database name prefix without probing it', async () => {
		const useDatabase = vi.fn(async () => null);
		const privileges = await analyseShowGrants([
			'GRANT ALL PRIVILEGES ON `user_%`.* TO `u`@`%`',
			'GRANT CREATE ON `second`.* TO `u`@`%`',
		], useDatabase);
		expect(useDatabase).not.toHaveBeenCalled();
		expect(privileges).toMatchObject({ isCreateDbPriv: true, dbToCreate: 'user_', dbsWhereCreateTableAllowed: ['user_%', 'second'] });
	});

	it('stops at a global CREATE privilege and lists every database', async () => {
		const privileges = await analyseShowGrants([
			'GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, RELOAD ON *.* TO `admin`@`%`',
			'GRANT ALL PRIVILEGES ON `ignored`.* TO `admin`@`%`',
		], async () => null);
		expect(privileges).toMatchObject({
			isCreateDbPriv: true,
			isReloadPriv: true,
			dbsWhereCreateTableAllowed: ['*'],
			dbsToTest: false,
			dbPriv: true,
			colPriv: true,
			tablePriv: true,
			procPriv: true,
		});
	});

	it('keeps the defaults when SHOW GRANTS failed', async () => {
		expect(await analyseShowGrants(null, async () => null)).toMatchObject({ isCreateDbPriv: false, dbsToTest: ['information_schema', 'performance_schema', 'mysql', 'sys'] });
	});

	it('does not record table-level grants once all databases are visible', async () => {
		const privileges = await analyseShowGrants(['GRANT SELECT ON *.* TO `r`@`%`', 'GRANT SELECT ON `db`.`t` TO `r`@`%`'], async () => null);
		expect(privileges.dbsToTest).toBe(false);
		expect(privileges.dbsWhereCreateTableAllowed).toEqual([]);
	});
});

describe('checkRequiredPrivilegesForAdjust', () => {
	const fresh = () => {
		return { ...unrestrictedPrivileges(), isReloadPriv: false, dbPriv: false, colPriv: false, tablePriv: false, procPriv: false };
	};

	it('grants each adjust privilege from the matching mysql table', () => {
		for (const [table, key] of [['columns_priv', 'colPriv'], ['db', 'dbPriv'], ['procs_priv', 'procPriv'], ['tables_priv', 'tablePriv']] as const) {
			const state = fresh();
			checkRequiredPrivilegesForAdjust(state, 'ALL', 'mysql', table);
			expect(state[key]).toBe(true);
			expect(Object.values({ colPriv: state.colPriv, dbPriv: state.dbPriv, procPriv: state.procPriv, tablePriv: state.tablePriv }).filter(Boolean)).toHaveLength(1);
		}
	});

	it('grants all of them for the whole mysql database, but not for other grants', () => {
		const state = fresh();
		checkRequiredPrivilegesForAdjust(state, 'SELECT, INSERT, UPDATE, DELETE', 'mysql', '*');
		expect(state).toMatchObject({ colPriv: true, dbPriv: true, procPriv: true, tablePriv: true, isReloadPriv: false });

		const other = fresh();
		checkRequiredPrivilegesForAdjust(other, 'SELECT', 'mysql', '*');
		checkRequiredPrivilegesForAdjust(other, 'ALL', 'mysql', 'user');
		expect(other).toMatchObject({ colPriv: false, dbPriv: false, procPriv: false, tablePriv: false });
	});

	it('also grants RELOAD for ALL PRIVILEGES on everything', () => {
		const state = fresh();
		checkRequiredPrivilegesForAdjust(state, 'ALL PRIVILEGES', '*', '*');
		expect(state).toMatchObject({ colPriv: true, dbPriv: true, procPriv: true, tablePriv: true, isReloadPriv: true });
	});

	it('describes an account running with --skip-grant-tables as unrestricted', () => {
		expect(unrestrictedPrivileges()).toMatchObject({ isCreateDbPriv: true, dbsWhereCreateTableAllowed: ['*'], dbsToTest: false });
	});
});

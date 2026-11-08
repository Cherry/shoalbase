import { describe, expect, it } from 'vitest';

import {
	type DbTabFlags,
	type TableTabFlags,
	currentUserPrivilegeQueries,
	filterAllowedTabs,
	getDbTabs,
	getMenuTabList,
	getServerTabs,
	getTableTabs,
	getUrlForOption,
	serverBreadcrumbName,
	stripInnoDbFree,
} from './menu.ts';

const customerServer = { isSuperUser: false, isCreateOrGrantUser: false, hasBinaryLogs: false };

const customerDb: DbTabFlags = {
	isSystemSchema: false,
	numTables: 1,
	isSuperUser: false,
	isCreateOrGrantUser: false,
	canEvent: true,
	canTrigger: true,
};

const customerTable: TableTabFlags = {
	isSystemSchema: false,
	isView: false,
	isUpdatableView: false,
	isSuperUser: false,
	isCreateOrGrantUser: false,
	canTrigger: true,
};

function activeTabs(tabs: Record<string, { active: boolean; }>): string[] {
	return Object.entries(tabs).filter(([, tab]) => tab.active).map(([name]) => name);
}

describe('getServerTabs', () => {
	it('hides User accounts, Binary log and Replication from an unprivileged customer', () => {
		expect(Object.keys(getServerTabs(customerServer, '/server/sql'))).toEqual([
			'databases', 'sql', 'status', 'export', 'import', 'settings', 'vars', 'charset', 'engine', 'plugins',
		]);
	});

	it('shows User accounts to grant or create users, but Replication only to super users', () => {
		const grantUser = getServerTabs({ ...customerServer, isCreateOrGrantUser: true }, '/');
		expect(grantUser.rights).toEqual({
			icon: 's_rights',
			route: '/server/privileges',
			text: 'User accounts',
			active: false,
			args: { viewing_mode: 'server' },
		});
		expect(grantUser.replication).toBeUndefined();
		const superUser = getServerTabs({ ...customerServer, isSuperUser: true, hasBinaryLogs: true }, '/');
		expect(Object.keys(superUser)).toEqual([
			'databases', 'sql', 'status', 'rights', 'export', 'import', 'settings', 'binlog', 'replication', 'vars', 'charset', 'engine', 'plugins',
		]);
	});

	it('marks grouped routes active on their parent tab', () => {
		const privileged = { ...customerServer, isSuperUser: true };
		expect(activeTabs(getServerTabs(privileged, '/server/status/monitor'))).toEqual(['status']);
		expect(activeTabs(getServerTabs(privileged, '/server/user-groups'))).toEqual(['rights']);
		expect(activeTabs(getServerTabs(privileged, '/preferences/two-factor'))).toEqual(['settings']);
		expect(activeTabs(getServerTabs(privileged, '/server/engines/InnoDB'))).toEqual([]);
	});
});

describe('getDbTabs', () => {
	it('gives the customer Events and Triggers only with those privileges, and never Privileges', () => {
		expect(Object.keys(getDbTabs(customerDb, 'customer_db', '/database/sql'))).toEqual([
			'structure', 'sql', 'search', 'query', 'export', 'import', 'operation', 'routines', 'events', 'triggers', 'designer',
		]);
		const noGrants = getDbTabs({ ...customerDb, canEvent: false, canTrigger: false }, 'customer_db', '/');
		expect(noGrants.events).toBeUndefined();
		expect(noGrants.triggers).toBeUndefined();
	});

	it('links Privileges to the server page scoped to the database', () => {
		const tabs = getDbTabs({ ...customerDb, isCreateOrGrantUser: true }, 'shop', '/server/privileges');
		expect(tabs.privileges.args).toEqual({ checkprivsdb: 'shop', viewing_mode: 'db' });
		expect(activeTabs(tabs)).toEqual(['privileges']);
	});

	it('keeps only read-only tabs on system schemas', () => {
		const tabs = getDbTabs({ ...customerDb, isSystemSchema: true, isSuperUser: true }, 'information_schema', '/database/qbe');
		expect(Object.keys(tabs)).toEqual(['structure', 'sql', 'search', 'query', 'export']);
		expect(activeTabs(tabs)).toEqual(['query']);
	});

	it('warns on Search, Query and Export for an empty database', () => {
		const tabs = getDbTabs({ ...customerDb, numTables: 0 }, 'empty', '/');
		expect(Object.entries(tabs).filter(([, tab]) => tab.warning === 'Database seems to be empty!').map(([name]) => name)).toEqual(['search', 'query', 'export']);
		expect(getDbTabs(customerDb, 'full', '/').search.warning).toBeUndefined();
	});
});

describe('getTableTabs', () => {
	it('builds the customer table menu with Browse at position 0 and single-table export', () => {
		const tabs = getTableTabs(customerTable, 'customer_db', 'players', '/table/sql');
		expect(Object.keys(tabs)).toEqual(['browse', 'structure', 'sql', 'search', 'insert', 'export', 'import', 'operation', 'triggers']);
		expect(tabs.browse.args).toEqual({ pos: 0 });
		expect(tabs.export.args).toEqual({ single_table: 'true' });
		expect(tabs.operation.route).toBe('/table/operations');
		expect(activeTabs(tabs)).toEqual(['sql']);
	});

	it('limits views to view operations, and allows Insert only on updatable views', () => {
		const view = getTableTabs({ ...customerTable, isView: true }, 'd', 'v', '/view/operations');
		expect(Object.keys(view)).toEqual(['browse', 'structure', 'sql', 'search', 'export', 'operation']);
		expect(view.operation.route).toBe('/view/operations');
		expect(activeTabs(view)).toEqual(['operation']);
		expect(getTableTabs({ ...customerTable, isView: true, isUpdatableView: true }, 'd', 'v', '/').insert).toBeDefined();
	});

	it('shows system schema tables as browse-only, even to super users', () => {
		const tabs = getTableTabs({ ...customerTable, isSystemSchema: true, isView: true, isSuperUser: true }, 'information_schema', 'TABLES', '/table/zoom-search');
		expect(Object.keys(tabs)).toEqual(['browse', 'structure', 'sql', 'search', 'export']);
		expect(activeTabs(tabs)).toEqual(['search']);
	});

	it('scopes Privileges to the table and marks Structure active on the relation view', () => {
		const tabs = getTableTabs({ ...customerTable, isSuperUser: true, canTrigger: false }, 'd', 't', '/table/relation');
		expect(tabs.privileges.args).toEqual({ checkprivsdb: 'd', checkprivstable: 't', viewing_mode: 'table' });
		expect(tabs.triggers).toBeUndefined();
		expect(activeTabs(tabs)).toEqual(['structure']);
	});
});

describe('filterAllowedTabs', () => {
	it('keeps the tab set order and drops tabs a user group disallows or the level does not know', () => {
		const tabs = getServerTabs({ isSuperUser: true, isCreateOrGrantUser: true, hasBinaryLogs: true }, '/');
		expect(Object.keys(filterAllowedTabs(tabs, 'server')).slice(-2)).toEqual(['engine', 'plugins']);
		expect(Object.keys(filterAllowedTabs(tabs, 'server', ['rights', 'binlog']))).not.toContain('rights');
		expect(Object.keys(filterAllowedTabs({ browse: tabs.sql, structure: tabs.sql }, 'db'))).toEqual(['structure']);
	});

	it('lists the configurable tabs per level with their user-group labels', () => {
		expect(getMenuTabList('server').rights).toBe('Users');
		expect(Object.keys(getMenuTabList('db'))).toContain('central_columns');
		expect(Object.keys(getMenuTabList('table'))).toHaveLength(11);
	});
});

describe('getUrlForOption', () => {
	it('maps DefaultTab settings, including legacy script names, and falls back to the home route', () => {
		expect(getUrlForOption('welcome', 'server')).toBe('/');
		expect(getUrlForOption('server_privileges.php', 'server')).toBe('/server/privileges');
		expect(getUrlForOption('structure', 'database')).toBe('/database/structure');
		expect(getUrlForOption('db_operations.php', 'database')).toBe('/database/operations');
		expect(getUrlForOption('browse', 'table')).toBe('/sql');
		expect(getUrlForOption('insert', 'table')).toBe('/table/change');
		expect(getUrlForOption('browse', 'database')).toBe('/');
		expect(getUrlForOption('toString', 'server')).toBe('/');
	});
});

describe('serverBreadcrumbName', () => {
	it('prefers the verbose name and appends a non-empty port, treating "0" as empty like PHP', () => {
		expect(serverBreadcrumbName({ host: 'dbadmin-mysql', verbose: '', port: '' })).toBe('dbadmin-mysql');
		expect(serverBreadcrumbName({ host: 'h', verbose: 'Prod', port: '3307' })).toBe('Prod:3307');
		expect(serverBreadcrumbName({ host: 'h', verbose: '0', port: '0' })).toBe('h');
	});
});

describe('stripInnoDbFree', () => {
	// Expected values come from preg_replace('@; InnoDB free:.*?$@', '', ...) in PHP 8.3.
	it('drops the suffix up to the end, or up to a single trailing newline', () => {
		expect(stripInnoDbFree('c; InnoDB free: 4096 kB')).toBe('c');
		expect(stripInnoDbFree('c; InnoDB free: 4096 kB\n')).toBe('c\n');
		expect(stripInnoDbFree('a; InnoDB free: 1; InnoDB free: 2')).toBe('a');
	});

	it('leaves comments alone when the suffix spans lines or is absent', () => {
		expect(stripInnoDbFree('c; InnoDB free: 1\nmore')).toBe('c; InnoDB free: 1\nmore');
		expect(stripInnoDbFree('c; InnoDB free')).toBe('c; InnoDB free');
		expect(stripInnoDbFree('plain')).toBe('plain');
	});
});

describe('currentUserPrivilegeQueries', () => {
	it('checks global privileges only when no database is given', () => {
		expect(currentUserPrivilegeQueries('customer', '%', 'EVENT')).toEqual([
			'SELECT `PRIVILEGE_TYPE` FROM `INFORMATION_SCHEMA`.`USER_PRIVILEGES` WHERE GRANTEE=\'\'\'customer\'\'@\'\'%\'\'\' AND PRIVILEGE_TYPE=\'EVENT\'',
		]);
	});

	it('adds schema then table checks with quoted grantee and escaped names, as PHP builds them', () => {
		const queries = currentUserPrivilegeQueries('o\'b', '%', 'TRIGGER', 'd\'b', String.raw`t\b`);
		expect(queries).toHaveLength(3);
		expect(queries[1]).toBe(String.raw`SELECT ${'`PRIVILEGE_TYPE`'} FROM ${'`INFORMATION_SCHEMA`.`SCHEMA_PRIVILEGES`'} WHERE GRANTEE='''o''b''@''%''' AND PRIVILEGE_TYPE='TRIGGER' AND 'd\'b' LIKE ${'`TABLE_SCHEMA`'}`);
		expect(queries[2]).toBe(String.raw`SELECT ${'`PRIVILEGE_TYPE`'} FROM ${'`INFORMATION_SCHEMA`.`TABLE_PRIVILEGES`'} WHERE GRANTEE='''o''b''@''%''' AND PRIVILEGE_TYPE='TRIGGER' AND 'd\'b' LIKE ${'`TABLE_SCHEMA`'} AND TABLE_NAME='t\\b'`);
		expect(currentUserPrivilegeQueries('u', 'h', 'EVENT', 'db')).toHaveLength(2);
	});
});

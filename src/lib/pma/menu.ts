// Menu.php tab sets, breadcrumb data and the Util helpers they lean on, kept free of IO so the privilege rules are testable.
import { escapeString } from './dbi-sql.ts';

export type MenuLevel = 'server' | 'db' | 'table';

export interface MenuTab {
	icon: string;
	text: string;
	route: string;
	active: boolean;
	args?: Record<string, string | number>;
	warning?: string;
}

export type MenuTabs = Record<string, MenuTab>;

export interface ServerTabFlags {
	isSuperUser: boolean;
	isCreateOrGrantUser: boolean;
	hasBinaryLogs: boolean;
}

export interface DbTabFlags {
	isSystemSchema: boolean;
	numTables: number;
	isSuperUser: boolean;
	isCreateOrGrantUser: boolean;
	canEvent: boolean;
	canTrigger: boolean;
}

export interface TableTabFlags {
	isSystemSchema: boolean;
	isView: boolean;
	isUpdatableView: boolean;
	isSuperUser: boolean;
	isCreateOrGrantUser: boolean;
	canTrigger: boolean;
}

/** Util::getMenuTabList(): the tabs a configurable-menus user group can switch off, with their labels. */
export function getMenuTabList(level: MenuLevel): Record<string, string> {
	if (level === 'server') {
		return {
			databases: 'Databases',
			sql: 'SQL',
			status: 'Status',
			rights: 'Users',
			export: 'Export',
			import: 'Import',
			settings: 'Settings',
			binlog: 'Binary log',
			replication: 'Replication',
			vars: 'Variables',
			charset: 'Charsets',
			plugins: 'Plugins',
			engine: 'Engines',
		};
	}
	if (level === 'db') {
		return {
			structure: 'Structure',
			sql: 'SQL',
			search: 'Search',
			query: 'Query',
			export: 'Export',
			import: 'Import',
			operation: 'Operations',
			privileges: 'Privileges',
			routines: 'Routines',
			events: 'Events',
			triggers: 'Triggers',
			tracking: 'Tracking',
			designer: 'Designer',
			central_columns: 'Central columns',
		};
	}
	return {
		browse: 'Browse',
		structure: 'Structure',
		sql: 'SQL',
		search: 'Search',
		insert: 'Insert',
		export: 'Export',
		import: 'Import',
		privileges: 'Privileges',
		operation: 'Operations',
		tracking: 'Tracking',
		triggers: 'Triggers',
	};
}

/**
 * Menu::getAllowedTabs() + array_intersect_key(): keeps the tabs the level allows, in the tab set's own order.
 * `disallowed` holds the user group's `allowed = 'N'` tabs, which is always empty without a pmadb.
 */
export function filterAllowedTabs(tabs: MenuTabs, level: MenuLevel, disallowed: string[] = []): MenuTabs {
	const allowed = getMenuTabList(level);
	return Object.fromEntries(Object.entries(tabs).filter(([name]) => Object.hasOwn(allowed, name) && !disallowed.includes(name)));
}

/** Menu::getServerTabs(). */
export function getServerTabs(flags: ServerTabFlags, route: string): MenuTabs {
	const tabs: MenuTabs = {
		databases: { icon: 's_db', route: '/server/databases', text: 'Databases', active: route === '/server/databases' },
		sql: { icon: 'b_sql', route: '/server/sql', text: 'SQL', active: route === '/server/sql' },
		status: {
			icon: 's_status',
			route: '/server/status',
			text: 'Status',
			active: [
				'/server/status',
				'/server/status/advisor',
				'/server/status/monitor',
				'/server/status/processes',
				'/server/status/queries',
				'/server/status/variables',
			].includes(route),
		},
	};
	if (flags.isSuperUser || flags.isCreateOrGrantUser) {
		tabs.rights = {
			icon: 's_rights',
			route: '/server/privileges',
			text: 'User accounts',
			active: route === '/server/privileges' || route === '/server/user-groups',
			args: { viewing_mode: 'server' },
		};
	}
	tabs.export = { icon: 'b_export', route: '/server/export', text: 'Export', active: route === '/server/export' };
	tabs.import = { icon: 'b_import', route: '/server/import', text: 'Import', active: route === '/server/import' };
	tabs.settings = {
		icon: 'b_tblops',
		route: '/preferences/manage',
		text: 'Settings',
		active: [
			'/preferences/export',
			'/preferences/features',
			'/preferences/import',
			'/preferences/main-panel',
			'/preferences/manage',
			'/preferences/navigation',
			'/preferences/sql',
			'/preferences/two-factor',
		].includes(route),
	};
	if (flags.hasBinaryLogs) {
		tabs.binlog = { icon: 's_tbl', route: '/server/binlog', text: 'Binary log', active: route === '/server/binlog' };
	}
	if (flags.isSuperUser) {
		tabs.replication = { icon: 's_replication', route: '/server/replication', text: 'Replication', active: route === '/server/replication' };
	}
	tabs.vars = { icon: 's_vars', route: '/server/variables', text: 'Variables', active: route === '/server/variables' };
	tabs.charset = { icon: 's_asci', route: '/server/collations', text: 'Charsets', active: route === '/server/collations' };
	tabs.engine = { icon: 'b_engine', route: '/server/engines', text: 'Engines', active: route === '/server/engines' };
	tabs.plugins = { icon: 'b_plugin', route: '/server/plugins', text: 'Plugins', active: route === '/server/plugins' };
	return tabs;
}

/** Menu::getDbTabs(); Tracking and Central columns need pmadb features that production never has, so they are left out. */
export function getDbTabs(flags: DbTabFlags, db: string, route: string): MenuTabs {
	const tabs: MenuTabs = {
		structure: { route: '/database/structure', text: 'Structure', icon: 'b_props', active: route === '/database/structure' },
		sql: { route: '/database/sql', text: 'SQL', icon: 'b_sql', active: route === '/database/sql' },
		search: { text: 'Search', icon: 'b_search', route: '/database/search', active: route === '/database/search' },
		query: {
			text: 'Query',
			icon: 's_db',
			route: '/database/multi-table-query',
			active: route === '/database/multi-table-query' || route === '/database/qbe',
		},
		export: { text: 'Export', icon: 'b_export', route: '/database/export', active: route === '/database/export' },
	};
	if (flags.numTables === 0) {
		for (const name of ['search', 'query', 'export']) {
			tabs[name].warning = 'Database seems to be empty!';
		}
	}
	if (flags.isSystemSchema) {
		return tabs;
	}
	tabs.import = { route: '/database/import', text: 'Import', icon: 'b_import', active: route === '/database/import' };
	tabs.operation = { route: '/database/operations', text: 'Operations', icon: 'b_tblops', active: route === '/database/operations' };
	if (flags.isSuperUser || flags.isCreateOrGrantUser) {
		tabs.privileges = {
			route: '/server/privileges',
			args: { checkprivsdb: db, viewing_mode: 'db' },
			text: 'Privileges',
			icon: 's_rights',
			active: route === '/server/privileges',
		};
	}
	tabs.routines = { route: '/database/routines', text: 'Routines', icon: 'b_routines', active: route === '/database/routines' };
	if (flags.canEvent) {
		tabs.events = { route: '/database/events', text: 'Events', icon: 'b_events', active: route === '/database/events' };
	}
	if (flags.canTrigger) {
		tabs.triggers = { route: '/database/triggers', text: 'Triggers', icon: 'b_triggers', active: route === '/database/triggers' };
	}
	tabs.designer = { text: 'Designer', icon: 'b_relations', route: '/database/designer', active: route === '/database/designer' };
	return tabs;
}

/** Menu::getTableTabs(); Tracking needs a pmadb, so it is left out like getDbTabs(). */
export function getTableTabs(flags: TableTabFlags, db: string, table: string, route: string): MenuTabs {
	const tabs: MenuTabs = {
		browse: { icon: 'b_browse', text: 'Browse', route: '/sql', args: { pos: 0 }, active: route === '/sql' },
		structure: {
			icon: 'b_props',
			route: '/table/structure',
			text: 'Structure',
			active: route === '/table/relation' || route === '/table/structure',
		},
		sql: { icon: 'b_sql', route: '/table/sql', text: 'SQL', active: route === '/table/sql' },
		search: {
			icon: 'b_search',
			text: 'Search',
			route: '/table/search',
			active: ['/table/find-replace', '/table/search', '/table/zoom-search'].includes(route),
		},
	};
	if (!flags.isSystemSchema && (!flags.isView || flags.isUpdatableView)) {
		tabs.insert = { icon: 'b_insrow', route: '/table/change', text: 'Insert', active: route === '/table/change' };
	}
	tabs.export = { icon: 'b_tblexport', route: '/table/export', args: { single_table: 'true' }, text: 'Export', active: route === '/table/export' };
	if (!flags.isView && !flags.isSystemSchema) {
		tabs.import = { icon: 'b_tblimport', route: '/table/import', text: 'Import', active: route === '/table/import' };
	}
	if ((flags.isSuperUser || flags.isCreateOrGrantUser) && !flags.isSystemSchema) {
		tabs.privileges = {
			route: '/server/privileges',
			args: { checkprivsdb: db, checkprivstable: table, viewing_mode: 'table' },
			text: 'Privileges',
			icon: 's_rights',
			active: route === '/server/privileges',
		};
	}
	if (!flags.isSystemSchema) {
		let operationRoute = '/table/operations';
		if (flags.isView) {
			operationRoute = '/view/operations';
		}
		tabs.operation = { icon: 'b_tblops', route: operationRoute, text: 'Operations', active: route === operationRoute };
	}
	if (!flags.isSystemSchema && flags.canTrigger && !flags.isView) {
		tabs.triggers = { route: '/table/triggers', text: 'Triggers', icon: 'b_triggers', active: route === '/table/triggers' };
	}
	return tabs;
}

const serverOptionRoutes: Record<string, string> = {
	'welcome': '/',
	'index.php': '/',
	'databases': '/server/databases',
	'server_databases.php': '/server/databases',
	'status': '/server/status',
	'server_status.php': '/server/status',
	'variables': '/server/variables',
	'server_variables.php': '/server/variables',
	'privileges': '/server/privileges',
	'server_privileges.php': '/server/privileges',
};

const databaseOptionRoutes: Record<string, string> = {
	'structure': '/database/structure',
	'db_structure.php': '/database/structure',
	'sql': '/database/sql',
	'db_sql.php': '/database/sql',
	'search': '/database/search',
	'db_search.php': '/database/search',
	'operations': '/database/operations',
	'db_operations.php': '/database/operations',
};

const tableOptionRoutes: Record<string, string> = {
	'structure': '/table/structure',
	'tbl_structure.php': '/table/structure',
	'sql': '/table/sql',
	'tbl_sql.php': '/table/sql',
	'search': '/table/search',
	'tbl_select.php': '/table/search',
	'insert': '/table/change',
	'tbl_change.php': '/table/change',
	'browse': '/sql',
	'sql.php': '/sql',
};

/** Util::getUrlForOption(): the route behind a DefaultTab* setting, '/' when the value is unknown. */
export function getUrlForOption(target: string, location: 'server' | 'database' | 'table'): string {
	let routes = tableOptionRoutes;
	if (location === 'server') {
		routes = serverOptionRoutes;
	} else if (location === 'database') {
		routes = databaseOptionRoutes;
	}
	if (Object.hasOwn(routes, target)) {
		return routes[target];
	}
	return '/';
}

function phpEmpty(value: string): boolean {
	return value === '' || value === '0';
}

/** The server breadcrumb label: verbose name or host, plus ':port' when a port is set. */
export function serverBreadcrumbName(server: { host: string; verbose: string; port: string; }): string {
	let name = server.host;
	if (!phpEmpty(server.verbose)) {
		name = server.verbose;
	}
	if (!phpEmpty(server.port)) {
		name += `:${server.port}`;
	}
	return name;
}

/** Drops the "; InnoDB free: ..." suffix old MySQL servers append to table comments (PHP's '$' also matches before a final newline). */
export function stripInnoDbFree(comment: string): string {
	if (!comment.includes('; InnoDB free')) {
		return comment;
	}
	return comment.replace(/; InnoDB free:[^\n]*(?=\n?$)/, '');
}

/**
 * The queries Util::currentUserHasPrivilege() runs in order (global, then schema, then table privileges); the first
 * one that returns a value grants the privilege.
 */
export function currentUserPrivilegeQueries(user: string, host: string, privilege: string, db: string | null = null, table: string | null = null): string[] {
	const username = `''${user.replaceAll('\'', '\'\'')}''@''${host.replaceAll('\'', '\'\'')}''`;
	const select = (view: string): string => `SELECT \`PRIVILEGE_TYPE\` FROM \`INFORMATION_SCHEMA\`.\`${view}\` WHERE GRANTEE='${username}' AND PRIVILEGE_TYPE='${privilege}'`;
	const queries = [select('USER_PRIVILEGES')];
	if (db === null) {
		return queries;
	}
	const schemaCondition = ` AND '${escapeString(db)}' LIKE \`TABLE_SCHEMA\``;
	queries.push(select('SCHEMA_PRIVILEGES') + schemaCondition);
	if (table !== null) {
		queries.push(`${select('TABLE_PRIVILEGES')}${schemaCondition} AND TABLE_NAME='${escapeString(table)}'`);
	}
	return queries;
}

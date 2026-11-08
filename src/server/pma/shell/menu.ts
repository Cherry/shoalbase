// Menu::getDisplay(): the breadcrumbs plus the privilege-aware server, database or table tab bar.
import { isSystemSchema } from '../../../lib/pma/dbi-sql.ts';
import {
	type MenuLevel,
	type MenuTabs,
	currentUserPrivilegeQueries,
	filterAllowedTabs,
	getDbTabs,
	getServerTabs,
	getTableTabs,
	getUrlForOption,
	serverBreadcrumbName,
	stripInnoDbFree,
} from '../../../lib/pma/menu.ts';
import { renderTemplate } from '../../twig/render.ts';
import { Table } from '../core/table.ts';

import type { PmaContext } from '../core/context.ts';
import type { DatabaseInterface, DbiValue } from '../core/dbi.ts';

// Menu::setTable() overrides, for controllers that change the table after the Header captured it.
const menuTables = new WeakMap<PmaContext, string>();

/** Menu::setTable(). */
export function setMenuTable(context: PmaContext, table: string): void {
	menuTables.set(context, table);
}

function phpTruthy(value: DbiValue | false): boolean {
	return typeof value === 'string' && value !== '' && value !== '0';
}

/** Util::currentUserHasPrivilege(). */
export async function currentUserHasPrivilege(dbi: DatabaseInterface, privilege: string, db: string | null = null, table: string | null = null): Promise<boolean> {
	const [user = '', host = ''] = await dbi.getCurrentUserAndHost();
	// MySQL started with --skip-grant-tables reports no user and grants everything.
	if (user === '') {
		return true;
	}
	for (const query of currentUserPrivilegeQueries(user, host, privilege, db, table)) {
		if (phpTruthy(await dbi.fetchValue(query))) {
			return true;
		}
	}
	return false;
}

async function isCreateOrGrantUser(dbi: DatabaseInterface): Promise<boolean> {
	return (await dbi.isGrantUser()) || (await dbi.isCreateUser());
}

async function getBreadcrumbs(context: PmaContext, table: string): Promise<Record<string, unknown>> {
	const { config } = context;
	const db = context.headerDb;
	const server = {
		name: serverBreadcrumbName(config.Server),
		url: getUrlForOption(config.DefaultTabServer, 'server'),
	};
	let database: Record<string, unknown> = {};
	let tableCrumb: Record<string, unknown> = {};
	// The database comment needs the column comments feature of a pmadb, which production lacks.
	if (db !== '') {
		database = { name: db, url: getUrlForOption(config.DefaultTabDatabase, 'database') };
		if (table !== '') {
			const tableObject = Table.get(context, table, db);
			const view = await tableObject.isView();
			let comment = '';
			if (!view) {
				comment = stripInnoDbFree(await tableObject.getComment());
			}
			tableCrumb = { name: table, url: getUrlForOption(config.DefaultTabTable, 'table'), is_view: view, comment };
		}
	}
	return { server, database, table: tableCrumb };
}

async function getTabs(context: PmaContext, table: string): Promise<{ level: MenuLevel; tabs: MenuTabs; urlParams: Record<string, string>; }> {
	const { dbi, route } = context;
	const db = context.headerDb;
	if (table !== '' && db !== '') {
		const systemSchema = isSystemSchema(db);
		const tableObject = Table.get(context, table, db);
		const view = await tableObject.isView();
		let updatableView = false;
		if (view) {
			updatableView = await tableObject.isUpdatableView();
		}
		const flags = {
			isSystemSchema: systemSchema,
			isView: view,
			isUpdatableView: updatableView,
			isSuperUser: await dbi.isSuperUser(),
			isCreateOrGrantUser: await isCreateOrGrantUser(dbi),
			canTrigger: !systemSchema && await currentUserHasPrivilege(dbi, 'TRIGGER', db, table),
		};
		return { level: 'table', tabs: getTableTabs(flags, db, table, route), urlParams: { db, table } };
	}
	if (db !== '') {
		const systemSchema = isSystemSchema(db);
		const tables = await dbi.getTables(db);
		const flags = {
			isSystemSchema: systemSchema,
			numTables: tables.length,
			isSuperUser: await dbi.isSuperUser(),
			isCreateOrGrantUser: await isCreateOrGrantUser(dbi),
			canEvent: !systemSchema && await currentUserHasPrivilege(dbi, 'EVENT', db),
			canTrigger: !systemSchema && await currentUserHasPrivilege(dbi, 'TRIGGER', db),
		};
		return { level: 'db', tabs: getDbTabs(flags, db, route), urlParams: { db } };
	}
	const isSuperUser = await dbi.isSuperUser();
	const createOrGrant = await isCreateOrGrantUser(dbi);
	// Upstream keeps this in SessionCache; without a server-side session it is asked once per request.
	const binaryLogs = await dbi.fetchResult('SHOW BINARY LOGS', 'Log_name');
	const flags = { isSuperUser, isCreateOrGrantUser: createOrGrant, hasBinaryLogs: binaryLogs.size > 0 };
	return { level: 'server', tabs: getServerTabs(flags, route), urlParams: {} };
}

/** Menu::getDisplay(). */
export async function renderMenu(context: PmaContext): Promise<string> {
	const table = menuTables.get(context) ?? context.headerTable;
	const state = await context.templateState();
	const breadcrumbs = await renderTemplate('menu/breadcrumbs', await getBreadcrumbs(context, table), state);
	const { level, tabs, urlParams } = await getTabs(context, table);
	const menu = await renderTemplate('top_menu', { tabs: filterAllowedTabs(tabs, level), url_params: urlParams }, state);
	return breadcrumbs + menu;
}

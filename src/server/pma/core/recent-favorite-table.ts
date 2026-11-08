// Port of PhpMyAdmin\RecentFavoriteTable without pmadb: the lists live in $_SESSION['tmpval'] per server.
import { md5 } from '../../../lib/pma/md5.ts';
import {
	type TableRef,
	addToTableList,
	removeFromTableList,
	tableList,
} from '../../../lib/pma/session.ts';
import { getFromRoute } from '../../../lib/twig/url.ts';
import { renderTemplate } from '../../twig/render.ts';

import type { PmaContext } from './context.ts';

export type TableListType = 'recent' | 'favorite';

/** RecentFavoriteTable::getInstance($type)->getTables(); change the list through the helpers below. */
export function getTables(context: PmaContext, type: TableListType): TableRef[] {
	return tableList(context.session, type, context.server);
}

function maxTables(context: PmaContext, type: TableListType): number {
	if (type === 'recent') {
		return context.config.NumRecentTables;
	}
	return context.config.NumFavoriteTables;
}

/** RecentFavoriteTable::add(): tables that do not exist are skipped, which upstream also reports as success. */
export async function addTable(context: PmaContext, type: TableListType, db: string, table: string): Promise<void> {
	const columns = await context.dbi.getColumns(db, table);
	if (columns.size === 0) {
		return;
	}
	addToTableList(tableList(context.session, type, context.server, true), { db, table }, maxTables(context, type));
}

/** RecentFavoriteTable::remove(). */
export function removeTable(context: PmaContext, type: TableListType, db: string, table: string): void {
	removeFromTableList(tableList(context.session, type, context.server), db, table);
}

/** RecentFavoriteTable::removeIfInvalid(): drops a listed table that no longer exists, returning whether it did. */
export async function removeIfInvalid(context: PmaContext, type: TableListType, db: string, table: string): Promise<boolean> {
	const listed = getTables(context, type).some(item => item.db === db && item.table === table);
	if (!listed) {
		return false;
	}
	const columns = await context.dbi.getColumns(db, table);
	if (columns.size > 0) {
		return false;
	}
	removeTable(context, type, db, table);
	return true;
}

/** RecentFavoriteTable::getHtmlList(): the <li> items of the drop-down. */
export async function getHtmlList(context: PmaContext, type: TableListType): Promise<string> {
	const state = await context.templateState();
	const tables = getTables(context, type);
	if (tables.length === 0) {
		return renderTemplate('recent_favorite_table_no_tables', { is_recent: type === 'recent' }, state);
	}
	if (type === 'recent') {
		return renderTemplate('recent_favorite_table_recent', { tables: tables.map(({ db, table }) => {
			return { db, table };
		}) }, state);
	}
	return renderTemplate('recent_favorite_table_favorite', {
		tables: tables.map(({ db, table }) => {
			return {
				remove_parameters: { db, ajax_request: true, favorite_table: table, remove_favorite: true },
				table_parameters: { db, table, md5: md5(`${db}.${table}`) },
			};
		}),
	}, state);
}

/** RecentFavoriteTable::getHtmlUpdateRecentTables(). */
export function getHtmlUpdateRecentTables(context: PmaContext): string {
	const href = getFromRoute(context.urlState(), '/recent-table', { ajax_request: true, recent_table: true });
	return `<a class="hide" id="update_recent_tables" href="${href}"></a>`;
}

// Ports of Database\Structure\FavoriteTableController and RealRowCountController, the AJAX actions of the table list.
import { getDbInfo, hasDatabase, render } from './common.ts';
import { phpJsonEncode } from '../../../../lib/pma/json.ts';
import { md5 } from '../../../../lib/pma/md5.ts';
import { formatNumber } from '../../../../lib/pma/util.ts';
import {
	addTable,
	getHtmlList,
	getTables,
	removeTable,
} from '../../core/recent-favorite-table.ts';
import { Table } from '../../core/table.ts';

import type { PmaContext } from '../../core/context.ts';

async function sha1(text: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text)));
	return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** json_decode($favoriteTables, true) as the array FavoriteTableController adds the user's list to. */
function postedFavoriteTables(value: unknown): Record<string, unknown> {
	if (typeof value !== 'string') {
		return {};
	}
	let decoded: unknown;
	try {
		decoded = JSON.parse(value);
	} catch {
		return {};
	}
	if (Array.isArray(decoded)) {
		return Object.fromEntries(decoded.map((item, index) => [String(index), item]));
	}
	if (typeof decoded === 'object' && decoded !== null) {
		return decoded as Record<string, unknown>;
	}
	return {};
}

/** Database\Structure\FavoriteTableController (POST /database/structure/favorite-table). */
export async function favoriteTableController(context: PmaContext): Promise<Response> {
	const { config, db, response, request } = context;
	if (!response.isAjax) {
		return response.response();
	}
	const favoriteTables = postedFavoriteTables(request.params.favoriteTables);
	const user = await sha1(config.Server.user ?? context.user);
	// Synchronising with pmadb needs the favorite tables feature, which is off without configuration storage.
	if (request.params.sync_favorite_tables !== undefined) {
		return response.response();
	}
	if (!await hasDatabase(context)) {
		return response.response();
	}
	let changes = true;
	const favoriteTable = typeof request.params.favorite_table === 'string' ? request.params.favorite_table : '';
	let alreadyFavorite = getTables(context, 'favorite').some(item => item.db === db && item.table === favoriteTable);
	if (request.params.remove_favorite !== undefined) {
		if (alreadyFavorite) {
			removeTable(context, 'favorite', db, favoriteTable);
			alreadyFavorite = false;
		}
	} else if (request.params.add_favorite !== undefined && !alreadyFavorite) {
		if (getTables(context, 'favorite').length === Number(config.NumFavoriteTables)) {
			changes = false;
		} else {
			await addTable(context, 'favorite', db, favoriteTable);
			alreadyFavorite = true;
		}
	}
	favoriteTables[user] = getTables(context, 'favorite').map((item) => { return { db: item.db, table: item.table }; });
	if (!changes) {
		response.addJSON({ changes, message: await render(context, 'components/error_message', { msg: 'Favorite List is full!' }) });
		return response.response();
	}
	const favoriteParams = {
		db,
		ajax_request: true,
		favorite_table: favoriteTable,
		[`${alreadyFavorite ? 'remove' : 'add'}_favorite`]: true,
	};
	response.addJSON({
		changes,
		user,
		favoriteTables: phpJsonEncode(favoriteTables),
		list: await getHtmlList(context, 'favorite'),
		anchor: await render(context, 'database/structure/favorite_anchor', {
			table_name_hash: md5(favoriteTable),
			db_table_name_hash: md5(`${db}.${favoriteTable}`),
			fav_params: favoriteParams,
			already_favorite: alreadyFavorite,
		}),
	});
	return response.response();
}

/** Database\Structure\RealRowCountController (/database/structure/real-row-count). */
export async function realRowCountController(context: PmaContext): Promise<Response> {
	const { db, response, request } = context;
	if (!await hasDatabase(context) || !response.isAjax) {
		return response.response();
	}
	const { tables } = await getDbInfo(context, '_structure');
	if (request.params.real_row_count_all === undefined) {
		const count = await Table.get(context, String(request.params.table ?? ''), db).getRealRowCountTable();
		response.addJSON({ real_row_count: formatNumber(Math.trunc(count ?? 0), 0) });
		return response.response();
	}
	const all: { table: string; row_count: string; }[] = [];
	for (const table of tables.values()) {
		const name = String(table.TABLE_NAME);
		const count = await Table.get(context, name, db).getRealRowCountTable();
		all.push({ table: name, row_count: formatNumber(count ?? 0, 0) });
	}
	response.addJSON({ real_row_count_all: all });
	return response.response();
}

export const controllers = {
	'Database/Structure/FavoriteTableController': favoriteTableController,
	'Database/Structure/RealRowCountController': realRowCountController,
};

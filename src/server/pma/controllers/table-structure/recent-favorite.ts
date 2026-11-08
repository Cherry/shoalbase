// Port of Controllers\Table\RecentFavoriteController (route /table/recent-favorite): drops stale list entries, then browses the table.
import { forwardTo } from './common.ts';
import { removeIfInvalid } from '../../core/recent-favorite-table.ts';

import type { PmaContext } from '../../core/context.ts';

export async function recentFavoriteController(context: PmaContext): Promise<Response> {
	const params = context.request.params;
	const db = typeof params.db === 'string' ? params.db : '';
	const table = typeof params.table === 'string' ? params.table : '';
	await removeIfInvalid(context, 'recent', db, table);
	await removeIfInvalid(context, 'favorite', db, table);
	return await forwardTo(context, 'Sql/SqlController') ?? context.response.response();
}

export const controllers = { 'Table/RecentFavoriteController': recentFavoriteController };

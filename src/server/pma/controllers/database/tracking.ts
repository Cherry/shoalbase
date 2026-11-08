// Port of Controllers\Database\TrackingController without configuration storage, where Tracker has no data to show.
import {
	getDbInfo,
	hasDatabase,
	internalErrorPage,
	render,
} from './common.ts';
import { postedList } from './structure-multi.ts';
import { phpEmpty } from '../../../../lib/pma/server/php.ts';
import { getFromRoute } from '../../../../lib/twig/url.ts';

import type { PmaContext } from '../../core/context.ts';

/**
 * Database\TrackingController. Without the tracking feature Tracker::getTrackedData() returns [], so upstream ends in a
 * TypeError on count($data['ddlog']) after the requested action; only the "track" form is shown before that point.
 */
export async function trackingController(context: PmaContext): Promise<Response> {
	const { config, db, response, request } = context;
	response.addScriptFiles(['vendor/jquery/jquery.tablesorter.js', 'database/tracking.js']);
	if (!await hasDatabase(context)) {
		return response.response();
	}
	const urlParams = {
		db,
		table: context.table,
		server: context.server,
		goto: getFromRoute(context.urlState(), '/table/tracking'),
		back: getFromRoute(context.urlState(), '/database/tracking'),
	};
	await getDbInfo(context, '_structure');
	const post = request.post;
	const tracksTables = post.delete_tracking === undefined && post.submit_create_version === undefined && post.submit_mult === 'track';
	if (tracksTables && !phpEmpty(post.selected_tbl)) {
		response.addHTML(await render(context, 'create_tracking_version', {
			route: '/database/tracking',
			url_params: urlParams,
			last_version: 0,
			db,
			selected: postedList(post.selected_tbl),
			type: 'both',
			default_statements: config.Server.tracking_default_statements,
		}));
		return response.response();
	}
	// Messages echoed by the other actions are lost with the fatal error page.
	return internalErrorPage(context, 'TypeError');
}

export const controllers = {
	'Database/TrackingController': trackingController,
};

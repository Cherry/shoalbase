// Port of Controllers\Table\TrackingController (route /table/tracking) without configuration storage, where Tracker keeps no versions.
import { checkDbTableExists, render } from './common.ts';
import { Message } from '../../../../lib/pma/message.ts';
import { getFromRoute } from '../../../../lib/twig/url.ts';
import { Table } from '../../core/table.ts';
import { internalErrorPage } from '../database/common.ts';

import type { PmaContext } from '../../core/context.ts';

export async function trackingController(context: PmaContext): Promise<Response> {
	const { config, response } = context;
	const post = context.request.post;
	response.addScriptFiles(['vendor/jquery/jquery.tablesorter.js', 'table/tracking.js']);
	// TABLE_MAY_BE_ABSENT: only the database has to exist.
	const missing = await checkDbTableExists(context, true);
	if (missing !== null) {
		return missing;
	}
	// Tracker::getTrackedData() and the snapshot read version data that does not exist, which ends in a TypeError.
	if (post.report !== undefined || post.report_export !== undefined || post.snapshot !== undefined) {
		return internalErrorPage(context, 'TypeError');
	}
	const trackingUrl = getFromRoute(context.urlState(), '/table/tracking');
	const urlParams = { db: context.db, table: context.table, goto: trackingUrl, back: trackingUrl };
	let actionMessage = '';
	if (post.submit_mult !== undefined) {
		const selected = post.selected_versions;
		const hasSelection = selected !== undefined && selected !== '' && selected !== '0' && !(Array.isArray(selected) && selected.length === 0);
		if (!hasSelection) {
			actionMessage = Message.notice('No versions selected.').getDisplay();
		} else if (post.submit_mult === 'delete_version') {
			actionMessage = Message.success('Tracking versions deleted successfully.').getDisplay();
		}
	}
	const isView = await Table.get(context, context.table, context.db).isView();
	const main = await render(context, 'table/tracking/main', {
		url_params: urlParams,
		db: context.db,
		table: context.table,
		selectable_tables_num_rows: 0,
		selectable_tables_entries: [],
		selected_table: post.table ?? null,
		last_version: null,
		versions: [],
		type: isView ? 'view' : 'table',
		default_statements: config.Server.tracking_default_statements,
		text_dir: 'ltr',
	});
	response.addHTML(await render(context, 'table/tracking/index', {
		active_message: '',
		action_message: actionMessage,
		delete_version: '',
		create_version: '',
		deactivate_tracking: '',
		activate_tracking: '',
		message: '',
		sql_dump: '',
		schema_snapshot: '',
		tracking_report_rows: '',
		tracking_report: '',
		main,
	}));
	return response.response();
}

export const controllers = { 'Table/TrackingController': trackingController };

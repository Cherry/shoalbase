// Ports of Controllers\Database\EventsController and Database\Events.
import {
	getDbInfo,
	hasDatabase,
	render,
	requestString,
} from './common.ts';
import { getDefinition, getEvents } from './objects.ts';
import { Message } from '../../../../lib/pma/message.ts';
import { phpEmpty, phpInt } from '../../../../lib/pma/server/php.ts';
import { sprintf } from '../../../../lib/pma/sprintf.ts';
import { htmlspecialchars } from '../../../../lib/twig/php.ts';
import { backquote } from '../../../../lib/twig/sanitize.ts';
import { getMessage } from '../../core/generator.ts';
import { currentUserHasPrivilege } from '../../shell/menu.ts';

import type { PmaContext } from '../../core/context.ts';

const STATUS_QUERY = ['ENABLE', 'DISABLE', 'DISABLE ON SLAVE'];
const STATUS_DISPLAY = ['ENABLED', 'DISABLED', 'SLAVESIDE_DISABLED'];
const TYPES = ['RECURRING', 'ONE TIME'];
const INTERVALS = ['YEAR', 'QUARTER', 'MONTH', 'DAY', 'HOUR', 'MINUTE', 'WEEK', 'SECOND', 'YEAR_MONTH', 'DAY_HOUR', 'DAY_MINUTE', 'DAY_SECOND', 'HOUR_MINUTE', 'HOUR_SECOND', 'MINUTE_SECOND'];

const FAILED_QUERY = 'The following query has failed: "%s"';

type EventItem = Record<string, unknown>;

/** Events::getDataFromRequest(). */
function getDataFromRequest(context: PmaContext): EventItem {
	const post = context.request.post;
	const item: EventItem = {};
	for (const key of ['item_name', 'item_original_name', 'item_status', 'item_execute_at', 'item_interval_value', 'item_interval_field', 'item_starts', 'item_ends', 'item_definition', 'item_preserve', 'item_comment', 'item_definer']) {
		item[key] = post[key] ?? '';
	}
	item.item_type = 'ONE TIME';
	item.item_type_toggle = 'RECURRING';
	if (post.item_type === 'RECURRING') {
		item.item_type = 'RECURRING';
		item.item_type_toggle = 'ONE TIME';
	}
	return item;
}

/** Events::getDataFromName(). */
async function getDataFromName(context: PmaContext, name: unknown): Promise<EventItem | null> {
	const { dbi } = context;
	const columns = '`EVENT_NAME`, `STATUS`, `EVENT_TYPE`, `EXECUTE_AT`, `INTERVAL_VALUE`, `INTERVAL_FIELD`, `STARTS`, `ENDS`, `EVENT_DEFINITION`, `ON_COMPLETION`, `DEFINER`, `EVENT_COMMENT`';
	const where = `EVENT_SCHEMA ${await dbi.getCollateForIS()}='${dbi.escapeString(context.db)}' AND EVENT_NAME='${dbi.escapeString(String(name))}'`;
	const row = await dbi.fetchSingleRow(`SELECT ${columns} FROM \`INFORMATION_SCHEMA\`.\`EVENTS\` WHERE ${where};`);
	if (row === null) {
		return null;
	}
	const recurring = row.EVENT_TYPE === 'RECURRING';
	return {
		item_name: row.EVENT_NAME,
		item_status: row.STATUS,
		item_type: row.EVENT_TYPE,
		item_type_toggle: recurring ? 'ONE TIME' : 'RECURRING',
		item_execute_at: row.EXECUTE_AT,
		item_interval_value: row.INTERVAL_VALUE,
		item_interval_field: row.INTERVAL_FIELD,
		item_starts: row.STARTS,
		item_ends: row.ENDS,
		item_preserve: row.ON_COMPLETION === 'PRESERVE' ? ' checked=\'checked\'' : '',
		item_definition: row.EVENT_DEFINITION,
		item_definer: row.DEFINER,
		item_comment: row.EVENT_COMMENT,
	};
}

/** Events::getQueryFromRequest(). */
function getQueryFromRequest(context: PmaContext, errors: string[]): string {
	const { dbi } = context;
	const post = context.request.post;
	let query = 'CREATE ';
	if (!phpEmpty(post.item_definer)) {
		const definer = requestString(post.item_definer);
		if (definer.includes('@')) {
			const parts = definer.split('@');
			query += `DEFINER=${backquote(parts[0])}@${backquote(parts[1])} `;
		} else {
			errors.push('The definer must be in the "username@hostname" format!');
		}
	}
	query += 'EVENT ';
	if (phpEmpty(post.item_name)) {
		errors.push('You must provide an event name!');
	} else {
		query += `${backquote(post.item_name)} `;
	}
	query += 'ON SCHEDULE ';
	const type = requestString(post.item_type);
	if (!TYPES.includes(type)) {
		errors.push('You must provide a valid type for the event.');
	} else if (type === 'RECURRING') {
		if (!phpEmpty(post.item_interval_value) && INTERVALS.includes(requestString(post.item_interval_field))) {
			query += `EVERY ${phpInt(post.item_interval_value)} ${requestString(post.item_interval_field)} `;
		} else {
			errors.push('You must provide a valid interval value for the event.');
		}
		if (!phpEmpty(post.item_starts)) {
			query += `STARTS '${dbi.escapeString(requestString(post.item_starts))}' `;
		}
		if (!phpEmpty(post.item_ends)) {
			query += `ENDS '${dbi.escapeString(requestString(post.item_ends))}' `;
		}
	} else if (phpEmpty(post.item_execute_at)) {
		errors.push('You must provide a valid execution time for the event.');
	} else {
		query += `AT '${dbi.escapeString(requestString(post.item_execute_at))}' `;
	}
	query += 'ON COMPLETION ';
	if (phpEmpty(post.item_preserve)) {
		query += 'NOT ';
	}
	query += 'PRESERVE ';
	if (!phpEmpty(post.item_status)) {
		const index = STATUS_DISPLAY.indexOf(String(post.item_status));
		if (index !== -1) {
			query += `${STATUS_QUERY[index]} `;
		}
	}
	if (!phpEmpty(post.item_comment)) {
		query += `COMMENT '${dbi.escapeString(requestString(post.item_comment))}' `;
	}
	query += 'DO ';
	if (phpEmpty(post.item_definition)) {
		errors.push('You must provide an event definition.');
	} else {
		query += requestString(post.item_definition);
	}
	return query;
}

function queryFailed(context: PmaContext, query: string, separator: string): string {
	return `${sprintf(FAILED_QUERY, htmlspecialchars(query))}${separator}MySQL said: ${context.dbi.getError()}`;
}

/** The submitted editor of Events::handleEditor(); the AJAX response, or null to continue. */
async function processEditor(context: PmaContext, errors: string[]): Promise<Response | null> {
	const { dbi, response } = context;
	const post = context.request.post;
	let message: Message | undefined;
	let sqlQuery = '';
	const itemQuery = getQueryFromRequest(context, errors);
	if (errors.length === 0) {
		if (phpEmpty(post.editor_process_edit)) {
			if (await dbi.tryQuery(itemQuery) === false) {
				errors.push(queryFailed(context, itemQuery, '<br><br>'));
			} else {
				message = Message.success('Event %1$s has been created.');
				message.addParam(backquote(post.item_name));
				sqlQuery = itemQuery;
			}
		} else {
			const createItem = await getDefinition(context, context.db, 'EVENT', String(post.item_original_name ?? ''));
			const dropItem = `DROP EVENT IF EXISTS ${backquote(post.item_original_name)};\n`;
			if (await dbi.tryQuery(dropItem) === false) {
				errors.push(queryFailed(context, dropItem, '<br>'));
			} else if (await dbi.tryQuery(itemQuery) === false) {
				errors.push(queryFailed(context, itemQuery, '<br>'));
				if (await dbi.tryQuery(createItem ?? '') === false) {
					errors.push(`Sorry, we failed to restore the dropped event.<br>The backed up query was:"${htmlspecialchars(createItem ?? '')}"<br>MySQL said: ${dbi.getError()}`);
				}
			} else {
				message = Message.success('Event %1$s has been modified.');
				message.addParam(backquote(post.item_name));
				sqlQuery = dropItem + itemQuery;
			}
		}
	}
	if (errors.length > 0) {
		message = Message.error('<b>One or more errors have occurred while processing your request:</b>');
		message.addHtml('<ul>');
		for (const error of errors) {
			message.addHtml(`<li>${error}</li>`);
		}
		message.addHtml('</ul>');
	}
	const output = await getMessage(context, message ?? '', { sqlQuery });
	// The global $message is what the Header shows, also as the displayMessage of AJAX responses.
	response.globals.message = message;
	if (!response.isAjax) {
		return null;
	}
	if (message?.isSuccess()) {
		const [event] = await getEvents(context, context.db, requestString(post.item_name));
		response.addJSON('name', htmlspecialchars(requestString(post.item_name).toUpperCase()));
		if (event !== undefined) {
			response.addJSON('new_row', await render(context, 'database/events/row', {
				db: context.db,
				table: context.table,
				event,
				has_privilege: await currentUserHasPrivilege(dbi, 'EVENT', context.db),
				sql_drop: `DROP EVENT IF EXISTS ${backquote(event.name)}`,
				row_class: '',
			}));
		}
		response.addJSON('insert', event !== undefined);
		response.addJSON('message', output);
	} else {
		response.setRequestStatus(false);
		response.addJSON('message', message ?? '');
	}
	response.addJSON('tableType', 'events');
	return response.response();
}

/** Events::sendEditor(); `content` collects what upstream echoes. */
async function sendEditor(context: PmaContext, mode: string, item: EventItem | null, title: string, operation: string): Promise<Response | string> {
	const { response } = context;
	if (item !== null) {
		const event = { ...item };
		if (operation === 'change') {
			const recurring = event.item_type === 'RECURRING';
			event.item_type = recurring ? 'ONE TIME' : 'RECURRING';
			event.item_type_toggle = recurring ? 'RECURRING' : 'ONE TIME';
		}
		const editor = await render(context, 'database/events/editor_form', {
			db: context.db,
			event,
			mode,
			is_ajax: response.isAjax,
			status_display: STATUS_DISPLAY,
			event_type: TYPES,
			event_interval: INTERVALS,
		});
		if (response.isAjax) {
			response.addJSON('message', editor);
			response.addJSON('title', title);
		} else {
			response.addHTML(`\n\n<h2>${title}</h2>\n\n${editor}`);
		}
		return response.response();
	}
	const text = `Error in processing request: ${sprintf('No event with name %1$s found in database %2$s.', htmlspecialchars(backquote(context.request.params.item_name)), htmlspecialchars(backquote(context.db)))}`;
	const message = Message.error(text);
	if (response.isAjax) {
		response.setRequestStatus(false);
		response.addJSON('message', message);
		return response.response();
	}
	return message.getDisplay();
}

/** Events::handleEditor(): a Response when the request ends there, else the echoed text (possibly empty). */
async function handleEditor(context: PmaContext, errors: string[]): Promise<Response | string> {
	const { params, post } = context.request;
	const processing = !phpEmpty(post.editor_process_add) || !phpEmpty(post.editor_process_edit);
	if (processing) {
		const done = await processEditor(context, errors);
		if (done !== null) {
			return done;
		}
	}
	if (errors.length === 0 && (processing || (phpEmpty(params.add_item) && phpEmpty(params.edit_item) && phpEmpty(post.item_changetype)))) {
		return '';
	}
	let operation = '';
	if (!phpEmpty(post.item_changetype)) {
		operation = 'change';
	}
	let title = '';
	let item: EventItem | null = null;
	let mode = '';
	if (!phpEmpty(params.add_item)) {
		title = 'Add event';
		item = getDataFromRequest(context);
		mode = 'add';
	} else if (!phpEmpty(params.edit_item)) {
		title = 'Edit event';
		if (!phpEmpty(params.item_name) && phpEmpty(post.editor_process_edit) && phpEmpty(post.item_changetype)) {
			item = await getDataFromName(context, params.item_name);
			if (item !== null) {
				item.item_original_name = item.item_name;
			}
		} else {
			item = getDataFromRequest(context);
		}
		mode = 'edit';
	}
	return sendEditor(context, mode, item, title, operation);
}

/** Events::export(); a Response when an AJAX export ends the request. */
async function exportEvent(context: PmaContext): Promise<Response | null> {
	const { response } = context;
	const query = context.request.query;
	if (phpEmpty(query.export_item) || phpEmpty(query.item_name)) {
		return null;
	}
	const definition = await getDefinition(context, context.db, 'EVENT', String(query.item_name));
	const itemName = htmlspecialchars(backquote(query.item_name));
	if (definition) {
		const exportData = htmlspecialchars(definition.trim());
		const title = sprintf('Export of event %s', itemName);
		if (response.isAjax) {
			response.addJSON('message', exportData);
			response.addJSON('title', title);
			return response.response();
		}
		response.addHTML(`<div class="container"><h2>${title}</h2><div class="card"><div class="card-body"><textarea rows="15" class="form-control">${exportData}</textarea></div></div></div>`);
		return null;
	}
	const message = Message.error(sprintf('Error in processing request: No event with name %1$s found in database %2$s.', itemName, htmlspecialchars(backquote(context.db))));
	if (response.isAjax) {
		response.setRequestStatus(false);
		response.addJSON('message', message);
		return response.response();
	}
	response.addHTML(message.getDisplay());
	return null;
}

/** Events::getEventSchedulerStatus(). */
async function getEventSchedulerStatus(context: PmaContext): Promise<boolean> {
	const state = String(await context.dbi.fetchValue('SHOW GLOBAL VARIABLES LIKE \'event_scheduler\'', 1) || '');
	return state.toUpperCase() === 'ON' || state === '1';
}

/** Database\EventsController. */
export async function eventsController(context: PmaContext): Promise<Response> {
	const { db, dbi, response, request } = context;
	response.addScriptFiles(['database/events.js']);
	if (!response.isAjax) {
		if (!await hasDatabase(context)) {
			return response.response();
		}
		await getDbInfo(context, '');
	} else if (db !== '') {
		await dbi.selectDb(db);
	}
	const echoed = await handleEditor(context, []);
	if (echoed instanceof Response) {
		return echoed;
	}
	const exported = await exportEvent(context);
	if (exported !== null) {
		return exported;
	}
	const items = await getEvents(context, db);
	response.addHTML(await render(context, 'database/events/index', {
		db,
		items,
		has_privilege: await currentUserHasPrivilege(dbi, 'EVENT', db),
		scheduler_state: await getEventSchedulerStatus(context),
		text_dir: 'ltr',
		is_ajax: response.isAjax && phpEmpty(request.params.ajax_page_request),
	}));
	// Echoed output only shows when nothing was added with addHTML(), which the list always is.
	return response.response();
}

export const controllers = {
	'Database/EventsController': eventsController,
};

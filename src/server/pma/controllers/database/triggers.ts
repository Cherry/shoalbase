// Ports of Controllers\Database\TriggersController, Table\TriggersController and Database\Triggers.
import {
	getDbInfo,
	hasDatabase,
	render,
	requestString,
} from './common.ts';
import { type TriggerInfo, getTriggers } from './objects.ts';
import { Message } from '../../../../lib/pma/message.ts';
import { phpEmpty } from '../../../../lib/pma/server/php.ts';
import { sprintf } from '../../../../lib/pma/sprintf.ts';
import { htmlspecialchars } from '../../../../lib/twig/php.ts';
import { backquote } from '../../../../lib/twig/sanitize.ts';
import { getMessage } from '../../core/generator.ts';
import { currentUserHasPrivilege } from '../../shell/menu.ts';

import type { PmaContext } from '../../core/context.ts';

const TIMES = ['BEFORE', 'AFTER'];
const EVENTS = ['INSERT', 'UPDATE', 'DELETE'];

const FAILED_QUERY = 'The following query has failed: "%s"';

type TriggerItem = Record<string, string>;

/** Triggers::getDataFromName(): the editor values of a trigger, or null when the database has none by that name. */
async function getDataFromName(context: PmaContext, name: unknown): Promise<TriggerItem | null> {
	let found: TriggerInfo | null = null;
	for (const trigger of await getTriggers(context, context.db, context.table, '')) {
		if (trigger.name === String(name)) {
			found = trigger;
		}
	}
	if (found === null) {
		return null;
	}
	return {
		create: found.create,
		drop: found.drop,
		item_name: found.name,
		item_table: found.table,
		item_action_timing: found.action_timing,
		item_event_manipulation: found.event_manipulation,
		item_definition: found.definition,
		item_definer: found.definer,
	};
}

/** Triggers::getDataFromRequest(). */
function getDataFromRequest(context: PmaContext): TriggerItem {
	const item: TriggerItem = {};
	for (const key of ['item_name', 'item_table', 'item_original_name', 'item_action_timing', 'item_event_manipulation', 'item_definition', 'item_definer']) {
		item[key] = requestString(context.request.post[key]);
	}
	return item;
}

/** Triggers::getQueryFromRequest(): the CREATE TRIGGER statement, adding to `errors` what is missing. */
async function getQueryFromRequest(context: PmaContext, errors: string[]): Promise<string> {
	const post = context.request.post;
	let query = 'CREATE ';
	const definer = requestString(post.item_definer);
	if (!phpEmpty(post.item_definer)) {
		if (definer.includes('@')) {
			const parts = definer.split('@');
			query += `DEFINER=${backquote(parts[0])}@${backquote(parts[1])} `;
		} else {
			errors.push('The definer must be in the "username@hostname" format!');
		}
	}
	query += 'TRIGGER ';
	if (phpEmpty(post.item_name)) {
		errors.push('You must provide a trigger name!');
	} else {
		query += `${backquote(post.item_name)} `;
	}
	const timing = requestString(post.item_timing);
	if (TIMES.includes(timing)) {
		query += `${timing} `;
	} else {
		errors.push('You must provide a valid timing for the trigger!');
	}
	const event = requestString(post.item_event);
	if (EVENTS.includes(event)) {
		query += `${event} `;
	} else {
		errors.push('You must provide a valid event for the trigger!');
	}
	query += 'ON ';
	const table = requestString(post.item_table);
	let tableExists = false;
	if (!phpEmpty(table)) {
		const tables = await context.dbi.getTables(context.db);
		tableExists = tables.includes(table);
	}
	if (tableExists) {
		query += backquote(table);
	} else {
		errors.push('You must provide a valid table name!');
	}
	query += ' FOR EACH ROW ';
	if (phpEmpty(post.item_definition)) {
		errors.push('You must provide a trigger definition.');
	} else {
		query += requestString(post.item_definition);
	}
	return query;
}

function queryFailed(context: PmaContext, query: string, separator: string): string {
	return `${sprintf(FAILED_QUERY, htmlspecialchars(query))}${separator}MySQL said: ${context.dbi.getError()}`;
}

async function renderRow(context: PmaContext, trigger: TriggerInfo | false, hasPrivilege: boolean, rowClass: string): Promise<string> {
	return render(context, 'database/triggers/row', {
		db: context.db,
		table: context.table,
		trigger,
		has_drop_privilege: hasPrivilege,
		has_edit_privilege: hasPrivilege,
		row_class: rowClass,
	});
}

/** Triggers::handleEditor() for a submitted form; returns the AJAX response or null to go on. */
async function processEditor(context: PmaContext, errors: string[]): Promise<Response | null> {
	const { dbi, response, request } = context;
	const post = request.post;
	let message: Message | undefined;
	let sqlQuery = '';
	const itemQuery = await getQueryFromRequest(context, errors);
	if (errors.length === 0) {
		if (phpEmpty(post.editor_process_edit)) {
			if (await dbi.tryQuery(itemQuery) === false) {
				errors.push(queryFailed(context, itemQuery, '<br><br>'));
			} else {
				message = Message.success('Trigger %1$s has been created.');
				message.addParam(backquote(post.item_name));
				sqlQuery = itemQuery;
			}
		} else {
			// The old trigger is dropped first and restored if the new definition fails.
			const trigger = await getDataFromName(context, post.item_original_name);
			const createItem = trigger?.create ?? '';
			const dropItem = `${trigger?.drop ?? ''};`;
			if (await dbi.tryQuery(dropItem) === false) {
				errors.push(queryFailed(context, dropItem, '<br>'));
			} else if (await dbi.tryQuery(itemQuery) === false) {
				errors.push(queryFailed(context, itemQuery, '<br>'));
				if (await dbi.tryQuery(createItem) === false) {
					errors.push(`Sorry, we failed to restore the dropped trigger.<br>The backed up query was:"${htmlspecialchars(createItem)}"<br>MySQL said: ${dbi.getError()}`);
				}
			} else {
				message = Message.success('Trigger %1$s has been modified.');
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
	// Upstream passes an undefined $message when nothing was done, which PHP turns into an empty message.
	const output = await getMessage(context, message ?? '', { sqlQuery });
	// The global $message is what the Header shows, also as the displayMessage of AJAX responses.
	response.globals.message = message;
	if (!response.isAjax) {
		return null;
	}
	if (message?.isSuccess()) {
		let trigger: TriggerInfo | false = false;
		for (const value of await getTriggers(context, context.db, context.table, '')) {
			if (value.name === String(post.item_name)) {
				trigger = value;
			}
		}
		let insert = false;
		if (phpEmpty(context.table) || (trigger !== false && context.table === trigger.table)) {
			insert = true;
			const hasPrivilege = await currentUserHasPrivilege(dbi, 'TRIGGER', context.db, context.table);
			response.addJSON('new_row', await renderRow(context, trigger, hasPrivilege, ''));
			response.addJSON('name', htmlspecialchars(requestString(post.item_name).toUpperCase()));
		}
		response.addJSON('insert', insert);
		response.addJSON('message', output);
	} else {
		response.addJSON('message', message ?? '');
		response.setRequestStatus(false);
	}
	response.addJSON('tableType', 'triggers');
	return response.response();
}

/** Triggers::sendEditor(). */
async function sendEditor(context: PmaContext, mode: string, item: TriggerItem | null, title: string): Promise<Response> {
	const { dbi, response } = context;
	if (item !== null) {
		const query = `SELECT \`TABLE_NAME\` FROM \`INFORMATION_SCHEMA\`.\`TABLES\` WHERE \`TABLE_SCHEMA\`='${dbi.escapeString(context.db)}' AND \`TABLE_TYPE\` IN ('BASE TABLE', 'SYSTEM VERSIONED')`;
		const tables = await dbi.fetchResult<string>(query);
		const editor = await render(context, 'database/triggers/editor_form', {
			db: context.db,
			table: context.table,
			is_edit: mode === 'edit',
			item,
			tables,
			time: TIMES,
			events: EVENTS,
			is_ajax: response.isAjax,
		});
		if (response.isAjax) {
			response.addJSON('message', editor);
			response.addJSON('title', title);
		} else {
			response.addHTML(`\n\n<h2>${title}</h2>\n\n${editor}`);
		}
		return response.response();
	}
	const text = `Error in processing request: ${sprintf('No trigger with name %1$s found in database %2$s.', htmlspecialchars(backquote(context.request.params.item_name)), htmlspecialchars(backquote(context.db)))}`;
	const message = Message.error(text);
	if (response.isAjax) {
		response.setRequestStatus(false);
		response.addJSON('message', message);
		return response.response();
	}
	response.addHTML(message.getDisplay());
	return response.response();
}

/** Triggers::handleEditor(); a Response when the request ends there. */
async function handleEditor(context: PmaContext, errors: string[]): Promise<Response | null> {
	const { params, post } = context.request;
	const processing = !phpEmpty(post.editor_process_add) || !phpEmpty(post.editor_process_edit);
	if (processing) {
		const done = await processEditor(context, errors);
		if (done !== null) {
			return done;
		}
	}
	if (errors.length === 0 && (processing || (phpEmpty(params.add_item) && phpEmpty(params.edit_item)))) {
		return null;
	}
	let mode = '';
	let item: TriggerItem | null = null;
	let title = '';
	if (!phpEmpty(params.add_item)) {
		title = 'Add trigger';
		item = getDataFromRequest(context);
		mode = 'add';
	} else if (!phpEmpty(params.edit_item)) {
		title = 'Edit trigger';
		if (!phpEmpty(params.item_name) && phpEmpty(post.editor_process_edit)) {
			item = await getDataFromName(context, params.item_name);
			if (item !== null) {
				item.item_original_name = item.item_name;
			}
		} else {
			item = getDataFromRequest(context);
		}
		mode = 'edit';
	}
	return sendEditor(context, mode, item, title);
}

/** Triggers::export(): a Response when an AJAX export ends the request, true when it added page content. */
async function exportTrigger(context: PmaContext): Promise<Response | boolean> {
	const { response } = context;
	const query = context.request.query;
	if (phpEmpty(query.export_item) || phpEmpty(query.item_name)) {
		return false;
	}
	const itemName = query.item_name;
	let exportData: string | false = false;
	for (const trigger of await getTriggers(context, context.db, context.table, '')) {
		if (trigger.name === itemName) {
			exportData = trigger.create;
			break;
		}
	}
	if (exportData !== false) {
		const title = sprintf('Export of trigger %s', htmlspecialchars(backquote(itemName)));
		if (response.isAjax) {
			response.addJSON('message', htmlspecialchars(exportData.trim()));
			response.addJSON('title', title);
			return response.response();
		}
		response.addHTML(await render(context, 'database/triggers/export', { data: exportData, item_name: itemName }));
		return true;
	}
	const message = Message.error(sprintf(
		'Error in processing request: No trigger with name %1$s found in database %2$s.',
		htmlspecialchars(backquote(itemName)),
		htmlspecialchars(backquote(context.db)),
	));
	if (response.isAjax) {
		response.setRequestStatus(false);
		response.addJSON('message', message);
		return response.response();
	}
	response.addHTML(message.getDisplay());
	return true;
}

/** Triggers::main(). */
async function main(context: PmaContext, errors: string[]): Promise<Response> {
	const { dbi, response, request } = context;
	const handled = await handleEditor(context, errors);
	if (handled !== null) {
		return handled;
	}
	const exported = await exportTrigger(context);
	if (exported instanceof Response) {
		return exported;
	}
	const items = await getTriggers(context, context.db, context.table);
	const hasPrivilege = await currentUserHasPrivilege(dbi, 'TRIGGER', context.db, context.table);
	const isAjax = response.isAjax && phpEmpty(request.params.ajax_page_request);
	let rows = '';
	for (const item of items) {
		rows += await renderRow(context, item, hasPrivilege, isAjax ? 'ajaxInsert hide' : '');
	}
	// The list is echoed upstream, and ResponseRenderer only uses echoed output when nothing was added with addHTML().
	if (exported) {
		return response.response();
	}
	response.addHTML(await render(context, 'database/triggers/list', {
		db: context.db,
		table: context.table,
		items,
		rows,
		has_privilege: hasPrivilege,
	}));
	return response.response();
}

/** Database\TriggersController and Table\TriggersController, which are the same code upstream. */
export async function triggersController(context: PmaContext): Promise<Response> {
	const { db, dbi, response } = context;
	response.addScriptFiles(['database/triggers.js']);
	if (!response.isAjax) {
		let tableExists = false;
		if (context.table !== '') {
			const tables = await dbi.getTables(db);
			tableExists = tables.includes(context.table);
		}
		if (tableExists) {
			// DbTableExists::check() passes: the table was just listed.
			await dbi.selectDb(db);
		} else {
			context.table = '';
			if (!await hasDatabase(context)) {
				return response.response();
			}
			await getDbInfo(context, '');
		}
	} else if (db !== '') {
		await dbi.selectDb(db);
	}
	return main(context, []);
}

export const controllers = {
	'Database/TriggersController': triggersController,
	'Table/TriggersController': triggersController,
};

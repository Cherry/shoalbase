// Ports of Controllers\Database\CentralColumnsController and CentralColumns\PopulateColumnsController without configuration
// storage: the list is always empty and every change reports that the feature is not ready.
import { internalErrorPage, render, requestString } from './common.ts';
import { Message } from '../../../../lib/pma/message.ts';
import { pageSelector } from '../../../../lib/pma/navigation-html.ts';
import { isNumericString } from '../../../../lib/pma/php-compare.ts';
import { phpEmpty } from '../../../../lib/pma/server/php.ts';
import { sprintf } from '../../../../lib/pma/sprintf.ts';
import { getAttributes } from '../../../../lib/pma/table-structure/types.ts';
import { getCharsets, getCollations } from '../../core/charsets.ts';

import type { PmaContext } from '../../core/context.ts';

const NOT_READY = 'The configuration storage is not ready for the central list of columns feature.';

/** Strict types make a null where a string parameter is declared a fatal TypeError before the storage check runs. */
function allStrings(values: unknown[]): boolean {
	return values.every(value => typeof value === 'string');
}

/** The (int) of a posted number, or the fallback when is_numeric() fails. */
function postedNumber(value: unknown, fallback: number): number {
	if (typeof value === 'string' && isNumericString(value)) {
		return Math.trunc(Number(value));
	}
	return fallback;
}

/** CentralColumns::updateOneColumn() as editSave()/addNewColumn() call it: a TypeError, or the not-ready error. */
function updateOneColumn(post: Record<string, unknown>, withOriginal: boolean): Message | null {
	let columnDefault = post.col_default;
	if (columnDefault === 'NONE' && post.col_default_sel !== 'USER_DEFINED') {
		columnDefault = '';
	}
	const required = [post.col_name, post.col_type, post.col_attribute, post.col_length, post.collation, post.col_extra ?? '', columnDefault];
	if (withOriginal) {
		required.push(post.orig_col_name);
	}
	return allStrings(required) ? Message.error(NOT_READY) : null;
}

/** CentralColumns::updateMultipleColumn(): null for a TypeError, true when there is nothing to update, else the first error. */
function updateMultipleColumn(post: Record<string, unknown>): Message | true | null {
	const field = (name: string, index: number): unknown => (Array.isArray(post[name]) ? (post[name] as string[])[index] : undefined);
	const original = post.orig_col_name;
	if (!Array.isArray(original)) {
		return null;
	}
	if (original.length === 0) {
		return true;
	}
	// The first row already fails, either on its parameter types or on the missing storage.
	let columnDefault = field('field_default_type', 0);
	if (columnDefault === 'NONE') {
		columnDefault = '';
	} else if (columnDefault === 'USER_DEFINED') {
		columnDefault = field('field_default_value', 0);
	}
	const names = ['orig_col_name', 'field_name', 'field_type', 'field_attribute', 'field_length', 'field_collation'];
	const required = [post.db, ...names.map(name => field(name, 0)), field('col_extra', 0) ?? '', columnDefault];
	if (!allStrings(required)) {
		return null;
	}
	return Message.error(NOT_READY);
}

/** CentralColumns::getTemplateVariablesForMain() with an empty list. */
async function mainVariables(context: PmaContext, totalRows: number, pos: number): Promise<Record<string, unknown>> {
	const { config, db, dbi } = context;
	const maxRows = Math.trunc(Number(config.MaxRows));
	const pageNow = pos / maxRows + 1;
	const totalPages = Math.ceil(totalRows / maxRows);
	const selector = totalPages > 1 ? pageSelector('pos', maxRows, pageNow, totalPages) : '';
	await dbi.selectDb(db);
	const tables = await dbi.getTables(db);
	const collations = await getCollations(context);
	const charsetMap = await getCharsets(context);
	const charsets = charsetMap.values().map((charset) => {
		return {
			name: charset.getName(),
			description: charset.getDescription(),
			collations: [...(collations.get(charset.getName())?.values() ?? [])].map((collation) => { return { name: collation.getName(), description: collation.getDescription() }; }),
		};
	}).toArray();
	return {
		db,
		total_rows: totalRows,
		max_rows: maxRows,
		pos,
		char_editing: config.CharEditing,
		attribute_types: getAttributes({ type: dbi.isMariaDB() ? 'MariaDB' : 'MySQL', version: dbi.getVersion() }),
		tn_nbTotalPage: totalPages,
		tn_page_selector: selector,
		tables,
		rows_list: [],
		rows_meta: [],
		default_values: [],
		types_upper: [],
		text_dir: 'ltr',
		charsets,
	};
}

/** Database\CentralColumnsController. */
export async function centralColumnsController(context: PmaContext): Promise<Response> {
	const { request, response } = context;
	const post = request.post;
	if (post.edit_save !== undefined) {
		const message = updateOneColumn(post, true);
		if (message === null) {
			return internalErrorPage(context, 'TypeError');
		}
		// The message is echoed, which becomes the whole content.
		response.addHTML(message.getMessage());
		return response.response();
	}
	let failure: Message | null = null;
	if (post.add_new_column !== undefined) {
		failure = updateOneColumn(post, false);
		if (failure === null) {
			return internalErrorPage(context, 'TypeError');
		}
	}
	if (post.getColumnList !== undefined) {
		response.addJSON('message', []);
		return response.response();
	}
	if (post.add_column !== undefined) {
		failure = Message.error(NOT_READY);
	}
	response.addScriptFiles(['vendor/jquery/jquery.uitablefilter.js', 'vendor/jquery/jquery.tablesorter.js', 'database/central_columns.js']);
	if (post.edit_central_columns_page !== undefined) {
		if (!Array.isArray(post.selected_fld)) {
			return internalErrorPage(context, 'TypeError');
		}
		response.addHTML(await render(context, 'database/central_columns/edit', { rows: '' }));
		return response.response();
	}
	if (post.multi_edit_central_column_save !== undefined) {
		const updated = updateMultipleColumn(post);
		if (updated === null) {
			return internalErrorPage(context, 'TypeError');
		}
		if (updated !== true) {
			response.setRequestStatus(false);
			response.addJSON('message', updated);
		}
	}
	if (post.delete_save !== undefined) {
		// parse_str() turns any "selected_fld[...]" key into the array deleteColumnsFromList() requires.
		const keys = new URLSearchParams(requestString(post.col_name)).keys().toArray();
		const isList = keys.some(key => key.startsWith('selected_fld['));
		if (typeof post.col_name !== 'string' || typeof post.db !== 'string' || !isList) {
			return internalErrorPage(context, 'TypeError');
		}
		failure = Message.error(NOT_READY);
	}
	let totalRows = 0;
	if (!phpEmpty(post.total_rows)) {
		totalRows = postedNumber(post.total_rows, 0);
	}
	const pos = postedNumber(post.pos, 0);
	response.addHTML(await render(context, 'database/central_columns/main', await mainVariables(context, totalRows, pos)));
	// getColumnsCount() is 0 without storage, so the range always ends one before it starts.
	response.globals.message = failure ?? Message.success(sprintf('Showing rows %1$s - %2$s.', pos + 1, pos));
	return response.response();
}

/** Database\CentralColumns\PopulateColumnsController: every column of the table, as none is in the central list. */
export async function populateColumnsController(context: PmaContext): Promise<Response> {
	const { db, dbi, request, response } = context;
	await dbi.selectDb(db);
	const columns = await dbi.getColumnNames(db, requestString(request.post.selectedTable));
	response.addHTML(await render(context, 'database/central_columns/populate_columns', { columns }));
	return response.response();
}

export const controllers = {
	'Database/CentralColumnsController': centralColumnsController,
	'Database/CentralColumns/PopulateColumnsController': populateColumnsController,
};

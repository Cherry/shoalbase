// Ports of Controllers\Table\ChangeController (/table/change) and ChangeRowsController (/table/change/rows).
import {
	determineInsertOrEdit,
	editConfig,
	getCommentsMap,
	getHtmlForInsertEditRow,
	getTableColumns,
	hasBlobField,
	showTypeOrFunction,
} from './insert-edit.ts';
import { getForeigners } from './relation.ts';
import {
	castPostedBoolean,
	getHtmlForIgnoreOption,
	isWhereClauseNumeric,
	truthy,
} from '../../../../lib/pma/table-data/insert-edit.ts';
import {
	type PhpArray,
	isValidGoto,
	nestedParams,
	phpArray,
	phpScalar,
	phpValues,
} from '../../../../lib/pma/table-data/php-params.ts';
import { phpTrim } from '../../../../lib/twig/php.ts';
import { getCommon, getFromRoute, getHiddenInputs } from '../../../../lib/twig/url.ts';
import { getMessage } from '../../core/generator.ts';
import { getPageSettings } from '../../core/page-settings.ts';
import { checkSqlQuerySignature } from '../../core/sql-signature.ts';
import { checkDbTableExists, render } from '../table-structure/common.ts';

import type { Message } from '../../../../lib/pma/message.ts';
import type { DbiResult } from '../../core/dbi.ts';
import type { Controller, ControllerContext } from '../../dispatcher.ts';

export { isValidGoto };

/** $GLOBALS['goto'] as Common::run() leaves it. */
export function requestGoto(context: ControllerContext): string {
	const goto = context.request.params.goto;
	return isValidGoto(goto) ? goto : '';
}

/** What ReplaceController hands over when it shows the form again ($disp_message, $GLOBALS['goto'] and the edited $_POST). */
export interface ChangeOverrides {
	goto?: string;
	dispMessage?: Message;
	/** $_POST as ReplaceController left it. */
	post?: PhpArray;
}

/** ChangeController::__invoke(); `whereClause` is the global ChangeRowsController sets. */
export async function renderChangeForm(context: ControllerContext, whereClause: string | string[] | null = null, overrides: ChangeOverrides = {}): Promise<Response> {
	const { response, request, config } = context;
	const post = overrides.post ?? nestedParams(request.post);
	const get = nestedParams(request.query);

	const pageSettings = await getPageSettings(context, 'Edit');
	if (pageSettings.saved) {
		return response.response();
	}
	response.addHTML(pageSettings.errorHtml);
	response.addHTML(pageSettings.html);

	const missing = await checkDbTableExists(context);
	if (missing !== null) {
		return missing;
	}
	const { db, table } = context;

	let initialWhereClause: string | string[] | null = whereClause;
	const getWhere = phpScalar(get.where_clause);
	if (getWhere !== undefined && get.where_clause_signature !== undefined && checkSqlQuerySignature(context.session, getWhere, phpScalar(get.where_clause_signature))) {
		initialWhereClause = getWhere;
	}

	let initialWhereValue: PhpArray | string | null;
	if (Array.isArray(initialWhereClause)) {
		initialWhereValue = Object.fromEntries(initialWhereClause.map((clause, index) => [String(index), clause]));
	} else {
		initialWhereValue = initialWhereClause;
	}
	const state = await determineInsertOrEdit(context, post, get, initialWhereValue, db, table);
	// A rejected Edit settings form leaves FormDisplay::save()'s boolean casts in $_POST, which determineInsertOrEdit() copied.
	if (phpScalar(post.submit_save) === 'Edit') {
		const editConfigValues: Record<string, unknown> = config;
		for (const key of ['ShowFunctionFields', 'ShowFieldTypesInDataEditView']) {
			editConfigValues[key] = castPostedBoolean(post[key]);
		}
	}

	let goto = overrides.goto ?? requestGoto(context);
	if (goto === '') {
		goto = getFromRoute(context.urlState(), table.length > 0 ? '/table/sql' : '/database/sql');
	}
	const postedSqlQuery = phpScalar(post.sql_query) ?? '';
	const errorParams: Record<string, unknown> = { db, sql_query: postedSqlQuery };
	if (goto.startsWith('index.php?route=/table')) {
		errorParams.table = table;
	}
	const errorUrl = goto + getCommon(context.urlState(), errorParams, goto.includes('?') ? '&' : '?');

	const commentsMap = await getCommentsMap(context, db, table);
	response.addScriptFiles(['makegrid.js', 'sql.js', 'table/change.js', 'vendor/jquery/additional-methods.js', 'gis_data_editor.js']);

	if (overrides.dispMessage !== undefined) {
		response.addHTML(await getMessage(context, overrides.dispMessage, { sqlQuery: response.globals.displayQuery ?? response.globals.sqlQuery }));
	}

	const tableColumns = await getTableColumns(context, db, table);
	const foreigners = await getForeigners(context, db, table);

	// InsertEdit::getFormParametersForInsertForm().
	const formParams: Record<string, unknown> = { db, table, goto, err_url: errorUrl, sql_query: postedSqlQuery };
	const getSqlQuery = phpScalar(get.sql_query);
	if (formParams.sql_query === '' && getSqlQuery !== undefined && get.sql_signature !== undefined && checkSqlQuerySignature(context.session, getSqlQuery, phpScalar(get.sql_signature))) {
		formParams.sql_query = getSqlQuery;
	}
	if (state.whereClauses !== null) {
		for (const [keyId, clause] of state.whereClauseArray) {
			formParams[`where_clause[${keyId}]`] = phpTrim(clause);
		}
	}
	if (post.clause_is_unique !== undefined) {
		formParams.clause_is_unique = post.clause_is_unique;
	} else if (get.clause_is_unique !== undefined) {
		formParams.clause_is_unique = get.clause_is_unique;
	}

	const urlParams: Record<string, unknown> = { db, table };
	// InsertEdit::urlParamsInEditMode().
	for (const [, clause] of state.whereClauseArray) {
		urlParams.where_clause = phpTrim(clause);
	}
	if (postedSqlQuery !== '' && postedSqlQuery !== '0') {
		urlParams.sql_query = postedSqlQuery;
	}

	const cfg = editConfig(context);
	const isUpload = true;
	const url = context.urlState();
	let html = await render(context, 'table/insert/get_html_for_insert_edit_form_header', { has_blob_field: hasBlobField(tableColumns), is_upload: isUpload });
	html += getHiddenInputs(url, formParams);
	if (!truthy(cfg.ShowFunctionFields) || !truthy(cfg.ShowFieldTypesInDataEditView)) {
		html += 'Show';
	}
	if (!truthy(cfg.ShowFunctionFields)) {
		html += showTypeOrFunction(context, 'function', urlParams, false, cfg);
	}
	if (!truthy(cfg.ShowFieldTypesInDataEditView)) {
		html += showTypeOrFunction(context, 'type', urlParams, false, cfg);
	}

	const defaultAction = phpScalar(post.default_action) ?? phpScalar(get.default_action) ?? '';
	const rowState = { oRows: 0, tabindex: 0 };
	for (const [rowKey, row] of state.rows) {
		const rowId = Number(rowKey);
		let currentResult: DbiResult;
		if (state.insertMode) {
			currentResult = state.result as DbiResult;
		} else {
			currentResult = (state.result as Map<string, DbiResult>).get(rowKey) as DbiResult;
		}
		if (state.insertMode && rowId > 0) {
			html += getHtmlForIgnoreOption(rowId, true);
		}
		html += await getHtmlForInsertEditRow(context, {
			urlParams,
			tableColumns,
			commentsMap,
			timestampSeen: false,
			currentResult,
			jsvkey: rowKey,
			vkey: `[multi_edit][${rowKey}]`,
			insertMode: state.insertMode,
			currentRow: row === false || row === null ? null : row,
			isUpload,
			foreigners,
			table,
			db,
			rowId,
			whereClauseArray: state.whereClauseArray,
			defaultAction,
			postedWhereClause: post.where_clause !== undefined,
		}, rowState, cfg);
	}

	html += await render(context, 'table/insert/actions_panel', {
		where_clause: state.whereClause,
		after_insert: state.afterInsert ?? 'back',
		found_unique_key: state.foundUniqueKey,
		is_numeric: isWhereClauseNumeric(state.whereClause),
	});
	html += '</form>';
	html += '<div id="gis_editor"></div><div id="popup_background"></div><br>';

	if (state.insertMode) {
		html += await render(context, 'table/insert/continue_insertion_form', {
			db,
			table,
			where_clause_array: new Map(state.whereClauseArray),
			err_url: errorUrl,
			goto,
			sql_query: phpScalar(post.sql_query) ?? null,
			has_where_clause: post.where_clause !== undefined,
			insert_rows_default: config.InsertRows,
		});
	}
	response.addHTML(html);
	return response.response();
}

const changeController: Controller = async context => renderChangeForm(context);

const changeRowsController: Controller = async (context) => {
	const { response, request } = context;
	const post = nestedParams(request.post);
	const rows = phpArray(post.rows_to_delete);
	if (request.post.goto !== undefined && isValidGoto(request.post.goto) && rows === undefined) {
		response.setRequestStatus(false);
		response.addJSON('message', 'No row selected.');
		return response.response();
	}
	const whereClause = rows === undefined ? [] : phpValues(rows).map(value => (typeof value === 'string' ? value : ''));
	return renderChangeForm(context, whereClause);
};

export const controllers = {
	'Table/ChangeController': changeController,
	'Table/ChangeRowsController': changeRowsController,
};


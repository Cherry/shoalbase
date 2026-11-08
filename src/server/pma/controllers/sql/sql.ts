// Ports of Controllers\Sql\*: the /sql query runner (the default table view) and its grid-editing AJAX helpers.
import { getColumnsSql } from '../../../../lib/pma/dbi-sql.ts';
import { Message } from '../../../../lib/pma/message.ts';
import { RELATIONAL_DISPLAY_COLUMN } from '../../../../lib/pma/sql/results.ts';
import { hasNoRightsToDropDatabase, parseEnumSetValues } from '../../../../lib/pma/sql/sql.ts';
import { nestedParams } from '../../../../lib/pma/table-data/php-params.ts';
import { foreignDropdown } from '../../../../lib/pma/table-data/relation.ts';
import { getScriptNameForOption } from '../../../../lib/pma/util.ts';
import { getFromRoute } from '../../../../lib/twig/url.ts';
import { renderTemplate } from '../../../twig/render.ts';
import { getPageSettings } from '../../core/page-settings.ts';
import { checkSqlQuerySignature } from '../../core/sql-signature.ts';
import { PROP_COLUMN_ORDER, PROP_COLUMN_VISIB, Table } from '../../core/table.ts';
import {
	Sql,
	SqlExit,
	SqlValueError,
	defaultSqlQueryForBrowse,
	isForeignKeyCheckEnabled,
	parseAnalyze,
	requestGoto,
} from '../../display/sql.ts';
import { disableResponse } from '../database/common.ts';
import { mysqlDieMessage } from '../server/mysql-die.ts';
import { dropdownConfig, getForeignData, getForeigners } from '../table-data/relation.ts';

import type { PmaContext } from '../../core/context.ts';
import type { ControllerContext } from '../../dispatcher.ts';

const scalar = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

const isEmpty = (value: unknown): boolean => [undefined, null, '', '0'].includes(value as string);

// Other families import it from here.
export { requestGoto };

/** Runs a body that may hit upstream's exit inside Sql, returning the response built so far when it does. */
async function untilExit(context: PmaContext, body: () => Promise<void>): Promise<Response> {
	const { response } = context;
	try {
		await body();
	} catch (error) {
		if (error instanceof SqlValueError) {
			// PHP's fatal error page follows whatever was already printed, without the phpMyAdmin page around it.
			response.addHTML('<html><head><title>Internal error: ValueError</title></head>\n<div class="alert alert-danger" role="alert"><img src="themes/dot.gif" title="" alt="" class="icon ic_s_error"> ValueError</div></body></html>');
			disableResponse(context);
		} else if (!(error instanceof SqlExit)) {
			throw error;
		}
	}
	return response.response();
}

/** SqlController::addBookmark() without pmadb: no bookmark can be created. */
async function addBookmark(context: PmaContext, goto: string): Promise<Response> {
	const { response } = context;
	if (!response.isAjax) {
		const fields = nestedParams(context.request.post).bkm_fields;
		const label = typeof fields === 'object' ? scalar(fields.bkm_label) ?? '' : '';
		// Core::sendHeaderLocation() only adds the header; the page still renders behind the 302.
		response.header('Location', `/${goto}&label=${label}`.replace('/./', '/'));
		return response.response();
	}
	response.setRequestStatus(false);
	response.addJSON('message', Message.error('Bookmark not created!'));
	return response.response();
}

/** Controllers\Sql\SqlController. */
export async function sqlController(context: ControllerContext): Promise<Response> {
	const { dbi, response, request, config } = context;
	await dbi.getUserPrivileges();
	const settings = await getPageSettings(context, 'Browse');
	if (settings.saved) {
		return response.response();
	}
	response.addHTML(settings.errorHtml);
	response.addHTML(settings.html);
	response.addScriptFiles(['vendor/jquery/jquery.uitablefilter.js', 'table/change.js', 'indexes.js', 'gis_data_editor.js', 'multi_column_sort.js']);

	let goto = requestGoto(context);
	const url = context.urlState();
	if (goto === '' && context.table === '') {
		goto = getScriptNameForOption(url, config.DefaultTabDatabase, 'database');
	} else if (goto === '') {
		goto = getScriptNameForOption(url, config.DefaultTabTable, 'table');
	}

	const post = nestedParams(request.post);
	const bookmarkFields = typeof post.bkm_fields === 'object' ? post.bkm_fields : {};
	let sqlQuery: string | undefined;
	if (typeof bookmarkFields.bkm_sql_query === 'string') {
		sqlQuery = bookmarkFields.bkm_sql_query;
	} else if (typeof post.sql_query === 'string') {
		sqlQuery = post.sql_query;
	} else {
		const signed = scalar(request.query.sql_query);
		if (signed !== undefined && request.query.sql_signature !== undefined && checkSqlQuerySignature(context.session, signed, scalar(request.query.sql_signature))) {
			sqlQuery = signed;
		}
	}
	if (typeof bookmarkFields.bkm_database === 'string') {
		context.db = bookmarkFields.bkm_database;
	}

	// Without a query of its own, $sql_query keeps the value Common::run() gave it.
	sqlQuery ??= response.globals.sqlQuery;
	if (isEmpty(sqlQuery) && context.table !== '' && context.db !== '') {
		goto = '';
		sqlQuery = await defaultSqlQueryForBrowse(context, context.db, context.table);
	}
	const query = sqlQuery;
	response.globals.sqlQuery = query;

	const [analyzed, db, tableFromSql] = parseAnalyze(context, query, context.db);
	context.db = db;
	if (tableFromSql !== '' && tableFromSql !== context.table) {
		context.table = tableFromSql;
	}

	if (hasNoRightsToDropDatabase(analyzed, config.AllowUserDropDatabase, await dbi.isSuperUser())) {
		if (response.isAjax) {
			response.setRequestStatus(false);
			response.addJSON('message', mysqlDieMessage(context, '"DROP DATABASE" statements are disabled.', query, false));
		}
		return response.response();
	}

	if (request.post.store_bkm !== undefined) {
		return addBookmark(context, goto);
	}

	let isGotoFile = true;
	if (goto === getFromRoute(url, '/sql')) {
		isGotoFile = false;
		goto = getFromRoute(url, '/sql', { db: context.db, table: context.table, sql_query: query });
	}

	const sql = new Sql(context);
	return untilExit(context, async () => {
		response.addHTML(await sql.executeQueryAndSendQueryResponse({
			analyzed,
			isGotoFile,
			db: context.db,
			table: context.table,
			findRealEnd: null,
			extraData: null,
			messageToShow: null,
			sqlData: null,
			goto,
			// What a forwarding controller (ReplaceController) left: isset($disp_query) ? $display_query : null.
			dispQuery: response.globals.dispQuery === undefined ? null : response.globals.displayQuery ?? null,
			dispMessage: response.globals.dispMessage ?? null,
			sqlQuery: query,
			completeQuery: null,
		}));
	});
}

/** Controllers\Sql\ColumnPreferencesController: stores the dragged column order and visibility. */
async function columnPreferencesController(context: ControllerContext): Promise<Response> {
	const { response, request } = context;
	await context.dbi.getUserPrivileges();
	const table = Table.get(context, context.table, context.db);
	const createTime = scalar(request.post.table_create_time) ?? null;
	// Sql::setColumnProperty(): array_map('intval', explode(',', ...)).
	const property = async (name: string, key: string): Promise<true | Message> => {
		const values = (scalar(request.post[key]) ?? '').split(',').map(value => Math.trunc(Number.parseFloat(value)) || 0);
		return table.setUiProp(name, values, createTime);
	};
	let status: boolean | Message = false;
	if (request.post.col_order !== undefined) {
		status = await property(PROP_COLUMN_ORDER, 'col_order');
	}
	if (status === true && request.post.col_visib !== undefined) {
		status = await property(PROP_COLUMN_VISIB, 'col_visib');
	}
	if (status instanceof Message) {
		response.setRequestStatus(false);
		response.addJSON('message', status.getString());
		return response.response();
	}
	response.setRequestStatus(status);
	return response.response();
}

/** Controllers\Sql\DefaultForeignKeyCheckValueController. */
async function defaultForeignKeyCheckValueController(context: ControllerContext): Promise<Response> {
	await context.dbi.getUserPrivileges();
	context.response.addJSON('default_fk_check_value', await isForeignKeyCheckEnabled(context));
	return context.response.response();
}

/** Sql::getValuesForColumn(): the ENUM or SET members of a column, or null when it is unknown. */
async function valuesForColumn(context: PmaContext, column: string): Promise<string[] | null> {
	const rows = await context.dbi.fetchResult(getColumnsSql(context.db, context.table, context.dbi.escapeString(column)));
	const first = rows[0];
	if (first === undefined) {
		return null;
	}
	return parseEnumSetValues(first.Type ?? '');
}

/** Controllers\Sql\EnumValuesController. */
async function enumValuesController(context: ControllerContext): Promise<Response> {
	const { response, request } = context;
	await context.dbi.getUserPrivileges();
	const values = await valuesForColumn(context, scalar(request.post.column) ?? '');
	if (values === null) {
		response.addJSON('message', 'Error in processing request');
		response.setRequestStatus(false);
		return response.response();
	}
	const dropdown = await renderTemplate('sql/enum_column_dropdown', {
		values,
		selected_values: [scalar(request.post.curr_value) ?? ''],
	}, await context.templateState());
	response.addJSON('dropdown', dropdown);
	return response.response();
}

/** Controllers\Sql\SetValuesController. */
async function setValuesController(context: ControllerContext): Promise<Response> {
	const { response, request, dbi } = context;
	await dbi.getUserPrivileges();
	const column = scalar(request.post.column) ?? '';
	let currentValue = scalar(request.post.curr_value) ?? '';
	const fullValues = request.post.get_full_values;
	const whereClause = scalar(request.post.where_clause);
	const values = await valuesForColumn(context, column);
	if (values === null) {
		response.addJSON('message', 'Error in processing request');
		response.setRequestStatus(false);
		return response.response();
	}
	if (!isEmpty(fullValues) && whereClause !== undefined && !isEmpty(whereClause)) {
		// Sql::getFullValuesForSetColumn().
		const row = await dbi.fetchSingleRow(`SELECT \`${column}\` FROM \`${context.db}\`.\`${context.table}\` WHERE ${whereClause}`);
		currentValue = row === null ? '' : row[column] ?? '';
	}
	const select = await renderTemplate('sql/set_column', { values, current_values: currentValue.split(',') }, await context.templateState());
	response.addJSON('select', select);
	return response.response();
}

/** Controllers\Sql\RelationalValuesController: Sql::getHtmlForRelationalColumnDropdown(). */
async function relationalValuesController(context: ControllerContext): Promise<Response> {
	const { response, request, config } = context;
	await context.dbi.getUserPrivileges();
	const column = scalar(request.post.column) ?? '';
	let currentValue = scalar(request.post.curr_value) ?? '';
	const keyOrDisplay = scalar(request.post.relation_key_or_display_column);
	if (context.session.tmpval.relational_display === RELATIONAL_DISPLAY_COLUMN && !isEmpty(keyOrDisplay)) {
		currentValue = keyOrDisplay ?? '';
	}
	const foreigners = await getForeigners(context, context.db, context.table);
	const data = await getForeignData(context, foreigners, column, false, '', '');
	let dropdown: string;
	if (data.disp_row === null) {
		dropdown = await renderTemplate('sql/relational_column_dropdown', {
			current_value: request.post.curr_value,
			params: { db: context.db, table: context.table, field: column },
		}, await context.templateState());
	} else {
		dropdown = `<select>${foreignDropdown(data.disp_row, data.foreign_field ?? '', data.foreign_display, currentValue, dropdownConfig(context), config.ForeignKeyMaxLimit)}</select>`;
	}
	response.addJSON('dropdown', dropdown);
	return response.response();
}


export const controllers = {
	'Sql/SqlController': sqlController,
	'Sql/ColumnPreferencesController': columnPreferencesController,
	'Sql/DefaultForeignKeyCheckValueController': defaultForeignKeyCheckValueController,
	'Sql/EnumValuesController': enumValuesController,
	'Sql/SetValuesController': setValuesController,
	'Sql/RelationalValuesController': relationalValuesController,
};

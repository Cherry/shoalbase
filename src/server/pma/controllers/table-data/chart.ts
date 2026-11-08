// Port of Controllers\Table\ChartController (/table/chart).
import { loadParserContext } from './relation.ts';
import { FieldType } from '../../../../lib/pma/field-metadata.ts';
import { phpJsonEncode } from '../../../../lib/pma/json.ts';
import { Message } from '../../../../lib/pma/message.ts';
import { getScriptNameForOption } from '../../../../lib/pma/util.ts';
import { htmlspecialchars } from '../../../../lib/twig/php.ts';
import { getFromRoute } from '../../../../lib/twig/url.ts';
import { Limit, Parser, SelectStatement } from '../../../../sql-parser/index.ts';
import { hasDatabase } from '../database/common.ts';
import { checkDbTableExists, render } from '../table-structure/common.ts';

import type { FieldMetadata } from '../../../../lib/pma/field-metadata.ts';
import type { PmaContext } from '../../core/context.ts';
import type { DbiRow } from '../../core/dbi.ts';
import type { Controller, ControllerContext } from '../../dispatcher.ts';

const CHART_SCRIPTS = [
	'chart.js',
	'table/chart.js',
	'vendor/jqplot/jquery.jqplot.js',
	'vendor/jqplot/plugins/jqplot.barRenderer.js',
	'vendor/jqplot/plugins/jqplot.canvasAxisLabelRenderer.js',
	'vendor/jqplot/plugins/jqplot.canvasTextRenderer.js',
	'vendor/jqplot/plugins/jqplot.categoryAxisRenderer.js',
	'vendor/jqplot/plugins/jqplot.dateAxisRenderer.js',
	'vendor/jqplot/plugins/jqplot.pointLabels.js',
	'vendor/jqplot/plugins/jqplot.pieRenderer.js',
	'vendor/jqplot/plugins/jqplot.enhancedPieLegendRenderer.js',
	'vendor/jqplot/plugins/jqplot.highlighter.js',
];

/** PHP's (int) cast of a request string. */
function phpInt(value: unknown): number {
	if (typeof value !== 'string') {
		return 0;
	}
	const match = /^[\t\n\v\f\r ]*[+-]?\d+/.exec(value);
	return match === null ? 0 : Number.parseInt(match[0], 10);
}

/** Generator::getStartAndNumberOfRowsFieldsetData(). */
export function getStartAndNumberOfRowsFieldsetData(context: PmaContext, sqlQuery: string): Record<string, unknown> {
	const { params } = context.request;
	const tmpval = context.session.tmpval;
	let rows: number;
	if (params.session_max_rows !== undefined) {
		rows = phpInt(params.session_max_rows);
	} else if (tmpval.max_rows !== undefined && tmpval.max_rows !== 'all') {
		rows = Math.trunc(Number(tmpval.max_rows));
	} else {
		rows = Math.trunc(Number(context.config.MaxRows));
		tmpval.max_rows = rows;
	}
	const numberOfLine = phpInt(params.unlim_num_rows);
	let pos: number;
	if (params.pos !== undefined) {
		pos = phpInt(params.pos);
	} else if (tmpval.pos !== undefined) {
		pos = Math.trunc(Number(tmpval.pos));
	} else {
		pos = (Math.ceil(numberOfLine / rows) - 1) * rows;
		tmpval.pos = pos;
	}
	return { pos, unlim_num_rows: numberOfLine, rows, sql_query: sqlQuery };
}

/** PHP's numeric value of a request string or parser token. */
function phpNumber(value: unknown): number {
	if (typeof value === 'number') {
		return value;
	}
	const match = /^[\t\n\v\f\r ]*[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?/i.exec(String(value ?? ''));
	return match === null ? 0 : Number(match[0]);
}

/** ChartController::ajax(): the next page of chart data for the given position. */
async function chartData(context: PmaContext): Promise<Response> {
	const { response, dbi, request } = context;
	if (context.table !== '' && context.db !== '') {
		const missing = await checkDbTableExists(context);
		if (missing !== null) {
			return missing;
		}
	}
	await dbi.connect();
	loadParserContext(context);
	const statement = new Parser(response.globals.sqlQuery).statements[0];
	const maxRows = String(request.params.session_max_rows ?? '');
	const pos = String(request.params.pos ?? '');
	let data: DbiRow[] = [];
	if (statement instanceof SelectStatement) {
		if (statement.limit === null) {
			statement.limit = new Limit(maxRows, pos);
		} else {
			const start = phpNumber(statement.limit.offset) + phpNumber(pos);
			const remaining = phpNumber(statement.limit.rowCount) - phpNumber(pos);
			statement.limit = new Limit(phpNumber(maxRows) <= remaining ? maxRows : remaining, start);
		}
		const result = await dbi.tryQuery(statement.build());
		if (result !== false) {
			data = result.fetchAllAssoc();
		}
	}
	if (data.length === 0) {
		response.setRequestStatus(false);
		response.addJSON('message', 'No data to display');
		return response.response();
	}
	const sanitized = data.map(row => Object.fromEntries(Object.entries(row).map(([column, value]) => [htmlspecialchars(column), value === null ? null : htmlspecialchars(value)])));
	response.setRequestStatus(true);
	response.addJSON('message', null);
	response.addJSON('chartData', phpJsonEncode(sanitized));
	return response.response();
}

async function chart(context: ControllerContext): Promise<Response> {
	const { response, request, dbi, config } = context;
	if (request.params.pos !== undefined && request.params.session_max_rows !== undefined && response.isAjax) {
		return chartData(context);
	}
	const sqlQuery = response.globals.sqlQuery;
	if (sqlQuery === '') {
		response.setRequestStatus(false);
		response.addHTML(Message.error('No SQL query was set to fetch data.').getDisplay());
		return response.response();
	}
	response.addScriptFiles(CHART_SCRIPTS);

	const url = context.urlState();
	let urlParams: Record<string, unknown> = {};
	if (context.table !== '') {
		urlParams = { db: context.db, table: context.table };
		const missing = await checkDbTableExists(context);
		if (missing !== null) {
			return missing;
		}
		urlParams.goto = getScriptNameForOption(url, config.DefaultTabTable, 'table');
		urlParams.back = getFromRoute(url, '/table/sql');
		await dbi.selectDb(context.db);
	} else if (context.db !== '') {
		urlParams.goto = getScriptNameForOption(url, config.DefaultTabDatabase, 'database');
		urlParams.back = getFromRoute(url, '/sql');
		if (!await hasDatabase(context)) {
			return response.response();
		}
	} else {
		urlParams.goto = getScriptNameForOption(url, config.DefaultTabServer, 'server');
		urlParams.back = getFromRoute(url, '/sql');
		if (await dbi.isSuperUser()) {
			await dbi.selectDb('mysql');
		}
	}

	const result = await dbi.tryQuery(sqlQuery);
	let fieldsMeta: FieldMetadata[] = [];
	let row: DbiRow = {};
	if (result !== false) {
		fieldsMeta = result.getFieldsMeta();
		row = result.fetchAssoc() ?? {};
	}
	const keys = Object.keys(row);
	const numericColumnFound = keys.some((_key, index) => fieldsMeta[index] !== undefined && (fieldsMeta[index].isType(FieldType.INT) || fieldsMeta[index].isType(FieldType.REAL)));
	if (!numericColumnFound) {
		response.setRequestStatus(false);
		response.addJSON('message', 'No numeric columns present in the table to plot.');
		return response.response();
	}

	urlParams.db = context.db;
	urlParams.reload = 1;
	response.addHTML(await render(context, 'table/chart/tbl_chart', {
		url_params: urlParams,
		keys,
		fields_meta: fieldsMeta,
		table_has_a_numeric_column: numericColumnFound,
		start_and_number_of_rows_fieldset: getStartAndNumberOfRowsFieldsetData(context, sqlQuery),
	}));
	return response.response();
}

export const controllers: Record<string, Controller> = {
	'Table/ChartController': chart,
};

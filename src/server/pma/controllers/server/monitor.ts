// Ports of Server\Status\MonitorController with its AJAX endpoints, and Server\Status\AdvisorController.
import { selectMysqlForSuperUser } from './info-pages.ts';
import { withMysqlDie } from './mysql-die.ts';
import { renderServerTemplate } from './render.ts';
import { loadStatusData } from './status-data.ts';
import { runAdvisor } from '../../../../lib/pma/server/advisor.ts';
import { phpBool } from '../../../../lib/pma/server/expression.ts';
import {
	type ChartRequest,
	chartVariableNames,
	generalLogSummary,
	slowLogSummary,
	variablesQuery,
} from '../../../../lib/pma/server/monitor.ts';
import { phpInt } from '../../../../lib/pma/server/php.ts';
import { isNumeric } from '../../../../lib/pma/server/variables.ts';
import { isProfilingSupported } from '../../core/profiling.ts';

import type { ExpressionValue } from '../../../../lib/pma/server/expression.ts';
import type { PmaContext } from '../../core/context.ts';

// SysInfo::getOs() on the PHP host; the Worker has no /proc, so the Base SysInfo values are reported.
const SERVER_OS = 'Linux';

/** json_decode($json, true): objects keyed 0..n-1 become lists, as PHP arrays encode back. */
function phpArrayShape(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(item => phpArrayShape(item));
	}
	if (value === null || typeof value !== 'object') {
		return value;
	}
	const entries = Object.entries(value).map(([key, item]): [string, unknown] => [key, phpArrayShape(item)]);
	if (entries.length > 0 && entries.every(([key], index) => key === String(index))) {
		return entries.map(([, item]) => item);
	}
	return Object.fromEntries(entries);
}

/** The Status controllers start with the status Data and the superuser database switch. */
async function prepare(context: PmaContext) {
	const data = await loadStatusData(context);
	await selectMysqlForSuperUser(context);
	return data;
}

export async function monitorController(context: PmaContext): Promise<Response> {
	const data = await prepare(context);
	context.response.addScriptFiles([
		'vendor/jquery/jquery.tablesorter.js',
		'jquery.sortable-table.js',
		'vendor/jqplot/jquery.jqplot.js',
		'vendor/jqplot/plugins/jqplot.pieRenderer.js',
		'vendor/jqplot/plugins/jqplot.enhancedPieLegendRenderer.js',
		'vendor/jqplot/plugins/jqplot.canvasTextRenderer.js',
		'vendor/jqplot/plugins/jqplot.canvasAxisLabelRenderer.js',
		'vendor/jqplot/plugins/jqplot.dateAxisRenderer.js',
		'vendor/jqplot/plugins/jqplot.highlighter.js',
		'vendor/jqplot/plugins/jqplot.cursor.js',
		'jqplot/plugins/jqplot.byteFormatter.js',
		'server/status/monitor.js',
		'server/status/sorter.js',
		'chart.js',
	]);
	const form = {
		server_time: Date.now(),
		server_os: SERVER_OS,
		is_superuser: await context.dbi.isSuperUser(),
		server_db_isLocal: data.dbIsLocal,
	};
	const names = [...data.status].filter(([, value]) => isNumeric(value)).map(([name]) => name);
	context.response.addHTML(await renderServerTemplate(context, 'server/status/monitor/index', { javascript_variable_names: names, form }));
	return context.response.response();
}

export async function chartingDataController(context: PmaContext): Promise<Response> {
	await prepare(context);
	const { dbi, response, request } = context;
	if (!response.isAjax) {
		return response.response();
	}
	return withMysqlDie(context, async () => {
		let decoded: unknown;
		try {
			decoded = JSON.parse(String(request.post.requiredData ?? ''));
		} catch {
			decoded = null;
		}
		const chart = (decoded !== null && typeof decoded === 'object' ? decoded : {}) as ChartRequest;
		const { serverVars, statusVars } = chartVariableNames(chart);
		const message = phpArrayShape(chart) as Record<string, unknown>;
		for (const nodes of Object.values(message)) {
			for (const points of Object.values(nodes as Record<string, unknown>)) {
				for (const point of Object.values(points as Record<string, Record<string, unknown>>)) {
					if (point.type === 'proc') {
						const processes = await dbi.query('SHOW PROCESSLIST');
						point.value = processes.numRows();
					} else if (point.type === 'cpu') {
						point.idle = null;
						point.busy = null;
					} else if (point.type === 'memory') {
						point.value = 0;
					}
				}
			}
		}
		let statusValues = new Map<string, string | null>();
		if (statusVars.length > 0) {
			statusValues = await dbi.fetchResult<string | null>(variablesQuery('STATUS', statusVars), 0, 1);
		}
		let serverValues = new Map<string, string | null>();
		if (serverVars.length > 0) {
			serverValues = await dbi.fetchResult<string | null>(variablesQuery('VARIABLES', serverVars), 0, 1);
		}
		for (const nodes of Object.values(message)) {
			for (const points of Object.values(nodes as Record<string, unknown>)) {
				for (const point of Object.values(points as Record<string, Record<string, unknown>>)) {
					if (point.type === 'statusvar') {
						point.value = statusValues.get(String(point.name)) ?? null;
					} else if (point.type === 'servervar') {
						point.value = serverValues.get(String(point.name)) ?? null;
					}
				}
			}
		}
		const result = Array.isArray(message) ? Object.fromEntries(message.entries()) : message;
		result.x = Date.now();
		response.addJSON({ message: result });
		return response.response();
	});
}

export async function slowLogController(context: PmaContext): Promise<Response> {
	await prepare(context);
	const { dbi, response, request } = context;
	if (!response.isAjax) {
		return response.response();
	}
	const start = phpInt(request.post.time_start);
	const end = phpInt(request.post.time_end);
	const sql = 'SELECT start_time, user_host, Sec_to_Time(Sum(Time_to_Sec(query_time))) as query_time, '
		+ 'Sec_to_Time(Sum(Time_to_Sec(lock_time))) as lock_time, SUM(rows_sent) AS rows_sent, '
		+ 'SUM(rows_examined) AS rows_examined, db, sql_text, COUNT(sql_text) AS \'#\' FROM `mysql`.`slow_log` '
		+ `WHERE start_time > FROM_UNIXTIME(${start}) AND start_time < FROM_UNIXTIME(${end}) GROUP BY start_time, user_host, db, sql_text`;
	const result = await dbi.tryQuery(sql);
	if (result === false) {
		response.setRequestStatus(false);
		return response.response();
	}
	response.addJSON({ message: slowLogSummary(result.fetchAllAssoc()) });
	return response.response();
}

export async function generalLogController(context: PmaContext): Promise<Response> {
	await prepare(context);
	const { dbi, response, request } = context;
	if (!response.isAjax) {
		return response.response();
	}
	const start = phpInt(request.post.time_start);
	const end = phpInt(request.post.time_end);
	let limitTypes = '';
	if (phpBool((request.post.limitTypes ?? null) as ExpressionValue)) {
		limitTypes = 'AND argument REGEXP \'^(INSERT|SELECT|UPDATE|DELETE)\' ';
	}
	const sql = 'SELECT TIME(event_time) as event_time, user_host, thread_id, server_id, argument, count(argument) as \'#\' '
		+ 'FROM `mysql`.`general_log` WHERE command_type=\'Query\' '
		+ `AND event_time > FROM_UNIXTIME(${start}) AND event_time < FROM_UNIXTIME(${end}) `
		+ `${limitTypes}GROUP by event_time, user_host, thread_id, server_id, argument`;
	const result = await dbi.tryQuery(sql);
	if (result === false) {
		response.setRequestStatus(false);
		return response.response();
	}
	const removeVariables = phpBool((request.post.removeVariables ?? null) as ExpressionValue);
	response.addJSON({ message: generalLogSummary(result.fetchAllAssoc(), removeVariables) });
	return response.response();
}

export async function logVarsController(context: PmaContext): Promise<Response> {
	await prepare(context);
	const { dbi, response, request } = context;
	if (!response.isAjax) {
		return response.response();
	}
	return withMysqlDie(context, async () => {
		const name = request.post.varName;
		const value = request.post.varValue;
		if (typeof name === 'string' && typeof value === 'string') {
			let escaped = dbi.escapeString(value);
			if (!isNumeric(escaped)) {
				escaped = `'${escaped}'`;
			}
			if (!/\W/.test(name)) {
				await dbi.query(`SET GLOBAL ${name} = ${escaped}`);
			}
		}
		const variables = await dbi.fetchResult<string | null>('SHOW GLOBAL VARIABLES WHERE Variable_name IN ("general_log","slow_query_log","long_query_time","log_output")', 0, 1);
		response.addJSON({ message: Object.fromEntries(variables) });
		return response.response();
	});
}

export async function queryAnalyzerController(context: PmaContext): Promise<Response> {
	await prepare(context);
	const { dbi, response, request } = context;
	if (!response.isAjax) {
		return response.response();
	}
	return withMysqlDie(context, async () => {
		const database = String(request.post.database ?? '');
		const query = String(request.post.query ?? '');
		const message: Record<string, unknown> = {};
		if (database !== '') {
			await dbi.selectDb(database);
		}
		const profiling = await isProfilingSupported(context);
		if (profiling) {
			await dbi.query('SET PROFILING=1;');
		}
		// SQL_NO_CACHE keeps the query cache from answering.
		const sqlQuery = query.replace(/^(\s*SELECT)/i, '$1 SQL_NO_CACHE');
		await dbi.tryQuery(sqlQuery);
		message.affectedRows = dbi.affectedRows();
		const explain = await dbi.tryQuery(`EXPLAIN ${sqlQuery}`);
		if (explain !== false) {
			message.explain = explain.fetchAllAssoc();
		}
		message.error = dbi.getError();
		if (profiling) {
			message.profiling = [];
			const rows = await dbi.tryQuery('SELECT seq,state,duration FROM INFORMATION_SCHEMA.PROFILING WHERE QUERY_ID=1 ORDER BY seq');
			if (rows !== false) {
				message.profiling = rows.fetchAllAssoc();
			}
		}
		response.addJSON({ message });
		return response.response();
	});
}

export async function advisorController(context: PmaContext): Promise<Response> {
	const data = await loadStatusData(context);
	const { dbi } = context;
	let result: ReturnType<typeof runAdvisor> | [] = [];
	if (data.dataLoaded) {
		const status = await dbi.fetchResult<string | null>('SHOW GLOBAL STATUS', 0, 1);
		const variables = await dbi.fetchResult<string | null>('SHOW GLOBAL VARIABLES', 0, 1);
		// SysInfo has no memory figures without /proc/meminfo.
		const merged = { ...Object.fromEntries(status), ...Object.fromEntries(variables), system_memory: 0 } as Record<string, ExpressionValue>;
		result = runAdvisor({ variables: merged, version: dbi.getVersion(), isMariaDB: dbi.isMariaDB(), url: context.urlState() });
	}
	context.response.addHTML(await renderServerTemplate(context, 'server/status/advisor/index', { data: result }));
	return context.response.response();
}

export const controllers = {
	'Server/Status/MonitorController': monitorController,
	'Server/Status/Monitor/ChartingDataController': chartingDataController,
	'Server/Status/Monitor/SlowLogController': slowLogController,
	'Server/Status/Monitor/GeneralLogController': generalLogController,
	'Server/Status/Monitor/LogVarsController': logVarsController,
	'Server/Status/Monitor/QueryAnalyzerController': queryAnalyzerController,
	'Server/Status/AdvisorController': advisorController,
};

// Ports of Server\Status\StatusController, QueriesController and VariablesController (/server/status, /queries, /variables).
import { selectMysqlForSuperUser } from './info-pages.ts';
import { withMysqlDie } from './mysql-die.ts';
import { renderServerTemplate } from './render.ts';
import { replicationStatusTable } from './replication.ts';
import { loadStatusData } from './status-data.ts';
import { linkToVarDocumentation } from '../../../../lib/pma/server/kbs.ts';
import { phpEmpty, phpInt } from '../../../../lib/pma/server/php.ts';
import {
	connectionsInfo,
	networkTraffic,
	queryStatistics,
	statusAlerts,
	statusVariableRows,
	trafficInfo,
} from '../../../../lib/pma/server/status-pages.ts';
import { localisedDate, timespanFormat } from '../../../../lib/pma/util.ts';
import { generatorState } from '../../core/generator.ts';

import type { PmaContext } from '../../core/context.ts';

const FLUSH_COMMANDS = new Set(['STATUS', 'TABLES', 'QUERY CACHE']);

export async function statusController(context: PmaContext): Promise<Response> {
	const data = await loadStatusData(context);
	await selectMysqlForSuperUser(context);
	const { status, replication } = data;
	const variables: Record<string, unknown> = {
		is_data_loaded: data.dataLoaded,
		network_traffic: null,
		uptime: null,
		start_time: null,
		traffic: [],
		connections: [],
		is_primary: replication.primaryInfo.status,
		is_replica: replication.replicaInfo.status,
		replication: '',
	};
	if (data.dataLoaded) {
		variables.network_traffic = networkTraffic(status);
		if (status.has('Uptime')) {
			variables.uptime = timespanFormat(Number(status.get('Uptime')));
		}
		const startTime = await context.dbi.fetchValue(`SELECT UNIX_TIMESTAMP() - ${status.get('Uptime') ?? ''}`);
		variables.start_time = localisedDate(phpInt(startTime));
		variables.traffic = trafficInfo(status);
		variables.connections = connectionsInfo(status);
		let replicationHtml = '';
		if (replication.primaryInfo.status) {
			replicationHtml += await replicationStatusTable(context, 'primary');
		}
		if (replication.replicaInfo.status) {
			replicationHtml += await replicationStatusTable(context, 'replica');
		}
		variables.replication = replicationHtml;
	}
	context.response.addHTML(await renderServerTemplate(context, 'server/status/status/index', variables));
	return context.response.response();
}

export async function queriesController(context: PmaContext): Promise<Response> {
	const data = await loadStatusData(context);
	await selectMysqlForSuperUser(context);
	context.response.addScriptFiles([
		'chart.js',
		'vendor/jqplot/jquery.jqplot.js',
		'vendor/jqplot/plugins/jqplot.pieRenderer.js',
		'vendor/jqplot/plugins/jqplot.highlighter.js',
		'vendor/jqplot/plugins/jqplot.enhancedPieLegendRenderer.js',
		'vendor/jquery/jquery.tablesorter.js',
		'server/status/sorter.js',
		'server/status/queries.js',
	]);
	let statistics: ReturnType<typeof queryStatistics> | null = null;
	if (data.dataLoaded) {
		statistics = queryStatistics(data.status, data.usedQueries);
	}
	context.response.addHTML(await renderServerTemplate(context, 'server/status/queries/index', {
		is_data_loaded: data.dataLoaded,
		stats: statistics?.stats ?? null,
		queries: statistics?.queries ?? [],
		chart: Object.fromEntries(statistics?.chart ?? []),
	}));
	return context.response.response();
}

export async function statusVariablesController(context: PmaContext): Promise<Response> {
	const data = await loadStatusData(context);
	return withMysqlDie(context, async () => {
		const { dbi, request, response } = context;
		const params = request.post;
		await selectMysqlForSuperUser(context);
		response.addScriptFiles(['server/status/variables.js', 'vendor/jquery/jquery.tablesorter.js', 'server/status/sorter.js']);
		if (typeof params.flush === 'string' && FLUSH_COMMANDS.has(params.flush)) {
			await dbi.query(`FLUSH ${params.flush};`);
		}
		let categories = new Map<string, { id: string; name: string; is_selected: boolean; }>();
		let links = new Map<string, { name: string; links: unknown; }>();
		let variables: ReturnType<typeof statusVariableRows> = [];
		if (data.dataLoaded) {
			categories = new Map(data.sections.filter(([id]) => data.sectionUsed.has(id)).map(([id, name]) => [id, { id, name, is_selected: !phpEmpty(params.filterCategory) && params.filterCategory === id }]));
			links = new Map([...data.links].map(([section, sectionLinks]) => [section, { name: `status_${section}`, links: sectionLinks }]));
			const state = generatorState(context);
			variables = statusVariableRows(data.status, data.allocationMap, data.links, statusAlerts(data.status, data.variables), name => linkToVarDocumentation(state, name, dbi.isMariaDB()));
		}
		let filterText = '';
		if (!phpEmpty(params.filterText)) {
			filterText = String(params.filterText);
		}
		response.addHTML(await renderServerTemplate(context, 'server/status/variables/index', {
			is_data_loaded: data.dataLoaded,
			filter_text: filterText,
			is_only_alerts: !phpEmpty(params.filterAlert),
			is_not_formatted: !phpEmpty(params.dontFormat),
			categories,
			links,
			variables,
		}));
		return response.response();
	});
}

export const controllers = {
	'Server/Status/StatusController': statusController,
	'Server/Status/QueriesController': queriesController,
	'Server/Status/VariablesController': statusVariablesController,
};

// Pure parts of the Server\Status controllers: traffic and connection tables, query statistics and the variables list.
import { phpFloat } from './php.ts';
import data from './server-data.json' with { type: 'json' };
import { isNumeric } from './variables.ts';
import { formatByteDown, formatNumber } from '../util.ts';

import type {
	StatusLink,
	StatusLinks,
	StatusMap,
	StatusValue,
} from './status-data.ts';

const STATUS_DESCRIPTIONS = data.statusDescriptions as Record<string, string>;

const bytes = (value: number): string => (formatByteDown(value, 3, 1) as string[]).join(' ');

const get = (status: StatusMap, key: string): number => phpFloat(status.get(key));

/** StatusController's "Network traffic since startup", or null when the counters are missing. */
export function networkTraffic(status: StatusMap): string | null {
	if (!status.has('Bytes_received') || !status.has('Bytes_sent')) {
		return null;
	}
	return bytes(get(status, 'Bytes_received') + get(status, 'Bytes_sent'));
}

/** StatusController::getTrafficInfo(). */
export function trafficInfo(status: StatusMap): { name: string; number: string; per_hour: string; }[] {
	const hourFactor = 3600 / get(status, 'Uptime');
	const received = get(status, 'Bytes_received');
	const sent = get(status, 'Bytes_sent');
	return [
		{ name: 'Received', number: bytes(received), per_hour: bytes(received * hourFactor) },
		{ name: 'Sent', number: bytes(sent), per_hour: bytes(sent * hourFactor) },
		{ name: 'Total', number: bytes(received + sent), per_hour: bytes((received + sent) * hourFactor) },
	];
}

/** StatusController::getConnectionsInfo(). */
export function connectionsInfo(status: StatusMap): { name: string; number: string; per_hour: string; percentage: string; }[] {
	const hourFactor = 3600 / get(status, 'Uptime');
	const connections = get(status, 'Connections');
	const abortedConnects = get(status, 'Aborted_connects');
	const abortedClients = get(status, 'Aborted_clients');
	let failedAttemptsPercentage = '---';
	let abortedPercentage = '---';
	if (connections > 0) {
		failedAttemptsPercentage = `${formatNumber(abortedConnects * 100 / connections, 0, 2, true)}%`;
		abortedPercentage = `${formatNumber(abortedClients * 100 / connections, 0, 2, true)}%`;
	}
	return [
		{ name: 'Max. concurrent connections', number: formatNumber(get(status, 'Max_used_connections'), 0), per_hour: '---', percentage: '---' },
		{
			name: 'Failed attempts',
			number: formatNumber(abortedConnects, 4, 1, true),
			per_hour: formatNumber(abortedConnects * hourFactor, 4, 2, true),
			percentage: failedAttemptsPercentage,
		},
		{
			name: 'Aborted',
			number: formatNumber(abortedClients, 4, 1, true),
			per_hour: formatNumber(abortedClients * hourFactor, 4, 2, true),
			percentage: abortedPercentage,
		},
		{
			name: 'Total',
			number: formatNumber(connections, 4, 0),
			per_hour: formatNumber(connections * hourFactor, 4, 2),
			percentage: `${formatNumber(100, 0, 2)}%`,
		},
	];
}

export interface QueryStatistics {
	stats: { total: number; per_hour: number; per_minute: number; per_second: number; };
	queries: Map<string, { name: string; value: StatusValue; per_hour: number; percentage: number; }>;
	chart: Map<string, StatusValue>;
}

/** QueriesController: totals, the statements by use (most used first) and the pie chart with small slices grouped. */
export function queryStatistics(status: StatusMap, usedQueries: StatusMap): QueryStatistics {
	const uptime = get(status, 'Uptime');
	const hourFactor = 3600 / uptime;
	let total = 0;
	for (const value of usedQueries.values()) {
		total += phpFloat(value);
	}
	const stats = { total, per_hour: total * hourFactor, per_minute: total * 60 / uptime, per_second: total / uptime };
	const sorted = [...usedQueries].toSorted(([, left], [, right]) => phpFloat(right) - phpFloat(left));
	const chart = new Map<string, StatusValue>();
	const queries: QueryStatistics['queries'] = new Map();
	let otherSum = 0;
	for (const [key, value] of sorted) {
		// Questions minus Connections would include connections, so the shares are of the statements alone.
		const name = key.replaceAll('Com_', '').replaceAll('_', ' ');
		const amount = phpFloat(value);
		// Slices under 2% become "Other" once the chart already has more than six.
		if (amount < total * 0.02 && chart.size > 6) {
			otherSum += amount;
		} else {
			chart.set(name, value);
		}
		queries.set(key, { name, value, per_hour: amount * hourFactor, percentage: amount * 100 / total });
	}
	if (otherSum > 0) {
		chart.set('Other', otherSum);
	}
	return { stats, queries, chart };
}

/** VariablesController::getAlerts(): the value above which a variable is shown in red. */
export function statusAlerts(status: StatusMap, variables: Map<string, string | null>): Map<string, number> {
	const alerts = new Map<string, number>([
		['Aborted_clients', 0],
		['Aborted_connects', 0],
		['Binlog_cache_disk_use', 0],
		['Created_tmp_disk_tables', 0],
		['Handler_read_rnd', 0],
		['Handler_read_rnd_next', 0],
		['Innodb_buffer_pool_pages_dirty', 0],
		['Innodb_buffer_pool_reads', 0],
		['Innodb_buffer_pool_wait_free', 0],
		['Innodb_log_waits', 0],
		['Innodb_row_lock_time_avg', 10],
		['Innodb_row_lock_time_max', 50],
		['Innodb_row_lock_waits', 0],
		['Slow_queries', 0],
		['Delayed_errors', 0],
		['Select_full_join', 0],
		['Select_range_check', 0],
		['Sort_merge_passes', 0],
		['Opened_tables', 0],
		['Table_locks_waited', 0],
		['Qcache_lowmem_prunes', 0],
		['Qcache_free_blocks', status.has('Qcache_total_blocks') ? get(status, 'Qcache_total_blocks') / 5 : 0],
		['Slow_launch_threads', 0],
		['Key_reads', status.has('Key_read_requests') ? 0.01 * get(status, 'Key_read_requests') : 0],
		['Key_writes', status.has('Key_write_requests') ? 0.9 * get(status, 'Key_write_requests') : 0],
		['Key_buffer_fraction', 0.5],
	]);
	const threadCacheSize = variables.get('thread_cache_size');
	alerts.set('Threads_cached', threadCacheSize === undefined || threadCacheSize === null ? 0 : 0.95 * phpFloat(threadCacheSize));
	return alerts;
}

export interface StatusVariableRow {
	name: string;
	value: StatusValue;
	is_numeric: boolean;
	class: string | null;
	doc: string;
	has_alert: boolean;
	is_alert: boolean;
	description: string;
	description_doc: { name: string; url: StatusLink | string; }[];
}

/** Status\VariablesController's rows; `docLink` is Generator::linkToVarDocumentation() for the server flavour. */
export function statusVariableRows(
	status: StatusMap,
	allocationMap: Map<string, string>,
	links: StatusLinks,
	alerts: Map<string, number>,
	docLink: (name: string) => string,
): StatusVariableRow[] {
	return [...status].map(([name, value]) => {
		const alert = alerts.get(name);
		const row: StatusVariableRow = {
			name,
			value,
			is_numeric: isNumeric(value),
			class: allocationMap.get(name) ?? null,
			// Calculated "%" values have no MySQL documentation.
			doc: name.includes('%') ? '' : docLink(name),
			has_alert: alert !== undefined,
			is_alert: alert !== undefined && phpFloat(value) > alert,
			description: STATUS_DESCRIPTIONS[name] ?? '',
			description_doc: [...(links.get(name) ?? [])].map(([linkName, url]) => {
				return { name: linkName, url };
			}),
		};
		return row;
	});
}

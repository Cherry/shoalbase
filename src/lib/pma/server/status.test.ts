import { describe, expect, it } from 'vitest';

import {
	chartVariableNames,
	generalLogSummary,
	slowLogSummary,
	variablesQuery,
} from './monitor.ts';
import {
	formatSql,
	processListQuery,
	processRow,
	sortableColumns,
} from './processes.ts';
import {
	calculateValues,
	cleanDeprecated,
	isLocalHost,
	sortVariables,
	statusLinks,
} from './status-data.ts';
import {
	connectionsInfo,
	networkTraffic,
	queryStatistics,
	statusAlerts,
	statusVariableRows,
	trafficInfo,
} from './status-pages.ts';

const url = { server: 1, serverDefault: 1, lang: 'en', hasLangCookie: true, token: 'token' };

describe('status data', () => {
	it('drops deprecated counters only when their replacement exists', () => {
		const cleaned = cleanDeprecated(new Map([['Com_prepare_sql', '1'], ['Com_stmt_prepare', '2'], ['Com_execute_sql', '3']]));
		expect(cleaned.keys().toArray()).toEqual(['Com_stmt_prepare', 'Com_execute_sql']);
	});

	it('calculates key cache and thread cache ratios', () => {
		const status = new Map([['Key_blocks_unused', '10'], ['Key_writes', '5'], ['Key_write_requests', '10'], ['Key_reads', '1'], ['Key_read_requests', '4'], ['Threads_created', '1'], ['Connections', '4']]);
		const variables = new Map([['key_cache_block_size', '1024'], ['key_buffer_size', '10240']]);
		const result = calculateValues(status, variables);
		expect(result.get('Key_buffer_fraction_%')).toBe(0);
		expect(result.get('Key_write_ratio_%')).toBe(50);
		expect(result.get('Key_read_ratio_%')).toBe(25);
		expect(result.get('Threads_cache_hitrate_%')).toBe(75);
	});

	it('falls back to Key_blocks_used and skips ratios without requests', () => {
		const result = calculateValues(new Map([['Key_blocks_used', '2'], ['Key_write_requests', '0'], ['Connections', '0'], ['Threads_created', '1']]), new Map([['key_buffer_size', '1024']]));
		expect(result.get('Key_buffer_fraction_%')).toBe(2);
		expect(result.has('Key_write_ratio_%')).toBe(false);
		expect(result.has('Threads_cache_hitrate_%')).toBe(false);
		expect(calculateValues(new Map([['Key_blocks_used', '2']]), new Map([['key_buffer_size', '0']])).has('Key_buffer_fraction_%')).toBe(false);
	});

	it('sorts variables into sections and keeps used Com_ counters except admin commands', () => {
		const { allocationMap, sectionUsed, usedQueries } = sortVariables(new Map([['Com_select', '3'], ['Com_insert', '0'], ['Com_admin_commands', '9'], ['Uptime', '5'], ['Innodb_x', '1']]));
		expect(allocationMap.get('Com_select')).toBe('com');
		expect(allocationMap.get('Uptime')).toBe('other');
		expect([...sectionUsed]).toEqual(['com', 'other', 'innodb']);
		expect([...usedQueries]).toEqual([['Com_select', '3']]);
	});

	it('builds the related links, with replication links only for active replication', () => {
		const plain = statusLinks(url, { status: false }, { status: false });
		expect(plain.get('table')?.get('Show open tables')).toEqual({ url: 'index.php?route=/sql', params: 'sql_query=SHOW+OPEN+TABLES&goto=index.php' });
		expect([...(plain.get('repl')?.keys() ?? [])]).toEqual(['doc']);
		const replicating = statusLinks(url, { status: true }, { status: true });
		expect([...(replicating.get('repl')?.keys() ?? [])]).toEqual(['Show replica hosts', 'Show primary status', 'Show replica status', 'doc']);
	});

	it('knows local hosts', () => {
		expect(isLocalHost('LOCALHOST')).toBe(true);
		expect(isLocalHost('::1')).toBe(true);
		expect(isLocalHost('db.example')).toBe(false);
	});
});

describe('status pages', () => {
	const status = new Map<string, string | number>([['Bytes_received', '1048576'], ['Bytes_sent', '1048576'], ['Uptime', '3600'], ['Connections', '10'], ['Aborted_connects', '1'], ['Aborted_clients', '0'], ['Max_used_connections', '3']]);

	it('reports traffic and connections', () => {
		expect(networkTraffic(status)).toBe('2.0 MiB');
		expect(networkTraffic(new Map())).toBeNull();
		expect(trafficInfo(status)[2]).toEqual({ name: 'Total', number: '2.0 MiB', per_hour: '2.0 MiB' });
		const connections = connectionsInfo(status);
		expect(connections[1]).toEqual({ name: 'Failed attempts', number: '1  ', per_hour: '1  ', percentage: '10.00%' });
		expect(connections[3]?.percentage).toBe('100.00%');
		expect(connectionsInfo(new Map([['Uptime', '1'], ['Connections', '0']]))[1]?.percentage).toBe('---');
	});

	it('ranks statements and groups small chart slices', () => {
		const used = new Map<string, string | number>([['Com_a', '1'], ['Com_b', '100'], ['Com_c', '90'], ['Com_d', '80'], ['Com_e', '70'], ['Com_f', '60'], ['Com_g', '50'], ['Com_h', '40'], ['Com_set_option', '1']]);
		const statistics = queryStatistics(new Map([['Uptime', '60']]), used);
		expect(statistics.stats).toEqual({ total: 492, per_hour: 29520, per_minute: 492, per_second: 8.2 });
		expect(statistics.queries.keys().toArray()[0]).toBe('Com_b');
		expect(statistics.queries.get('Com_set_option')?.name).toBe('set option');
		expect(statistics.chart.keys().toArray()).toEqual(['b', 'c', 'd', 'e', 'f', 'g', 'h', 'Other']);
		expect(statistics.chart.get('Other')).toBe(2);
		expect(queryStatistics(new Map([['Uptime', '60']]), new Map([['Com_a', '5']])).chart.has('Other')).toBe(false);
	});

	it('derives alert thresholds from the status and variables', () => {
		const alerts = statusAlerts(new Map([['Qcache_total_blocks', '50'], ['Key_read_requests', '100'], ['Key_write_requests', '10']]), new Map([['thread_cache_size', '20']]));
		expect(alerts.get('Qcache_free_blocks')).toBe(10);
		expect(alerts.get('Key_reads')).toBe(1);
		expect(alerts.get('Key_writes')).toBe(9);
		expect(alerts.get('Threads_cached')).toBe(19);
		const defaults = statusAlerts(new Map(), new Map([['thread_cache_size', null]]));
		expect([defaults.get('Qcache_free_blocks'), defaults.get('Key_reads'), defaults.get('Key_writes'), defaults.get('Threads_cached')]).toEqual([0, 0, 0, 0]);
	});

	it('describes each status variable with its section, alert state and links', () => {
		const links = new Map([['Slow_queries', new Map<string, string | { url: string; params: string; }>([['doc', 'slow_query_log']])]]);
		const rows = statusVariableRows(
			new Map<string, string | number>([['Slow_queries', '3'], ['Key_read_ratio_%', 12.5], ['Ssl_cipher', '']]),
			new Map([['Slow_queries', 'query']]),
			links,
			new Map([['Slow_queries', 0]]),
			name => `doc:${name}`,
		);
		expect(rows[0]).toMatchObject({ name: 'Slow_queries', is_numeric: true, class: 'query', doc: 'doc:Slow_queries', has_alert: true, is_alert: true, description_doc: [{ name: 'doc', url: 'slow_query_log' }] });
		expect(rows[0]?.description).toContain('long_query_time');
		expect(rows[1]).toMatchObject({ doc: '', has_alert: false, is_alert: false, class: null });
		expect(rows[2]).toMatchObject({ is_numeric: false, description: '' });
	});
});

describe('processes', () => {
	it('uses SHOW PROCESSLIST unless filtering or sorting', () => {
		expect(processListQuery({})).toEqual({ sql: 'SHOW PROCESSLIST', useIS: false, showFullSql: false, refreshParams: { full: 1 } });
		expect(processListQuery({ full: '1' }).sql).toBe('SHOW FULL PROCESSLIST');
		const sorted = processListQuery({ showExecuting: 'on', order_by_field: 'Time', sort_order: 'DESC' });
		expect(sorted.sql).toBe('SELECT * FROM `INFORMATION_SCHEMA`.`PROCESSLIST`  WHERE state != ""  ORDER BY `Time` DESC');
		expect(sorted.refreshParams).toEqual({ full: 1, order_by_field: 'Time', sort_order: 'DESC', showExecuting: 'on' });
		expect(processListQuery({ order_by_field: 'Id', sort_order: 'ASC' }).refreshParams).toEqual({ full: 1, order_by_field: 'Id', sort_order: 'ASC', showExecuting: null });
		expect(processListQuery({ showExecuting: 'on' }).refreshParams).toEqual({ full: 1, order_by_field: null, sort_order: null, showExecuting: 'on' });
	});

	it('normalises row keys and formats the query', () => {
		const row = processRow({ ID: '5', USER: 'u', HOST: 'h', DB: null, COMMAND: 'Query', TIME: '0', STATE: '', INFO: 'SELECT "<x>"' }, true, false, 100);
		expect(row).toEqual({ id: '5', user: 'u', host: 'h', db: '', command: 'Query', time: '0', state: '---', progress: '---', info: '<code class="sql" dir="ltr"><pre>\nSELECT &quot;&lt;x&gt;&quot;\n</pre></code>' });
		expect(processRow({ Id: '1', Info: null, State: 'x', Db: 'd' }, false, false, 100)).toMatchObject({ info: '---', state: 'x', db: 'd', progress: '---' });
		expect(processRow({}, false, false, 1)).toMatchObject({ id: null, user: null, command: null });
	});

	it('computes MariaDB stage progress from information_schema', () => {
		expect(processRow({ PROGRESS: '50.000', STAGE: '2', MAX_STAGE: '4' }, true, false, 100).progress).toBe('37.500');
		expect(processRow({ PROGRESS: '50.000', STAGE: '1', MAX_STAGE: '1' }, true, false, 100).progress).toBe('50.000');
		expect(processRow({ PROGRESS: '50.000' }, true, false, 100).progress).toBe('50.000');
		expect(processRow({ PROGRESS: '50.000' }, false, false, 100).progress).toBe('50.000');
	});

	it('truncates long queries unless full queries are shown', () => {
		expect(formatSql('abcdef', true, 3)).toBe('<code class="sql" dir="ltr"><pre>\nabc[...]\n</pre></code>');
		expect(formatSql('abcdef', false, 3)).toContain('abcdef');
	});

	it('lists sortable columns with the full query toggle on the last one', () => {
		const columns = sortableColumns(true, { order_by_field: 'Id', sort_order: 'ASC', showExecuting: '' }, true);
		expect(columns.map(column => column.name)).toEqual(['ID', 'User', 'Host', 'Database', 'Command', 'Time', 'Status', 'Progress', 'SQL query']);
		expect(columns[0]).toMatchObject({ is_sorted: true, sort_order: 'DESC', params: { showExecuting: 'on' } });
		expect(columns[8]).toMatchObject({ has_full_query: true, is_full: true });
		const plain = sortableColumns(false, {}, false);
		expect(plain).toHaveLength(8);
		expect(plain[7]).toMatchObject({ has_full_query: true, is_full: false, is_sorted: false, sort_order: 'ASC' });
		expect(plain[0]?.params).not.toHaveProperty('showExecuting');
	});
});

describe('monitor', () => {
	it('collects the valid variable names a chart asks for', () => {
		const names = chartVariableNames({ 0: { 0: { 0: { type: 'statusvar', name: 'Questions' }, 1: { type: 'statusvar', name: 'bad-name' } } }, 1: { 0: { 0: { type: 'servervar', name: 'max_connections' }, 1: { type: 'proc' } } } });
		expect(names).toEqual({ serverVars: ['max_connections'], statusVars: ['Questions'] });
		expect(variablesQuery('STATUS', ['a', 'b'])).toBe('SHOW GLOBAL STATUS WHERE Variable_name=\'a\' OR Variable_name=\'b\'');
	});

	it('sums slow log statements by type and shortens big inserts', () => {
		const long = `INSERT ${'x'.repeat(300)}`;
		const summary = slowLogSummary([{ 'sql_text': 'SELECT 1', '#': '2' }, { 'sql_text': long, '#': '1' }, { 'sql_text': null, '#': null }]);
		expect(summary.sum).toEqual({ 'select': 2, 'insert': 1, '': 0, 'TOTAL': 3 });
		expect(summary.rows[1]?.sql_text).toBe(`${long.slice(0, 200)}... [0.30 KiB]`);
		expect(summary.numRows).toBe(3);
	});

	it('groups repeated inserts into one table when asked', () => {
		const rows: Record<string, string | null>[] = [
			{ 'argument': 'INSERT INTO `t` VALUES (1)', '#': '1' },
			{ 'argument': 'INSERT INTO `t` VALUES (2)', '#': '1' },
			{ 'argument': 'INSERT INTO `t` VALUES (3).', '#': '1' },
			{ 'argument': `UPDATE t SET a = '${'y'.repeat(300)}'`, '#': '1' },
			{ 'argument': 'SELECT 1', '#': '1' },
			{ argument: 'SELECT 2' },
			{ 'argument': null, '#': '1' },
		];
		const grouped = generalLogSummary(rows, true);
		expect(grouped.rows[0]).toEqual({ 'argument': 'INSERT INTO `t` VALUES (1)<br>...', '#': 3 });
		expect(grouped.rows[1]?.argument).toMatch(/^UPDATE t SET a = 'y+\.\.\. \[0\.31 KiB\]$/);
		expect(grouped.sum).toEqual({ 'insert': 3, 'update': 1, 'select': 1, '': 1, 'TOTAL': 6 });
		expect(generalLogSummary(rows, false).rows).toHaveLength(7);
		const dotted = generalLogSummary([{ 'argument': 'INSERT INTO x VALUES (1).', '#': '1' }, { 'argument': 'INSERT INTO x VALUES (2)', '#': '1' }], true);
		expect(dotted.rows[0]).toEqual({ 'argument': 'INSERT INTO x VALUES (1).', '#': 2 });
		expect(generalLogSummary([{ 'argument': 'INSERT 1', '#': '1' }], true).rows).toHaveLength(1);
	});
});

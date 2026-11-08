// Pure parts of PhpMyAdmin\Server\Status\Data: sections, links, calculated values and the variable to section map.
import { phpFloat } from './php.ts';
import { type UrlState, getCommon, getFromRoute } from '../../twig/url.ts';

import type { ReplicationSideInfo } from './replication-info.ts';

export type StatusValue = string | number;
export type StatusMap = Map<string, StatusValue>;

/** A link of Data::$links: a target URL with POST parameters, or a documentation page name under the 'doc' key. */
export interface StatusLink {
	url: string;
	params: string;
}
export type StatusLinks = Map<string, Map<string, StatusLink | string>>;

// Variable name prefix => section; names match when they contain the prefix.
const ALLOCATIONS: [string, string][] = [
	['Com_', 'com'],
	['Innodb_', 'innodb'],
	['Ndb_', 'ndb'],
	['Handler_', 'handler'],
	['Qcache_', 'qcache'],
	['Threads_', 'threads'],
	['Slow_launch_threads', 'threads'],
	['Binlog_cache_', 'binlog_cache'],
	['Created_tmp_', 'created_tmp'],
	['Key_', 'key'],
	['Delayed_', 'delayed'],
	['Not_flushed_delayed_rows', 'delayed'],
	['Flush_commands', 'query'],
	['Last_query_cost', 'query'],
	['Slow_queries', 'query'],
	['Queries', 'query'],
	['Prepared_stmt_count', 'query'],
	['Select_', 'select'],
	['Sort_', 'sort'],
	['Open_tables', 'table'],
	['Opened_tables', 'table'],
	['Open_table_definitions', 'table'],
	['Opened_table_definitions', 'table'],
	['Table_locks_', 'table'],
	['Rpl_status', 'repl'],
	['Slave_', 'repl'],
	['Tc_', 'tc'],
	['Ssl_', 'ssl'],
	['Open_files', 'files'],
	['Open_streams', 'files'],
	['Opened_files', 'files'],
];

/** Data::getSections(): section id => title. */
export const STATUS_SECTIONS: [string, string][] = [
	['com', 'Com'],
	['query', 'SQL query'],
	['innodb', 'InnoDB'],
	['ndb', 'NDB'],
	['handler', 'Handler'],
	['qcache', 'Query cache'],
	['threads', 'Threads'],
	['binlog_cache', 'Binary log'],
	['created_tmp', 'Temporary data'],
	['delayed', 'Delayed inserts'],
	['key', 'Key cache'],
	['select', 'Joins'],
	['repl', 'Replication'],
	['sort', 'Sorting'],
	['table', 'Tables'],
	['tc', 'Transaction coordinator'],
	['files', 'Files'],
	['ssl', 'SSL'],
	['other', 'Other'],
];

/** Data::getLinks(); selfUrl is basename($PMA_PHP_SELF), "index.php". */
export function statusLinks(url: UrlState, primary: ReplicationSideInfo, replica: ReplicationSideInfo, selfUrl = 'index.php'): StatusLinks {
	const sqlUrl = getFromRoute(url, '/sql');
	const links: StatusLinks = new Map();
	const section = (name: string): Map<string, StatusLink | string> => {
		let entry = links.get(name);
		if (entry === undefined) {
			entry = new Map();
			links.set(name, entry);
		}
		return entry;
	};
	section('table').set('Flush (close) all tables', { url: selfUrl, params: getCommon(url, { flush: 'TABLES' }, '') });
	section('table').set('Show open tables', { url: sqlUrl, params: getCommon(url, { sql_query: 'SHOW OPEN TABLES', goto: selfUrl }, '') });
	if (primary.status) {
		section('repl').set('Show replica hosts', { url: sqlUrl, params: getCommon(url, { sql_query: 'SHOW SLAVE HOSTS', goto: selfUrl }, '') });
		section('repl').set('Show primary status', { url: '#replication_primary', params: '' });
	}
	if (replica.status) {
		section('repl').set('Show replica status', { url: '#replication_replica', params: '' });
	}
	section('repl').set('doc', 'replication');
	section('qcache').set('Flush query cache', { url: selfUrl, params: getCommon(url, { flush: 'QUERY CACHE' }, '') });
	section('qcache').set('doc', 'query_cache');
	section('threads').set('doc', 'mysql_threads');
	section('key').set('doc', 'myisam_key_cache');
	section('binlog_cache').set('doc', 'binary_log');
	section('Slow_queries').set('doc', 'slow_query_log');
	section('innodb').set('Variables', { url: getFromRoute(url, '/server/engines/InnoDB'), params: '' });
	section('innodb').set('InnoDB Status', { url: getFromRoute(url, '/server/engines/InnoDB/Status'), params: '' });
	section('innodb').set('doc', 'innodb');
	return links;
}

/** Data::cleanDeprecated(): drops old Com_*_sql counters when their replacement exists. */
export function cleanDeprecated(status: StatusMap): StatusMap {
	const deprecated: [string, string][] = [
		['Com_prepare_sql', 'Com_stmt_prepare'],
		['Com_execute_sql', 'Com_stmt_execute'],
		['Com_dealloc_sql', 'Com_stmt_close'],
	];
	const cleaned = new Map(status);
	for (const [old, replacement] of deprecated) {
		if (cleaned.has(old) && cleaned.has(replacement)) {
			cleaned.delete(old);
		}
	}
	return cleaned;
}

const num = (map: Map<string, StatusValue | null>, key: string): number => phpFloat(map.get(key));

/** Data::calculateValues(): adds the "_%" ratios. */
export function calculateValues(status: StatusMap, variables: Map<string, string | null>): StatusMap {
	const result = new Map(status);
	const has = (map: Map<string, unknown>, key: string): boolean => map.get(key) !== undefined && map.get(key) !== null;
	if (has(status, 'Key_blocks_unused') && has(variables, 'key_cache_block_size') && has(variables, 'key_buffer_size') && num(variables, 'key_buffer_size') !== 0) {
		result.set('Key_buffer_fraction_%', 100 - num(status, 'Key_blocks_unused') * num(variables, 'key_cache_block_size') / num(variables, 'key_buffer_size') * 100);
	} else if (has(status, 'Key_blocks_used') && has(variables, 'key_buffer_size') && num(variables, 'key_buffer_size') !== 0) {
		result.set('Key_buffer_fraction_%', num(status, 'Key_blocks_used') * 1024 / num(variables, 'key_buffer_size'));
	}
	if (has(status, 'Key_writes') && has(status, 'Key_write_requests') && num(status, 'Key_write_requests') > 0) {
		result.set('Key_write_ratio_%', 100 * num(status, 'Key_writes') / num(status, 'Key_write_requests'));
	}
	if (has(status, 'Key_reads') && has(status, 'Key_read_requests') && num(status, 'Key_read_requests') > 0) {
		result.set('Key_read_ratio_%', 100 * num(status, 'Key_reads') / num(status, 'Key_read_requests'));
	}
	if (has(status, 'Threads_created') && has(status, 'Connections') && num(status, 'Connections') > 0) {
		result.set('Threads_cache_hitrate_%', 100 - num(status, 'Threads_created') / num(status, 'Connections') * 100);
	}
	return result;
}

/** Data::sortVariables(): each variable's section, the sections in use and the non-zero Com_ counters. */
export function sortVariables(status: StatusMap): { allocationMap: Map<string, string>; sectionUsed: Set<string>; usedQueries: StatusMap; } {
	const allocationMap = new Map<string, string>();
	const sectionUsed = new Set<string>();
	const usedQueries: StatusMap = new Map();
	for (const [name, value] of status) {
		const allocation = ALLOCATIONS.find(([filter]) => name.includes(filter));
		if (allocation === undefined) {
			allocationMap.set(name, 'other');
			sectionUsed.add('other');
			continue;
		}
		const [, section] = allocation;
		allocationMap.set(name, section);
		sectionUsed.add(section);
		if (section === 'com' && phpFloat(value) > 0) {
			usedQueries.set(name, value);
		}
	}
	// Admin commands such as COM_PING are not counted in Questions.
	usedQueries.delete('Com_admin_commands');
	return { allocationMap, sectionUsed, usedQueries };
}

/** Data::$dbIsLocal. */
export function isLocalHost(host: string): boolean {
	return host.toLowerCase() === 'localhost' || host === '127.0.0.1' || host === '::1';
}

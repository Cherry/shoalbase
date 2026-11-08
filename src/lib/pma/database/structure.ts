// Pure parts of Controllers\Database\StructureController and Util::getDbInfo().
import type { ReplicationSideInfo } from '../server/replication-info.ts';

// Util::getDbInfo()'s request sort keys and the table status columns they sort by.
const SORTABLE_COLUMNS: Record<string, string> = {
	table: 'Name',
	records: 'Rows',
	type: 'Engine',
	collation: 'Collation',
	size: 'Data_length',
	overhead: 'Data_free',
	creation: 'Create_time',
	last_update: 'Update_time',
	last_check: 'Check_time',
	comment: 'Comment',
};

/** Util::getDbInfo(): the getTablesFull() sort column and order for the request's sort and sort_order. */
export function tableListSort(sort: unknown, sortOrder: unknown): { sortBy: string; sortOrder: 'ASC' | 'DESC'; } {
	if (typeof sort === 'string' && Object.hasOwn(SORTABLE_COLUMNS, sort)) {
		return { sortBy: SORTABLE_COLUMNS[sort], sortOrder: sortOrder === 'DESC' ? 'DESC' : 'ASC' };
	}
	return { sortBy: 'Name', sortOrder: 'ASC' };
}

/** How StructureController::getStuffForEngineTypeTable() reads sizes for an engine. */
export type EngineKind = 'aria' | 'innodb' | 'csv' | 'merge' | 'view' | 'mroonga' | 'unknown';

/** The switch of getStuffForEngineTypeTable(); a null ENGINE is a view or a table that needs repairing. */
export function engineKind(engine: string | null | undefined): EngineKind {
	switch (engine ?? null) {
		case 'MyISAM':
		case 'ISAM':
		case 'HEAP':
		case 'MEMORY':
		case 'ARCHIVE':
		case 'Aria':
		case 'Maria': {
			return 'aria';
		}
		case 'InnoDB':
		case 'PBMS':
		case 'TokuDB':
		case 'ROCKSDB': {
			return 'innodb';
		}
		case 'CSV': {
			return 'csv';
		}
		case 'MRG_MyISAM':
		case 'MRG_MYISAM':
		case 'MERGE':
		case 'BerkeleyDB': {
			return 'merge';
		}
		case null:
		case '':
		case 'SYSTEM VIEW': {
			return 'view';
		}
		case 'Mroonga': {
			return 'mroonga';
		}
		default: {
			return 'unknown';
		}
	}
}

/** PHP's loose `$a >= $b` for a row count that countRecords() may have turned into false. */
function looseAtLeast(rows: number | false, minimum: number): boolean {
	// false >= $n compares booleans, so it only holds when $n is 0.
	if (rows === false) {
		return minimum === 0;
	}
	return rows >= minimum;
}

export interface RowCountInput {
	tableRows: number | string | false | null | undefined;
	engine: string | null | undefined;
	counted: boolean;
	isView: boolean;
	maxExactCountViews: number;
}

/** StructureController::isRowCountApproximated(): whether the count is approximate and whether the view hint goes after it. */
export function rowCountApproximation(input: RowCountInput): { approxRows: boolean; viewHint: boolean; } {
	const { tableRows, engine, counted, isView, maxExactCountViews } = input;
	if (tableRows === undefined || tableRows === null || ([null, undefined, ''].includes(engine) && !isView)) {
		return { approxRows: false, viewHint: false };
	}
	let approxRows = !isView && ['CSV', 'InnoDB', 'TokuDB'].includes(String(engine)) && !counted;
	let viewHint = false;
	if (isView && looseAtLeast(tableRows === false ? false : Number(tableRows), maxExactCountViews)) {
		approxRows = true;
		viewHint = true;
	}
	return { approxRows, viewHint };
}

/** Replication::extractDbOrTable(). */
function extractDbOrTable(value: string, what: 'db' | 'table'): string {
	const parts = value.split('.');
	if (what === 'db') {
		return parts[0];
	}
	return parts[1] ?? '';
}

function escapeRegExp(value: string): string {
	return value.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`);
}

/** StructureController::hasTable(): a wildcard replication rule (db.prefix%) that matches the table. */
function matchesWildcard(rules: string[], db: string, table: string): boolean {
	return rules.some((rule) => {
		const prefix = [...extractDbOrTable(rule, 'table')].slice(0, -1).join('');
		return db === extractDbOrTable(rule, 'db') && new RegExp(`^${escapeRegExp(prefix)}`, 'u').test(table);
	});
}

/**
 * StructureController::getReplicationStatus(). Upstream's array_search() checks only accept string keys, which a list
 * never has, so only the wildcard rules and the "no filters at all" case decide.
 */
export function replicationStatus(info: ReplicationSideInfo, db: string, table: string): { do: boolean; ignored: boolean; } {
	if (!info.status) {
		return { do: false, ignored: false };
	}
	const ignored = matchesWildcard(info.Wild_Ignore_Table ?? [], db, table);
	let replicated = false;
	if (!ignored) {
		const noFilters = (info.Do_DB ?? []).length === 0 && (info.Ignore_DB ?? []).length === 0;
		replicated = noFilters || matchesWildcard(info.Wild_Do_Table ?? [], db, table);
	}
	return { do: replicated, ignored };
}

/** The earliest of the table timestamps seen so far, compared as strings like upstream. */
export function earliestTime(current: string, candidate: string | null | undefined): string {
	if (candidate && (!current || candidate < current)) {
		return candidate;
	}
	return current;
}

/** PHP's strtotime() for a MySQL DATETIME, in UTC like the oracle container. */
export function mysqlDateToTimestamp(value: string): number {
	return Math.floor(Date.parse(`${value.replace(' ', 'T')}Z`) / 1000);
}

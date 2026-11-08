// Pure parts of Controllers\Server\DatabasesController and its create/destroy siblings.

const SORT_BY_ALLOW_LIST = new Set([
	'SCHEMA_NAME',
	'DEFAULT_COLLATION_NAME',
	'SCHEMA_TABLES',
	'SCHEMA_TABLE_ROWS',
	'SCHEMA_DATA_LENGTH',
	'SCHEMA_INDEX_LENGTH',
	'SCHEMA_LENGTH',
	'SCHEMA_DATA_FREE',
]);

export interface StatisticColumn {
	title: string;
	format: 'number' | 'byte';
	raw: number;
}

/** DatabasesController::setSortDetails(). */
export function sortDetails(sortBy: unknown, sortOrder: unknown): { sortBy: string; sortOrder: 'asc' | 'desc'; } {
	let by = 'SCHEMA_NAME';
	if (typeof sortBy === 'string' && SORT_BY_ALLOW_LIST.has(sortBy)) {
		by = sortBy;
	}
	let order: 'asc' | 'desc' = 'asc';
	if (typeof sortOrder === 'string' && sortOrder.toLowerCase() === 'desc') {
		order = 'desc';
	}
	return { sortBy: by, sortOrder: order };
}

/** DatabasesController::getStatisticsColumns(). */
export function statisticsColumns(): Record<string, StatisticColumn> {
	return {
		SCHEMA_TABLES: { title: 'Tables', format: 'number', raw: 0 },
		SCHEMA_TABLE_ROWS: { title: 'Rows', format: 'number', raw: 0 },
		SCHEMA_DATA_LENGTH: { title: 'Data', format: 'byte', raw: 0 },
		SCHEMA_INDEX_LENGTH: { title: 'Indexes', format: 'byte', raw: 0 },
		SCHEMA_LENGTH: { title: 'Total', format: 'byte', raw: 0 },
		SCHEMA_DATA_FREE: { title: 'Overhead', format: 'byte', raw: 0 },
	};
}

/** Util::getCharsetQueryPart(). */
export function charsetQueryPart(collation: string, override = false): string {
	const [charset = ''] = collation.split('_', 1);
	let keyword = ' CHARSET=';
	if (override) {
		keyword = ' CHARACTER SET ';
	}
	if (charset === collation) {
		return keyword + charset;
	}
	return `${keyword}${charset} COLLATE ${collation}`;
}

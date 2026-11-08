// Pure parts of PhpMyAdmin\Sql: which analysed queries get a LIMIT, a remembered sort or a quick row count.
import { formatNumber } from '../util.ts';

import type { AnalyzedQuery, SelectStatement } from '../../../sql-parser/index.ts';
import type { FieldMetadata } from '../field-metadata.ts';

/** Sql::isRememberSortingOrder(). */
export function isRememberSortingOrder(analyzed: AnalyzedQuery, rememberSorting: boolean): boolean {
	const selectExpr = analyzed.select_expr;
	const selectTables = analyzed.select_tables;
	if (selectExpr === undefined || selectTables === undefined || !rememberSorting) {
		return false;
	}
	if (analyzed.is_count || analyzed.is_export || analyzed.is_func || analyzed.is_analyse || !analyzed.select_from) {
		return false;
	}
	const starOnly = selectExpr.length === 0 || (selectExpr.length === 1 && selectExpr[0] === '*');
	return starOnly && selectTables.length === 1;
}

/** Sql::isAppendLimitClause(): only valid SELECT-like queries without their own LIMIT, unless all rows are shown. */
export function isAppendLimitClause(analyzed: AnalyzedQuery, maxRows: number | string | undefined): boolean {
	if (analyzed.parser === undefined || analyzed.parser.errors.length > 0 || maxRows === 'all') {
		return false;
	}
	if (analyzed.is_export || analyzed.is_analyse) {
		return false;
	}
	return (analyzed.select_from || analyzed.is_subquery) && !analyzed.limit;
}

/** Sql::isJustBrowsing(): a plain browse of one table, which can use the quick row count. */
export function isJustBrowsing(analyzed: AnalyzedQuery, findRealEnd: boolean | null): boolean {
	if (analyzed.is_group || analyzed.is_func || analyzed.union || analyzed.distinct || !analyzed.select_from) {
		return false;
	}
	if ((analyzed.select_tables ?? []).length !== 1) {
		return false;
	}
	const where = (analyzed.statement as SelectStatement | undefined)?.where ?? [];
	const whereIsTrivial = where.length === 0 || (where.length === 1 && where[0].expr === '1');
	return whereIsTrivial && !analyzed.group && findRealEnd === null && !analyzed.is_subquery && !analyzed.join && !analyzed.having;
}

/** Sql::hasNoRightsToDropDatabase(). */
export function hasNoRightsToDropDatabase(analyzed: AnalyzedQuery, allowUserDropDatabase: boolean, isSuperUser: boolean): boolean {
	return !allowUserDropDatabase && analyzed.drop_database && !isSuperUser;
}

/** Sql::resultSetHasJustOneTable(). */
export function resultSetHasJustOneTable(fieldsMeta: FieldMetadata[]): boolean {
	let justOneTable = true;
	let prevTable = '';
	for (const meta of fieldsMeta) {
		if (meta.table !== '' && prevTable !== '' && meta.table !== prevTable) {
			justOneTable = false;
		}
		if (meta.table !== '') {
			prevTable = meta.table;
		}
	}
	return justOneTable && prevTable !== '';
}

/** Sql::getStartPosToDisplayRow(): the start of the last page holding row `numberOfLine`. */
export function startPosToDisplayRow(numberOfLine: number, maxRows: number | 'all'): number {
	const rows = Number(maxRows);
	const page = Math.ceil(numberOfLine / rows);
	if (!Number.isFinite(page)) {
		return 0;
	}
	return (page - 1) * rows;
}

/** A first duration stays SHOW PROFILE's string, while a repeated state sums to a float, as in PHP. */
export interface ProfilingState {
	total_time: number | string;
	calls: number;
}

export interface ProfilingStats {
	total_time: number;
	states: Map<string, ProfilingState>;
	chart: Map<string, number | string>;
	profile: { status: string; duration: string; duration_raw: string; }[];
}

/** PHP's ucwords() with its default delimiters. */
function ucwords(value: string): string {
	return value.replaceAll(/(^|[ \t\r\n\f\v])([a-z])/g, (_match, space: string, letter: string) => space + letter.toUpperCase());
}

/** Sql::getDetailedProfilingStats() over SHOW PROFILE rows. */
export function detailedProfilingStats(rows: { Status: string | null; Duration: string | null; }[]): ProfilingStats {
	const stats: ProfilingStats = { total_time: 0, states: new Map(), chart: new Map(), profile: [] };
	for (const row of rows) {
		const status = ucwords(row.Status ?? '');
		const raw = row.Duration ?? '0';
		const duration = Number(raw);
		stats.total_time += duration;
		stats.profile.push({ status, duration: formatNumber(duration, 3, 1), duration_raw: raw });
		const state = stats.states.get(status);
		if (state === undefined) {
			stats.states.set(status, { total_time: raw, calls: 1 });
			stats.chart.set(status, raw);
		} else {
			state.calls++;
			state.total_time = Number(state.total_time) + duration;
			stats.chart.set(status, Number(stats.chart.get(status)) + duration);
		}
	}
	return stats;
}

/**
 * Util::parseEnumSetValues($definition, false): str_getcsv() over the quoted list in "enum('a','b')", which keeps
 * backslash escapes, then unescapes doubled backslashes.
 */
export function parseEnumSetValues(definition: string): string[] {
	const inner = /\((.*)\)/s.exec(definition)?.[1] ?? '';
	const values: string[] = [];
	let index = 0;
	do {
		let value = '';
		if (inner[index] === '\'') {
			index++;
			while (index < inner.length) {
				const character = inner[index];
				if (character === '\\' && index + 1 < inner.length) {
					value += character + inner[index + 1];
					index += 2;
				} else if (character === '\'' && inner[index + 1] === '\'') {
					value += '\'';
					index += 2;
				} else if (character === '\'') {
					index++;
					break;
				} else {
					value += character;
					index++;
				}
			}
		}
		while (index < inner.length && inner[index] !== ',') {
			value += inner[index];
			index++;
		}
		values.push(value.replaceAll('\\\\', '\\'));
		index++;
	} while (index <= inner.length);
	return values;
}

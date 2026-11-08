// Pure parts of PhpMyAdmin\Server\Status\Processes: the process list query, its rows and its sortable columns.
import { phpEmpty, phpInt } from './php.ts';
import { backquote } from '../../twig/sanitize.ts';
import { numberFormat } from '../util.ts';

type Params = Record<string, unknown>;
type Row = Record<string, string | null>;

export interface ProcessListQuery {
	sql: string;
	useIS: boolean;
	showFullSql: boolean;
	refreshParams: Record<string, unknown>;
}

/** Processes::getList()'s query and the refresh link parameters. */
export function processListQuery(params: Params): ProcessListQuery {
	const showFullSql = !phpEmpty(params.full);
	const refreshParams: Record<string, unknown> = { full: showFullSql ? '' : 1 };
	let sql = showFullSql ? 'SHOW FULL PROCESSLIST' : 'SHOW PROCESSLIST';
	const sorted = !phpEmpty(params.order_by_field) && !phpEmpty(params.sort_order);
	const useIS = !phpEmpty(params.showExecuting) || sorted;
	if (useIS) {
		refreshParams.order_by_field = params.order_by_field ?? null;
		refreshParams.sort_order = params.sort_order ?? null;
		refreshParams.showExecuting = params.showExecuting ?? null;
		sql = 'SELECT * FROM `INFORMATION_SCHEMA`.`PROCESSLIST` ';
	}
	if (!phpEmpty(params.showExecuting)) {
		sql += ' WHERE state != "" ';
	}
	if (sorted) {
		sql += ` ORDER BY ${backquote(String(params.order_by_field))} ${String(params.sort_order)}`;
	}
	return { sql, useIS, showFullSql, refreshParams };
}

/** ucfirst(mb_strtolower($key)) for every column, as information_schema spells them in capitals. */
function normalizeKeys(row: Row): Row {
	return Object.fromEntries(Object.entries(row).map(([key, value]) => [key.charAt(0).toUpperCase() + key.slice(1).toLowerCase(), value]));
}

/** Generator::formatSql(), truncated to MaxCharactersInDisplayedSQL when asked. */
export function formatSql(sql: string, truncate: boolean, maxCharacters: number): string {
	let query = sql;
	const characters = [...sql];
	if (truncate && characters.length > maxCharacters) {
		query = `${characters.slice(0, maxCharacters).join('')}[...]`;
	}
	const escaped = query.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;');
	return `<code class="sql" dir="ltr"><pre>\n${escaped}\n</pre></code>`;
}

/** One process row as the list template shows it. */
export function processRow(raw: Row, useIS: boolean, showFullSql: boolean, maxCharacters: number): Record<string, string | null> {
	const process = normalizeKeys(raw);
	let progress = phpEmpty(process.Progress) ? '---' : process.Progress as string;
	if (useIS && !phpEmpty(process.Progress)) {
		const stage = 'Stage' in process ? phpInt(process.Stage) : null;
		const maxStage = 'Max_stage' in process ? phpInt(process.Max_stage) : null;
		if (stage !== null && maxStage !== null && maxStage > 1) {
			progress = numberFormat((stage - 1) / maxStage * 100 + Number.parseFloat(process.Progress as string) / maxStage, 3);
		}
	}
	let info = '---';
	if (!phpEmpty(process.Info)) {
		info = formatSql(process.Info as string, !showFullSql, maxCharacters);
	}
	return {
		id: process.Id ?? null,
		user: process.User ?? null,
		host: process.Host ?? null,
		db: process.Db ?? '',
		command: process.Command ?? null,
		time: process.Time ?? null,
		state: phpEmpty(process.State) ? '---' : process.State as string,
		progress,
		info,
	};
}

/** Processes::getSortableColumnsForProcessList(). */
export function sortableColumns(showFullSql: boolean, params: Params, isMariaDB: boolean): Record<string, unknown>[] {
	const columns: [string, string][] = [
		['ID', 'Id'],
		['User', 'User'],
		['Host', 'Host'],
		['Database', 'Db'],
		['Command', 'Command'],
		['Time', 'Time'],
		['Status', 'State'],
	];
	if (isMariaDB) {
		columns.push(['Progress', 'Progress']);
	}
	columns.push(['SQL query', 'Info']);
	return columns.map(([name, field], index) => {
		// Loose == between the posted field and the column name.
		const isSorted = !phpEmpty(params.order_by_field) && !phpEmpty(params.sort_order) && String(params.order_by_field) === field;
		const columnParams: Record<string, unknown> = { column_name: name, order_by_field: field, sort_order: 'ASC' };
		if (isSorted && params.sort_order === 'ASC') {
			columnParams.sort_order = 'DESC';
		}
		if (params.showExecuting !== undefined && params.showExecuting !== null) {
			columnParams.showExecuting = 'on';
		}
		const isLast = index === columns.length - 1;
		return {
			name,
			params: columnParams,
			is_sorted: isSorted,
			sort_order: columnParams.sort_order,
			has_full_query: isLast,
			is_full: isLast && showFullSql,
		};
	});
}

// Pure parts of PhpMyAdmin\Server\Status\Monitor: chart data requests and the slow/general log summaries.
import { isNumericString } from '../php-compare.ts';
import { formatByteDown } from '../util.ts';

type Row = Record<string, string | null>;
type OutputRow = Record<string, string | number | null>;

export interface ChartPoint {
	type?: unknown;
	name?: unknown;
	[key: string]: unknown;
}

export type ChartRequest = Record<string, Record<string, Record<string, ChartPoint>>>;

/** The server and status variable names a chart request asks for; names with other characters are ignored. */
export function chartVariableNames(request: ChartRequest): { serverVars: string[]; statusVars: string[]; } {
	const serverVars: string[] = [];
	const statusVars: string[] = [];
	for (const nodes of Object.values(request)) {
		for (const points of Object.values(nodes)) {
			for (const point of Object.values(points)) {
				const name = String(point.name ?? '');
				if (/[^a-z_]/i.test(name)) {
					continue;
				}
				if (point.type === 'servervar') {
					serverVars.push(name);
				} else if (point.type === 'statusvar') {
					statusVars.push(name);
				}
			}
		}
	}
	return { serverVars, statusVars };
}

/** SHOW GLOBAL STATUS/VARIABLES WHERE ... for the requested names. */
export function variablesQuery(kind: 'STATUS' | 'VARIABLES', names: string[]): string {
	return `SHOW GLOBAL ${kind} WHERE Variable_name='${names.join('\' OR Variable_name=\'')}'`;
}

// PHP reads "\1" inside the character class as the control character U+0001, not as a backreference.
// eslint-disable-next-line regexp/no-empty-alternative -- kept identical to upstream's pattern so backtracking matches PHP.
const INSERT_TABLE = new RegExp(String.raw`^INSERT INTO ([\x60'"]|)([^\s${String.fromCodePoint(1)}]+)\1`, 'i');

/** Cuts long INSERT and UPDATE statements to 200 characters followed by their size. */
function shorten(text: string): string {
	const characters = [...text];
	if (characters.length <= 220) {
		return text;
	}
	return `${characters.slice(0, 200).join('')}... [${(formatByteDown(characters.length, 2, 2) as string[]).join(' ')}]`;
}

/** PHP's += of a "#" column: numeric strings add as numbers. */
function add(sum: number, value: string | null | undefined): number {
	if (isNumericString(String(value))) {
		return sum + Number(value);
	}
	return sum;
}

export interface LogSummary {
	rows: OutputRow[];
	sum: Record<string, number>;
	numRows: number;
}

/** Monitor::getJsonForLogDataTypeSlow() for the fetched rows. */
export function slowLogSummary(rows: Row[]): LogSummary {
	const sum: Record<string, number> = {};
	const result: OutputRow[] = [];
	for (const source of rows) {
		const row: OutputRow = { ...source };
		const text = source.sql_text ?? '';
		const space = text.indexOf(' ');
		const type = text.slice(0, Math.max(space, 0)).toLowerCase();
		if (type === 'insert' || type === 'update') {
			row.sql_text = shorten(text);
		}
		sum[type] = add(sum[type] ?? 0, source['#']);
		result.push(row);
	}
	sum.TOTAL = Object.values(sum).reduce((total, value) => total + value, 0);
	return { rows: result, sum, numRows: result.length };
}

/** Monitor::getJsonForLogDataTypeGeneral() for the fetched rows. */
export function generalLogSummary(rows: Row[], removeVariables: boolean): LogSummary {
	const sum: Record<string, number> = {};
	const result: OutputRow[] = [];
	const insertTables = new Map<string, number>();
	let insertTablesFirst = -1;
	for (const source of rows) {
		const row: OutputRow = { ...source };
		const argument = source.argument ?? '';
		const type = (/^(\w+)\s/.exec(argument)?.[1] ?? '').toLowerCase();
		sum[type] = add(sum[type] ?? 0, source['#']);
		if (type === 'insert' && removeVariables) {
			const table = INSERT_TABLE.exec(argument)?.[2];
			if (table !== undefined) {
				const count = (insertTables.get(table) ?? 0) + 1;
				insertTables.set(table, count);
				const first = result[insertTablesFirst];
				if (count > 1 && first !== undefined) {
					first['#'] = count;
					// Marks the grouped statement as standing for several queries.
					const previous = String(first.argument);
					if (!previous.endsWith('.')) {
						first.argument = `${previous}<br>...`;
					}
					continue;
				}
				insertTablesFirst = result.length;
				insertTables.set(table, count + Number(source['#']) - 1);
			}
		}
		if (type === 'insert' || type === 'update') {
			row.argument = shorten(argument);
		}
		result.push(row);
	}
	sum.TOTAL = Object.values(sum).reduce((total, value) => total + value, 0);
	return { rows: result, sum, numRows: result.length };
}

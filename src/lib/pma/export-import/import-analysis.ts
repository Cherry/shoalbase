// The column type guessing of PhpMyAdmin\Import, which CSV, ODS, XML and MediaWiki imports use to create new tables.
import { isNumericString } from '../php-compare.ts';

export const NONE = 0;
export const VARCHAR = 1;
export const INT = 2;
export const DECIMAL = 3;
export const BIGINT = 4;
export const GEOMETRY = 5;

export type ColumnType = typeof NONE | typeof VARCHAR | typeof INT | typeof DECIMAL | typeof BIGINT | typeof GEOMETRY;
/** A column size: a length, or "M,D" for a decimal. */
export type ColumnSize = number | string;

/** One table the import builds: [TBL_NAME, COL_NAMES, ROWS]. */
export interface ImportTable {
	name: string;
	columns: string[];
	rows: (string | null)[][];
}

export interface TableAnalysis {
	types: ColumnType[];
	sizes: ColumnSize[];
	/** FORMATTEDSQL: cells already written as SQL, such as the Shapefile plugin's GeomFromText(). */
	formattedSql?: boolean[];
}

const INT64_MAX = (1n << 63n) - 1n;
const INT64_MIN = -(1n << 63n);

/** (int) of a numeric string: integer strings saturate, the others go through float, where out of range gives 0. */
export function phpIntval(value: string): bigint {
	const trimmed = value.trim();
	if (/^[+-]?\d+$/.test(trimmed)) {
		const parsed = BigInt(trimmed);
		if (parsed > INT64_MAX) {
			return INT64_MAX;
		}
		if (parsed < INT64_MIN) {
			return INT64_MIN;
		}
		return parsed;
	}
	const float = Number(trimmed);
	if (!Number.isFinite(float) || Math.abs(float) >= 2 ** 63) {
		return 0n;
	}
	return BigInt(Math.trunc(float));
}

/** (float) of a string: its leading number, or 0. */
export function phpFloatval(value: string): number {
	const match = /^[\t\n\v\f\r ]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.exec(value);
	return match === null ? 0 : Number(match[0].trim());
}

/** (string) of a float, which PHP prints with 14 significant digits. */
export function phpFloatString(value: number): string {
	if (Number.isNaN(value)) {
		return 'NAN';
	}
	if (!Number.isFinite(value)) {
		return value > 0 ? 'INF' : '-INF';
	}
	if (value === 0) {
		return Object.is(value, -0) ? '-0' : '0';
	}
	const [mantissa, exponentText] = value.toExponential(13).split('e', 2);
	const exponent = Number(exponentText);
	if (exponent < -4 || exponent >= 14) {
		let digits = mantissa.replace(/\.?0+$/, '');
		if (!digits.includes('.')) {
			digits += '.0';
		}
		return `${digits}E${exponent < 0 ? '-' : '+'}${Math.abs(exponent)}`;
	}
	return String(Number(value.toPrecision(14)));
}

// mb_strlen().
const length = (value: string): number => [...value].length;

/** Import::getColumnAlphaName(): 1 is A, 27 is AA. */
export function getColumnAlphaName(num: number): string {
	let name = '';
	let rest = num;
	if (rest > 26) {
		let div = Math.trunc(rest / 26);
		const remain = rest % 26;
		if (remain === 0) {
			div--;
		}
		name = getColumnAlphaName(div);
		rest = remain;
	}
	if (rest === 0) {
		return `${name}Z`;
	}
	return name + String.fromCodePoint(64 + rest);
}

/** Import::getColumnNumberFromName(): A is 1, AA is 27. */
export function getColumnNumberFromName(name: string): number {
	if (name === '' || name === '0') {
		return 0;
	}
	const upper = name.toUpperCase();
	let number = 0;
	for (let index = 0; index < upper.length; index++) {
		number += ((upper.codePointAt(upper.length - 1 - index) as number) - 64) * (26 ** index);
	}
	return number;
}

/** Import::getDecimalPrecision(): M of "M,D". */
export function getDecimalPrecision(size: ColumnSize): number {
	const text = String(size);
	return Number.parseInt(text.slice(0, Math.max(text.indexOf(','), 0)), 10) || 0;
}

/** Import::getDecimalScale(): D of "M,D". */
export function getDecimalScale(size: ColumnSize): number {
	const text = String(size);
	// Without a comma strpos() is false, so PHP starts reading at offset 1.
	const comma = text.indexOf(',');
	return Number.parseInt(text.slice(comma === -1 ? 1 : comma + 1), 10) || 0;
}

/** Import::getDecimalSize(): [M, D, "M,D"] of a decimal cell. */
export function getDecimalSize(cell: string): [number, number, string] {
	const size = length(cell);
	const scale = size - 1 - [...cell].indexOf('.');
	return [size - 1, scale, `${size - 1},${scale}`];
}

// PHP's loose >= between a new length and a stored size, which is a number here except for "M,D" decimals.
const atLeast = (size: number, last: ColumnSize): boolean => size >= (typeof last === 'number' ? last : Number.parseFloat(last));

/** Import::detectSize(). */
export function detectSize(lastSize: ColumnSize, lastType: ColumnType | null, currentType: ColumnType, cell: string): ColumnSize {
	const size = length(cell);
	if (cell === 'NULL') {
		return lastSize;
	}
	const lastIsInt = lastType === BIGINT || lastType === INT;
	const lastIsNone = lastType === null || lastType === NONE;
	if (currentType === VARCHAR) {
		if (lastType === VARCHAR || lastIsInt) {
			return atLeast(size, lastSize) ? size : lastSize;
		}
		if (lastType === DECIMAL) {
			const oldM = getDecimalPrecision(lastSize);
			return Math.max(size, oldM);
		}
		if (lastIsNone) {
			return size;
		}
		return -1;
	}
	if (currentType === DECIMAL) {
		const [precision, scale, full] = getDecimalSize(cell);
		if (lastType === VARCHAR) {
			return atLeast(precision, lastSize) ? precision : lastSize;
		}
		if (lastType === DECIMAL) {
			const oldM = getDecimalPrecision(lastSize);
			const oldD = getDecimalScale(lastSize);
			if (precision > oldM || scale > oldD) {
				return `${Math.max(precision, oldM)},${Math.max(scale, oldD)}`;
			}
			return lastSize;
		}
		if (lastIsInt) {
			return atLeast(precision, lastSize) ? full : `${lastSize},${scale}`;
		}
		if (lastIsNone) {
			return full;
		}
		return -1;
	}
	if (currentType === BIGINT || currentType === INT) {
		if (lastType === VARCHAR || lastIsInt) {
			return atLeast(size, lastSize) ? size : lastSize;
		}
		if (lastType === DECIMAL) {
			const oldM = getDecimalPrecision(lastSize);
			const oldD = getDecimalScale(lastSize);
			if (oldM - oldD >= size) {
				return lastSize;
			}
			return `${size + oldD},${oldD}`;
		}
		if (lastIsNone) {
			return size;
		}
	}
	return -1;
}

/** Import::detectType(). */
export function detectType(lastType: ColumnType | null, cell: string | null): ColumnType {
	if (cell === 'NULL') {
		if (lastType === null || lastType === NONE) {
			return NONE;
		}
		return lastType;
	}
	const text = cell ?? '';
	if (!isNumericString(text)) {
		return VARCHAR;
	}
	// $cell == (string) (float) $cell only fails when the float overflows to INF.
	if (Number.isFinite(Number(text.trim())) && text.split('.').length === 2) {
		return DECIMAL;
	}
	const integer = phpIntval(text);
	if (integer > 2_147_483_647n || integer < -2_147_483_647n) {
		return BIGINT;
	}
	if (text !== integer.toString()) {
		return VARCHAR;
	}
	return INT;
}

/** Import::analyzeTable(): the type and size of every column. */
export function analyzeTable(table: ImportTable): TableAnalysis {
	const types: ColumnType[] = table.columns.map(() => NONE);
	const sizes: ColumnSize[] = table.columns.map(() => 0);
	for (const [column] of table.columns.entries()) {
		for (const row of table.rows) {
			const cell = row[column] ?? null;
			const current = detectType(types[column], cell);
			sizes[column] = detectSize(sizes[column], types[column], current, cell ?? '');
			if (current === VARCHAR) {
				types[column] = VARCHAR;
			} else if (current === DECIMAL) {
				if (types[column] !== VARCHAR) {
					types[column] = DECIMAL;
				}
			} else if (current === BIGINT) {
				if (types[column] !== VARCHAR && types[column] !== DECIMAL) {
					types[column] = BIGINT;
				}
			} else if (current === INT && types[column] !== VARCHAR && types[column] !== DECIMAL && types[column] !== BIGINT) {
				types[column] = INT;
			}
		}
	}
	for (const [column, type] of types.entries()) {
		if (type !== NONE) {
			continue;
		}

		types[column] = VARCHAR;
		sizes[column] = '10';
	}
	return { types, sizes };
}

const TYPE_NAMES: Record<ColumnType, string> = { [NONE]: 'NULL', [VARCHAR]: 'varchar', [INT]: 'int', [DECIMAL]: 'decimal', [BIGINT]: 'bigint', [GEOMETRY]: 'geometry' };

/** The CREATE TABLE statement Import::buildSql() writes for an analysed table. */
export function createTableSql(dbName: string, table: ImportTable, analysis: TableAnalysis, backquote: (name: string) => string): string {
	const columns = table.columns.map((name, index) => {
		let size = analysis.sizes[index];
		if (Math.trunc(Number.parseFloat(String(size))) === 0 || Number.isNaN(Number.parseFloat(String(size)))) {
			size = 10;
		}
		let definition = `${backquote(name)} ${TYPE_NAMES[analysis.types[index]]}`;
		if (analysis.types[index] !== GEOMETRY) {
			definition += `(${size})`;
		}
		return definition;
	});
	return `CREATE TABLE IF NOT EXISTS ${backquote(dbName)}.${backquote(table.name)} (${columns.join(', ')});`;
}

/** The INSERT statement Import::buildSql() writes for a table's rows, or null when it has none. */
export function insertSql(dbName: string, table: ImportTable, analysis: TableAnalysis | null, backquote: (name: string) => string, escape: (value: string) => string): string | null {
	if (table.rows.length === 0) {
		return null;
	}
	const rows = table.rows.map((row) => {
		const cells = table.columns.map((_, index) => {
			const cell = row[index] ?? '';
			if (analysis?.formattedSql?.[index]) {
				return cell;
			}
			let quoted = analysis === null ? !isNumericString(cell) : analysis.types[index] === VARCHAR;
			if (cell === 'NULL') {
				quoted = false;
			}
			return quoted ? `'${escape(cell)}'` : escape(cell);
		});
		return `(${cells.join(', ')})`;
	});
	return `INSERT INTO ${backquote(dbName)}.${backquote(table.name)} (${table.columns.map(name => backquote(name)).join(', ')}) VALUES ${rows.join(',\n ')};`;
}

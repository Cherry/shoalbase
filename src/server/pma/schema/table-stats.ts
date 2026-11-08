// Ports of Plugins\Schema\ExportRelationSchema, TableStats and RelationStats: the tables, coordinates and relations every schema exporter draws.
import { phpFixed } from '../../../lib/pma/pdf/tcpdf.ts';
import {
	type PhpArray,
	type PhpValue,
	phpEntries,
	phpScalar,
} from '../../../lib/pma/table-data/php-params.ts';
import { phpString } from '../../../lib/twig/php.ts';
import { backquote } from '../../../lib/twig/sanitize.ts';
import { getDisplayField, getForeigners } from '../controllers/table-data/relation.ts';
import { getIndexesFromTable } from '../core/index.ts';

import type { PmaContext } from '../core/context.ts';

/** ExportRelationSchema::dieSchema() is due: the named table does not exist. */
export class MissingTableError extends Error {
	constructor(readonly table: string) {
		super(`The ${table} table doesn't exist!`);
	}
}

/** PHP's rawurldecode(): %XX escapes only, decoded as UTF-8 bytes. */
export function rawurldecode(value: string): string {
	if (!value.includes('%')) {
		return value;
	}
	const bytes: number[] = [];
	const encoded = new TextEncoder().encode(value);
	for (let index = 0; index < encoded.length; index++) {
		const hex = String.fromCodePoint(encoded[index + 1] ?? 0, encoded[index + 2] ?? 0);
		if (encoded[index] === 0x25 && /^[\da-f]{2}$/i.test(hex)) {
			bytes.push(Number.parseInt(hex, 16));
			index += 2;
		} else {
			bytes.push(encoded[index]);
		}
	}
	return new TextDecoder().decode(new Uint8Array(bytes));
}

/** PHP's (float) cast of a posted value. */
export function phpFloat(value: PhpValue | undefined): number {
	const match = /^[\t\n\v\f\r ]*[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?/i.exec(phpScalar(value) ?? '');
	return match === null ? 0 : Number(match[0]);
}

/** ExportRelationSchema::getTablesFromRequest(). */
export function getTablesFromRequest(post: PhpArray): string[] {
	const tables = post.t_tbl;
	if (tables === undefined || typeof tables === 'string') {
		return [];
	}
	return phpEntries(tables).map(([, table]) => rawurldecode(phpString(phpScalar(table))));
}

export interface TableStats {
	tableName: string;
	fields: string[];
	primary: string[];
	displayfield: string | false;
	x: number;
	y: number;
	width: number;
	heightCell: number;
	height: number;
	tableDimension: boolean;
}

function getKey(value: PhpValue | undefined, key: string): PhpValue | undefined {
	if (value === undefined || typeof value === 'string') {
		return undefined;
	}
	return value[key];
}

/** TableStats::__construct(): validateTableAndLoadFields(), loadCoordinates(), loadDisplayField() and loadPrimaryKey(). */
export async function loadTableStats(context: PmaContext, post: PhpArray, db: string, tableName: string, showKeys: boolean, tableDimension: boolean): Promise<TableStats> {
	const { dbi } = context;
	const result = await dbi.tryQuery(`DESCRIBE ${backquote(tableName)}`);
	if (result === false || result.numRows() === 0) {
		throw new MissingTableError(tableName);
	}
	let fields: string[];
	if (showKeys) {
		const columns = new Set<string>();
		const indexes = await getIndexesFromTable(context, tableName, db);
		for (const index of indexes.values()) {
			for (const column of index.getColumns().keys()) {
				columns.add(column);
			}
		}
		fields = [...columns];
	} else {
		fields = result.fetchAllColumn().map(value => phpString(value));
	}

	let x = 0;
	let y = 0;
	const heights = post.t_h;
	if (heights !== undefined && typeof heights !== 'string') {
		for (const [key] of phpEntries(heights)) {
			const tableDb = rawurldecode(phpString(phpScalar(getKey(post.t_db, key))));
			const table = rawurldecode(phpString(phpScalar(getKey(post.t_tbl, key))));
			if (`${db}.${tableName}` === `${tableDb}.${table}`) {
				x = phpFloat(getKey(post.t_x, key));
				y = phpFloat(getKey(post.t_y, key));
				break;
			}
		}
	}

	const displayfield = await getDisplayField(context, db, tableName);
	const primary: string[] = [];
	const indexResult = await dbi.query(`SHOW INDEX FROM ${backquote(tableName)};`);
	const indexRows = indexResult.fetchAllAssoc();
	for (const row of indexRows) {
		if (row.Key_name === 'PRIMARY') {
			primary.push(phpString(row.Column_name));
		}
	}
	return { tableName, fields, primary, displayfield, x, y, width: 0, heightCell: 0, height: 0, tableDimension };
}

/** TableStats::getTitle(). */
export function tableTitle(table: TableStats): string {
	let dimension = '';
	if (table.tableDimension) {
		// sprintf('%.0fx%0.f'): the second conversion has an empty precision, which PHP reads as the default of 6.
		dimension = `${phpFixed(table.width, 0)}x${phpFixed(table.heightCell, 6)}`;
	}
	return `${dimension} ${table.tableName}`;
}

/** The relation loops of every *RelationSchema constructor: each foreign key column whose table is also exported. */
export async function forEachRelation(
	context: PmaContext,
	db: string,
	tables: string[],
	add: (masterTable: string, masterField: string, foreignTable: string, foreignField: string) => Promise<void>,
): Promise<boolean> {
	let seenRelation = false;
	for (const table of tables) {
		const foreigners = await getForeigners(context, db, table, 'both');
		if (Object.keys(foreigners).length === 0) {
			continue;
		}
		seenRelation = true;
		for (const key of foreigners.foreign_keys_data ?? []) {
			const refTable = phpString(key.ref_table_name);
			if (!tables.includes(refTable)) {
				continue;
			}
			for (const [index, field] of key.index_list.entries()) {
				await add(table, phpString(field), refTable, phpString(key.ref_index_list?.[index]));
			}
		}
	}
	return seenRelation;
}

/** The array_search() position of a column, false when missing. */
export function fieldPosition(table: TableStats, column: string): number | false {
	const position = table.fields.indexOf(column);
	return position === -1 ? false : position;
}

export interface RelationStats {
	xSrc: number;
	ySrc: number;
	srcDir: number;
	xDest: number;
	yDest: number;
	destDir: number;
	wTick: number;
}

/** RelationStats::__construct(): picks the closest sides of the two tables. */
export function relationStats(master: TableStats, masterField: string, foreign: TableStats, foreignField: string, wTick: number): RelationStats {
	const getXy = (table: TableStats, column: string): [number, number, number] => {
		const position = Number(fieldPosition(table, column));
		return [table.x, table.x + table.width, table.y + ((position + 1.5) * table.heightCell)];
	};
	const source = getXy(master, masterField);
	const destination = getXy(foreign, foreignField);
	const srcLeft = source[0] - wTick;
	const srcRight = source[1] + wTick;
	const destLeft = destination[0] - wTick;
	const destRight = destination[1] + wTick;
	const d1 = Math.abs(srcLeft - destLeft);
	const d2 = Math.abs(srcRight - destLeft);
	const d3 = Math.abs(srcLeft - destRight);
	const d4 = Math.abs(srcRight - destRight);
	const shortest = Math.min(d1, d2, d3, d4);
	let sides: [number, number, number, number];
	if (shortest === d1) {
		sides = [source[0], -1, destination[0], -1];
	} else if (shortest === d2) {
		sides = [source[1], 1, destination[0], -1];
	} else if (shortest === d3) {
		sides = [source[0], -1, destination[1], 1];
	} else {
		sides = [source[1], 1, destination[1], 1];
	}
	return { xSrc: sides[0], srcDir: sides[1], xDest: sides[2], destDir: sides[3], ySrc: source[2], yDest: destination[2], wTick };
}

/** The four relation arrows' end points shared by the SVG, EPS and PDF exporters, as [x1, y1, x2, y2, isTick]. */
export function relationLines(relation: RelationStats): [number, number, number, number, boolean][] {
	const { xSrc, ySrc, srcDir, xDest, yDest, destDir, wTick } = relation;
	const root2 = 2 * Math.sqrt(2);
	return [
		[xSrc, ySrc, xSrc + (srcDir * wTick), ySrc, false],
		[xDest + (destDir * wTick), yDest, xDest, yDest, false],
		[xSrc + (srcDir * wTick), ySrc, xDest + (destDir * wTick), yDest, false],
		[xSrc + (srcDir * wTick * 0.75), ySrc, xSrc + (srcDir * (0.75 - (1 / root2)) * wTick), ySrc + (wTick / root2), true],
		[xSrc + (srcDir * wTick * 0.75), ySrc, xSrc + (srcDir * (0.75 - (1 / root2)) * wTick), ySrc - (wTick / root2), true],
		[xDest + (destDir * wTick / 2), yDest, xDest + (destDir * (0.5 + (1 / root2)) * wTick), yDest + (wTick / root2), true],
		[xDest + (destDir * wTick / 2), yDest, xDest + (destDir * (0.5 + (1 / root2)) * wTick), yDest - (wTick / root2), true],
	];
}

/** shuffle($colors) then $colors[0]. */
export function randomColor(colors: string[]): string {
	return colors[Math.floor(Math.random() * colors.length)];
}

// Port of Plugins\Schema\Eps\Eps, EpsRelationSchema, TableStatsEps and RelationStatsEps.
import { getStringWidth } from './font.ts';
import {
	type TableStats,
	forEachRelation,
	getTablesFromRequest,
	loadTableStats,
	relationLines,
	relationStats,
	tableTitle,
} from './table-stats.ts';
import { phpString } from '../../../lib/twig/php.ts';

import type { SchemaRequest } from './request.ts';

const FONT = 'Verdana';
const FONT_SIZE = 10;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** date('j F Y, g:i a'). */
function creationDate(now: Date): string {
	const hours = now.getUTCHours();
	const hour12 = hours % 12 === 0 ? 12 : hours % 12;
	const minutes = String(now.getUTCMinutes()).padStart(2, '0');
	return `${now.getUTCDate()} ${MONTHS[now.getUTCMonth()]} ${now.getUTCFullYear()}, ${hour12}:${minutes} ${hours < 12 ? 'am' : 'pm'}`;
}

/** Eps::rect(). */
function rect(x: number, y: number, width: number, height: number): string {
	return `1 setlinewidth  \nnewpath \n${phpString(x)} ${phpString(y)} moveto \n0 ${phpString(height)} rlineto \n${phpString(width)} 0 rlineto \n0 -${phpString(height)} rlineto \nclosepath \nstroke \n`;
}

/** Eps::showXY(). */
function showXY(text: string, x: number, y: number): string {
	return `${phpString(x)} ${phpString(y)} moveto \n(${text}) show \n`;
}

/** EpsRelationSchema::__construct(): the whole document. */
export async function epsSchema(request: SchemaRequest, now: Date): Promise<string> {
	const { context, post, db, has } = request;
	const showKeys = has('eps_show_keys');
	const tableDimension = has('eps_show_table_dimension');
	const sameWide = has('eps_all_tables_same_width');
	const orientation = request.string('eps_orientation') === 'P' ? 'Portrait' : 'Landscape';

	let output = '%!PS-Adobe-3.0 EPSF-3.0 \n';
	output += `%%Title: Schema of the ${db} database - Page ${request.pageNumber}\n`;
	output += '%%Creator: phpMyAdmin 5.2.3\n';
	output += `%%CreationDate: ${creationDate(now)}\n`;
	output += '%%PageOrder: Ascend \n';
	output += `%%Orientation: ${orientation}\n`;
	output += '%%EndComments \n%%Pages 1 \n%%BoundingBox: 72 150 144 170 \n';
	output += `/${FONT} findfont   % Get the basic font\n`;
	output += `${FONT_SIZE} scalefont            % Scale the font to ${FONT_SIZE} points\n`;
	output += 'setfont                 % Make it the current font\n';

	let tableWidth = 0;
	const tables = new Map<string, TableStats>();
	const allTables = getTablesFromRequest(post);
	for (const name of allTables) {
		let stats = tables.get(name);
		if (stats === undefined) {
			stats = await loadTableStats(context, post, db, name, showKeys, tableDimension);
			stats.heightCell = FONT_SIZE + 4;
			stats.height = (stats.fields.length + 1) * stats.heightCell;
			for (const field of stats.fields) {
				stats.width = Math.max(stats.width, getStringWidth(field, FONT, FONT_SIZE));
			}
			stats.width += getStringWidth(' '.repeat(6), FONT, FONT_SIZE);
			while (stats.width < getStringWidth(tableTitle(stats), FONT, FONT_SIZE)) {
				stats.width += 7;
			}
			if (tableWidth < stats.width) {
				tableWidth = stats.width;
			}
			tables.set(name, stats);
		}
		if (sameWide) {
			stats.width = tableWidth;
		}
	}

	const relations: ReturnType<typeof relationStats>[] = [];
	const seenRelation = await forEachRelation(context, db, allTables, async (masterTable, masterField, foreignTable, foreignField) => {
		const relation = relationStats(tables.get(masterTable) as TableStats, masterField, tables.get(foreignTable) as TableStats, foreignField, 10);
		relation.ySrc += 10;
		relation.yDest += 10;
		relations.push(relation);
	});
	if (seenRelation) {
		for (const relation of relations) {
			for (const [x1, y1, x2, y2] of relationLines(relation)) {
				output += `1 setlinewidth  \n${phpString(x1)} ${phpString(y1)} moveto \n${phpString(x2)} ${phpString(y2)} lineto \nstroke \n`;
			}
		}
	}

	for (const stats of tables.values()) {
		output += rect(stats.x, stats.y + 12, stats.width, stats.heightCell);
		output += showXY(tableTitle(stats), stats.x + 5, stats.y + 14);
		let currentCell = 0;
		for (const field of stats.fields) {
			currentCell += stats.heightCell;
			output += rect(stats.x, stats.y + 12 + currentCell, stats.width, stats.heightCell);
			output += showXY(field, stats.x + 5, stats.y + 14 + currentCell);
		}
	}
	return `${output}showpage \n`;
}

// Port of Plugins\Schema\Svg\SvgRelationSchema, TableStatsSvg and RelationStatsSvg.
import { getStringWidth } from './font.ts';
import {
	type TableStats,
	forEachRelation,
	getTablesFromRequest,
	loadTableStats,
	randomColor,
	relationLines,
	relationStats,
	tableTitle,
} from './table-stats.ts';
import { XmlWriter } from './xml-writer.ts';
import { phpString } from '../../../lib/twig/php.ts';

import type { SchemaRequest } from './request.ts';

const FONT = 'Arial';
const FONT_SIZE = 16;

interface SvgTable {
	stats: TableStats;
	/** `$table->width = &$this->tablewidth`: the width follows the shared maximum from then on. */
	sharesWidth: boolean;
}

/** Svg::printElement(): a rect (no text) or a text element. */
function printElement(svg: XmlWriter, name: string, x: number, y: number, width: number, height: number, text: string | null, styles: string): void {
	svg.startElement(name);
	svg.writeAttribute('width', phpString(width));
	svg.writeAttribute('height', phpString(height));
	svg.writeAttribute('x', phpString(x));
	svg.writeAttribute('y', phpString(y));
	svg.writeAttribute('style', styles);
	if (text !== null) {
		svg.writeAttribute('font-family', FONT);
		svg.writeAttribute('font-size', `${FONT_SIZE}px`);
		svg.text(text);
	}
	svg.endElement();
}

/** Svg::printElementLine(). */
function printLine(svg: XmlWriter, x1: number, y1: number, x2: number, y2: number, styles: string): void {
	svg.startElement('line');
	svg.writeAttribute('x1', phpString(x1));
	svg.writeAttribute('y1', phpString(y1));
	svg.writeAttribute('x2', phpString(x2));
	svg.writeAttribute('y2', phpString(y2));
	svg.writeAttribute('style', styles);
	svg.endElement();
}

/** SvgRelationSchema::__construct(): the whole document. */
export async function svgSchema(request: SchemaRequest): Promise<string> {
	const { context, post, db, has } = request;
	const showColor = has('svg_show_color');
	const showKeys = has('svg_show_keys');
	const tableDimension = has('svg_show_table_dimension');
	const sameWide = has('svg_all_tables_same_width');

	const svg = new XmlWriter();
	svg.startDocument();
	// The DTD system id must stay byte-identical to upstream's.
	// eslint-disable-next-line unicorn/prefer-https
	svg.writeDtd('svg', '-//W3C//DTD SVG 1.1//EN', 'http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd');

	let tableWidth = 0;
	const tables = new Map<string, SvgTable>();
	const widthOf = (table: SvgTable): number => (table.sharesWidth ? tableWidth : table.stats.width);
	let xMax = 0;
	let yMax = 0;
	let xMin = 100000;
	let yMin = 100000;
	const allTables = getTablesFromRequest(post);
	for (const name of allTables) {
		let table = tables.get(name);
		if (table === undefined) {
			const stats = await loadTableStats(context, post, db, name, showKeys, tableDimension);
			stats.heightCell = FONT_SIZE + 4;
			stats.height = (stats.fields.length + 1) * stats.heightCell;
			for (const field of stats.fields) {
				stats.width = Math.max(stats.width, getStringWidth(field, FONT, FONT_SIZE));
			}
			stats.width += getStringWidth('  ', FONT, FONT_SIZE);
			while (stats.width < getStringWidth(tableTitle(stats), FONT, FONT_SIZE)) {
				stats.width += 7;
			}
			if (tableWidth < stats.width) {
				tableWidth = stats.width;
			}
			table = { stats, sharesWidth: false };
			tables.set(name, table);
		}
		if (sameWide) {
			table.sharesWidth = true;
		}
		xMax = Math.max(xMax, table.stats.x + widthOf(table));
		yMax = Math.max(yMax, table.stats.y + table.stats.height);
		xMin = Math.min(xMin, table.stats.x);
		yMin = Math.min(yMin, table.stats.y);
	}
	// Bound widths are read through the shared value from here on.
	for (const table of tables.values()) {
		table.stats.width = widthOf(table);
	}

	const border = 15;
	const width = Math.trunc(xMax + border);
	const height = Math.trunc(yMax + border);
	const x = xMin - border;
	const y = yMin - border;
	svg.startElement('svg');
	if (x !== 0 || y !== 0) {
		svg.writeAttribute('viewBox', `${Math.trunc(x)} ${Math.trunc(y)} ${width} ${height}`);
	}
	svg.writeAttribute('width', `${phpString(width - x)}px`);
	svg.writeAttribute('height', `${phpString(height - y)}px`);
	svg.writeAttribute('xmlns', 'http://www.w3.org/2000/svg');
	svg.writeAttribute('version', '1.1');

	const relations: ReturnType<typeof relationStats>[] = [];
	const seenRelation = await forEachRelation(context, db, allTables, async (masterTable, masterField, foreignTable, foreignField) => {
		const master = tables.get(masterTable) as SvgTable;
		const foreign = tables.get(foreignTable) as SvgTable;
		relations.push(relationStats(master.stats, masterField, foreign.stats, foreignField, 10));
	});
	if (seenRelation) {
		for (const relation of relations) {
			const color = showColor ? randomColor(['#c00', '#bbb', '#333', '#cb0', '#0b0', '#0bf', '#b0b']) : '#333';
			for (const [x1, y1, x2, y2, tick] of relationLines(relation)) {
				printLine(svg, x1, y1, x2, y2, `stroke:${color};stroke-width:${tick ? 2 : 1};`);
			}
		}
	}

	for (const { stats } of tables.values()) {
		printElement(svg, 'rect', stats.x, stats.y, stats.width, stats.heightCell, null, 'fill:#007;stroke:black;');
		printElement(svg, 'text', stats.x + 5, stats.y + 14, stats.width, stats.heightCell, tableTitle(stats), 'fill:#fff;');
		let currentCell = 0;
		for (const field of stats.fields) {
			currentCell += stats.heightCell;
			let fillColor = 'none';
			if (showColor && stats.primary.includes(field) && field !== stats.displayfield) {
				fillColor = '#aea';
			}
			printElement(svg, 'rect', stats.x, stats.y + currentCell, stats.width, stats.heightCell, null, `fill:${fillColor};stroke:black;`);
			printElement(svg, 'text', stats.x + 5, stats.y + 14 + currentCell, stats.width, stats.heightCell, field, 'fill:black;');
		}
	}
	svg.endDocument();
	return svg.flush();
}

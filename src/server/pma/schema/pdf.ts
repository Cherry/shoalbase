// Port of Plugins\Schema\Pdf\Pdf, PdfRelationSchema, TableStatsPdf and RelationStatsPdf on the TCPDF stand-in.
import {
	type TableStats,
	forEachRelation,
	getTablesFromRequest,
	loadTableStats,
	relationLines,
	relationStats,
} from './table-stats.ts';
import { mysqlStrtotime } from '../../../lib/pma/export-import/strtotime.ts';
import { listedWidth } from '../../../lib/pma/pdf/fonts.ts';
import { type Orientation, phpFixed } from '../../../lib/pma/pdf/tcpdf.ts';
import { phpCompareStrings } from '../../../lib/pma/php-compare.ts';
import { searchColumnInForeigners } from '../../../lib/pma/table-data/relation.ts';
import { extractColumnSpec } from '../../../lib/pma/table-structure/column-spec.ts';
import { localisedDate } from '../../../lib/pma/util.ts';
import { phpString } from '../../../lib/twig/php.ts';
import { getComments, getForeigners } from '../controllers/table-data/relation.ts';
import { Table } from '../core/table.ts';
import { PmaPdf } from '../pdf/pma-pdf.ts';

import type { SchemaRequest } from './request.ts';


type LinkMap = Map<string, number | ''>;

/** Plugins\Schema\Pdf\Pdf: scaled drawing helpers, the data dictionary rows and its header and footer. */
class SchemaPdf extends PmaPdf {
	xMin = 0;
	yMin = 0;
	leftMarginScale = 10;
	topMarginScale = 10;
	scale = 1;
	cMargin = 0;
	widths: number[] = [];
	/** customLinks['doc'|'RT'][table][column or '-'], with ['RT']['-'] for the schema page itself. */
	readonly docLinks = new Map<string, LinkMap>();
	readonly schemaLinks = new Map<string, LinkMap>();
	schemaPageLink = 0;

	constructor(orientation: Orientation, paper: string, private readonly withDoc: boolean) {
		super(orientation, 'mm', paper);
	}

	linksFor(map: Map<string, LinkMap>, table: string): LinkMap {
		let links = map.get(table);
		if (links === undefined) {
			links = new Map();
			map.set(table, links);
		}
		return links;
	}

	setScale(scale: number, xMin: number, yMin: number, leftMargin: number, topMargin: number): void {
		this.scale = scale;
		this.xMin = xMin;
		this.yMin = yMin;
		this.leftMarginScale = leftMargin;
		this.topMarginScale = topMargin;
	}

	cellScale(width: number, height: number, text: string, border: number, ln: number, align: string, fill: boolean, link: number | ''): void {
		this.cell(width / this.scale, height / this.scale, text, border, ln, align, fill, link);
	}

	lineScale(x1: number, y1: number, x2: number, y2: number): void {
		this.line(
			((x1 - this.xMin) / this.scale) + this.leftMarginScale,
			((y1 - this.yMin) / this.scale) + this.topMarginScale,
			((x2 - this.xMin) / this.scale) + this.leftMarginScale,
			((y2 - this.yMin) / this.scale) + this.topMarginScale,
		);
	}

	setXyScale(x: number, y: number): void {
		this.setXY(((x - this.xMin) / this.scale) + this.leftMarginScale, ((y - this.yMin) / this.scale) + this.topMarginScale);
	}

	setXScale(x: number): void {
		this.setX(((x - this.xMin) / this.scale) + this.leftMarginScale);
	}

	setFontSizeScale(size: number): void {
		this.setFontSize(size / this.scale);
	}

	setLineWidthScale(width: number): void {
		this.setLineWidth(width / this.scale);
	}

	/** Pdf::Header(): the page name above data dictionary pages. */
	override header(): void {
		if (!this.withDoc) {
			return;
		}
		this.setFont('B', 14);
		this.cell(0, 6, 'PDF export page', 'B', 1, 'C');
		this.setFont('');
		this.ln();
	}

	override footer(): void {
		if (this.withDoc) {
			super.footer();
		}
	}

	/** Pdf::numLines(): how many lines a text takes in a column, counted byte by byte as upstream does. */
	numLines(columnWidth: number, text: string): number {
		const width = columnWidth === 0 ? this.pageWidth - this.rMargin - this.x : columnWidth;
		const wmax = (width - (2 * this.cMargin)) * 1000 / this.fontSize;
		const bytes = [...new TextEncoder().encode(text.replaceAll('\r', ''))];
		let count = bytes.length;
		if (count > 0 && bytes[count - 1] === 10) {
			count--;
		}
		let separator = -1;
		let index = 0;
		let start = 0;
		let length = 0;
		let lines = 1;
		const style = this.fontStyle;
		while (index < count) {
			const byte = bytes[index];
			if (byte === 10) {
				index++;
				separator = -1;
				start = index;
				length = 0;
				lines++;
				continue;
			}
			if (byte === 32) {
				separator = index;
			}
			// mb_ord() of a lone byte of a multibyte character fails, and $cw[false] reads the width of character 0.
			length += listedWidth(style, byte < 0x80 ? byte : 0) ?? 0;
			if (length > wmax) {
				if (separator === -1) {
					if (index === start) {
						index++;
					}
				} else {
					index = separator + 1;
				}
				separator = -1;
				start = index;
				length = 0;
				lines++;
			} else {
				index++;
			}
		}
		return lines;
	}

	/** Pdf::row(): one data dictionary row, every column boxed and the first one linked. */
	row(data: string[], links: Map<number, number | ''>): void {
		let lines = 0;
		for (const [index, text] of data.entries()) {
			lines = Math.max(lines, this.numLines(this.widths[index], text));
		}
		const lineHeight = this.fontSize;
		const height = (lineHeight + 1) * lines;
		this.checkPageBreak(height);
		for (const [index, text] of data.entries()) {
			const width = this.widths[index];
			const { x, y } = this;
			this.rect(x, y, width, height);
			const link = links.get(index);
			if (link !== undefined && link !== '') {
				this.link(x, y, width, height, link);
			}
			this.multiCell(width, lineHeight + 1, text, 'L');
			this.setXY(x + width, y);
		}
		this.ln(height);
	}
}

interface PdfTable {
	stats: TableStats;
}

/** TableStatsPdf::getTitle(): the dimensions use the full table height. */
function title(stats: TableStats): string {
	let dimension = '';
	if (stats.tableDimension) {
		dimension = `${phpFixed(stats.width, 0)}x${phpFixed(stats.height, 6)}`;
	}
	return `${dimension} ${stats.tableName}`;
}

/** PdfRelationSchema::dataDictionaryDoc(): the table of contents and one page per table. */
async function dataDictionaryDoc(request: SchemaRequest, pdf: SchemaPdf, tables: string[], orientation: Orientation, paper: string): Promise<void> {
	const { context, db } = request;
	const { dbi } = context;
	pdf.addPage(orientation);
	pdf.cell(0, 9, 'Table of contents', 1, 0, 'C');
	pdf.ln(15);
	let number = 1;
	for (const table of tables) {
		const docLinks = pdf.linksFor(pdf.docLinks, table);
		docLinks.set('-', pdf.addLink());
		pdf.setX(10);
		pdf.cell(0, 6, `Page number: {${String(number).padStart(2, '0')}}`, 0, 0, 'R', false, docLinks.get('-'));
		pdf.setX(10);
		pdf.cell(0, 6, `${number} ${table}`, 0, 1, 'L', false, docLinks.get('-'));
		const columns = await dbi.getColumns(db, table);
		for (const row of columns.values()) {
			pdf.setX(20);
			docLinks.set(phpString(row.Field), pdf.addLink());
		}
		number++;
	}
	pdf.schemaPageLink = pdf.addLink();
	pdf.setX(10);
	pdf.cell(0, 6, 'Page number: {00}', 0, 0, 'R', false, pdf.schemaPageLink);
	pdf.setX(10);
	pdf.cell(0, 6, `${number} Relational schema`, 0, 1, 'L', false, pdf.schemaPageLink);

	let tableNumber = 0;
	for (const table of tables) {
		tableNumber++;
		pdf.setAutoPageBreak(true, 15);
		pdf.addPage(orientation);
		pdf.bookmark(table);
		pdf.setAlias(`{${String(tableNumber).padStart(2, '0')}}`, String(pdf.pageNo()));
		const schemaLinks = pdf.linksFor(pdf.schemaLinks, table);
		const docLinks = pdf.linksFor(pdf.docLinks, table);
		schemaLinks.set('-', pdf.addLink());
		pdf.setLink(docLinks.get('-') as number);
		pdf.setFont('B', 18);
		pdf.cell(0, 8, `${tableNumber} ${table}`, 1, 1, 'C', false, schemaLinks.get('-'));
		pdf.setFont('', 8);
		pdf.ln();

		const comments = await getComments(context, db, table);
		const status = await Table.get(context, table, db).getStatus() ?? {};
		const time = (key: string): string => {
			const value = status[key];
			if (value === undefined || value === null) {
				return '';
			}
			const timestamp = mysqlStrtotime(phpString(value), Math.floor(Date.now() / 1000));
			return localisedDate(timestamp ?? 0);
		};
		const showComment = phpString(status.Comment ?? status.TABLE_COMMENT);
		const columns = await dbi.getColumns(db, table);
		const foreigners = await getForeigners(context, db, table);
		let broke = false;
		for (const [label, value] of [['Table comments:', showComment], ['Creation:', time('Create_time')], ['Last update:', time('Update_time')], ['Last check:', time('Check_time')]]) {
			if (value === '' || value === '0') {
				continue;
			}

			pdf.cell(0, 3, `${label} ${value}`, 0, 1);
			broke = true;
		}
		if (broke) {
			pdf.cell(0, 3, '', 0, 1);
			pdf.ln();
		}

		pdf.setFont('B');
		let headers: [string, number][];
		if (orientation === 'L') {
			const commentsWidth = paper === 'A4' ? 67 : 50;
			headers = [['Column', 25], ['Type', 20], ['Attributes', 20], ['Null', 10], ['Default', 20], ['Extra', 25], ['Links to', 45], ['Comments', commentsWidth], ['MIME', 45]];
		} else {
			headers = [['Column', 20], ['Type', 20], ['Attributes', 20], ['Null', 10], ['Default', 15], ['Extra', 15], ['Links to', 30], ['Comments', 30], ['MIME', 30]];
		}
		for (const [index, [label, width]] of headers.entries()) {
			pdf.cell(width, 8, label, 1, index === headers.length - 1 ? 1 : 0, 'C');
		}
		pdf.widths = headers.map(([, width]) => width);
		pdf.setFont('');

		for (const row of columns.values()) {
			const spec = extractColumnSpec(phpString(row.Type));
			const nullable = phpString(row.Null);
			let defaultValue = row.Default;
			if ((defaultValue === undefined || defaultValue === null) && nullable !== '' && nullable !== 'NO') {
				defaultValue = 'NULL';
			}
			const field = phpString(row.Field);
			const schemaLinks = pdf.linksFor(pdf.schemaLinks, table);
			schemaLinks.set(field, pdf.addLink());
			pdf.bookmark(field, 1);
			const docLink = pdf.linksFor(pdf.docLinks, table).get(field);
			if (typeof docLink === 'number') {
				pdf.setLink(docLink);
			}
			const foreigner = searchColumnInForeigners(foreigners, field, db);
			let linksTo = '';
			if (foreigner !== false) {
				linksTo = '-> ';
				if (foreigner.foreign_db !== db) {
					linksTo += `${foreigner.foreign_db}.`;
				}
				linksTo += `${foreigner.foreign_table}.${foreigner.foreign_field}`;
				linksTo += `\nON UPDATE ${foreigner.on_update}\nON DELETE ${foreigner.on_delete}`;
			}
			const data = [
				field,
				spec.print_type,
				spec.attribute,
				nullable === '' || nullable === 'NO' ? 'No' : 'Yes',
				phpString(defaultValue),
				phpString(row.Extra),
				linksTo,
				comments[field] ?? '',
				'',
			];
			const links = new Map<number, number | ''>([[0, schemaLinks.get(field) ?? '']]);
			if (foreigner !== false) {
				const target = pdf.docLinks.get(foreigner.foreign_table)?.get(foreigner.foreign_field);
				if (target !== undefined) {
					links.set(6, target);
				}
			}
			pdf.row(data, links);
		}
		pdf.setFont('', 14);
	}
}

/** PdfRelationSchema::strokeGrid(). */
function strokeGrid(pdf: SchemaPdf, withDoc: boolean, topMargin: number, leftMargin: number): void {
	const gridSize = 10;
	const labelHeight = 4;
	const labelWidth = 5;
	const topSpace = withDoc ? 6 : 0;
	const bottomSpace = withDoc ? 15 : 0;
	pdf.setMargins(0, 0);
	pdf.setDrawColor(200, 200, 200);
	const innerHeight = pdf.getPageHeight() - topSpace - bottomSpace;
	for (let line = 0, size = Math.trunc(innerHeight / gridSize); line <= size; line++) {
		pdf.line(0, (line * gridSize) + topSpace, pdf.getPageWidth(), (line * gridSize) + topSpace);
		if (line <= 0 || line > Math.trunc((innerHeight - labelHeight) / gridSize)) {
			continue;
		}
		pdf.setXY(0, (line * gridSize) + topSpace);
		const label = phpFixed((((line * gridSize) + topSpace - topMargin) * pdf.scale) + pdf.yMin, 0);
		pdf.cell(labelWidth, labelHeight, ` ${label}`);
	}
	for (let column = 0, size = Math.trunc(pdf.getPageWidth() / gridSize); column <= size; column++) {
		pdf.line(column * gridSize, topSpace, column * gridSize, pdf.getPageHeight() - bottomSpace);
		pdf.setXY(column * gridSize, topSpace);
		pdf.cell(labelWidth, labelHeight, phpFixed((((column * gridSize) - leftMargin) * pdf.scale) + pdf.xMin, 0));
	}
}

const RELATION_COLORS = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [1, 0, 1], [0, 1, 1]];

/** PdfRelationSchema::__construct() and showOutput(): the whole document. */
export async function pdfSchema(request: SchemaRequest, now: Date): Promise<Uint8Array> {
	const { context, post, db, has } = request;
	const showGrid = has('pdf_show_grid');
	const showColor = has('pdf_show_color');
	const showKeys = has('pdf_show_keys');
	const tableDimension = has('pdf_show_table_dimension');
	const sameWide = has('pdf_all_tables_same_width');
	const withDoc = has('pdf_with_doc');
	const tableOrder = request.string('pdf_table_order');
	const orientation: Orientation = request.string('pdf_orientation') === 'P' ? 'P' : 'L';
	const paper = request.string('pdf_paper');

	const pdf = new SchemaPdf(orientation, paper, withDoc);
	pdf.title = `Schema of the ${db} database`;
	pdf.setAutoPageBreak(true);

	const allTables = getTablesFromRequest(post);
	if (tableOrder === 'name_asc') {
		allTables.sort(phpCompareStrings);
	} else if (tableOrder === 'name_desc') {
		allTables.sort((left, right) => phpCompareStrings(right, left));
	}

	if (withDoc) {
		pdf.setAutoPageBreak(true, 15);
		pdf.cMargin = 1;
		await dataDictionaryDoc(request, pdf, allTables, orientation, paper);
		pdf.setAutoPageBreak(true);
		pdf.cMargin = 0;
	}
	pdf.addPage();
	let topMargin = 10;
	let bottomMargin = 10;
	const leftMargin = 10;
	const rightMargin = 10;
	if (withDoc) {
		pdf.setLink(pdf.schemaPageLink);
		pdf.bookmark('Relational schema');
		pdf.setAlias('{00}', String(pdf.pageNo()));
		topMargin = 28;
		bottomMargin = 28;
	}

	let tableWidth = 0;
	let xMax = 0;
	let yMax = 0;
	let xMin = 100000;
	let yMin = 100000;
	const tables = new Map<string, PdfTable>();
	for (const name of allTables) {
		let table = tables.get(name);
		if (table === undefined) {
			const stats = await loadTableStats(context, post, db, name, showKeys, tableDimension);
			stats.heightCell = 6;
			stats.height = (stats.fields.length + 1) * stats.heightCell;
			for (const field of stats.fields) {
				stats.width = Math.max(stats.width, pdf.getStringWidth(field));
			}
			stats.width += pdf.getStringWidth(' '.repeat(6));
			pdf.setFont('B');
			while (stats.width < pdf.getStringWidth(title(stats))) {
				stats.width += 5;
			}
			pdf.setFont('');
			if (tableWidth < stats.width) {
				tableWidth = stats.width;
			}
			table = { stats };
			tables.set(name, table);
		}
		if (sameWide) {
			table.stats.width = tableWidth;
		}
		xMax = Math.max(xMax, table.stats.x + table.stats.width);
		yMax = Math.max(yMax, table.stats.y + table.stats.height);
		xMin = Math.min(xMin, table.stats.x);
		yMin = Math.min(yMin, table.stats.y);
	}

	const innerWidth = pdf.getPageWidth() - rightMargin - leftMargin;
	const innerHeight = pdf.getPageHeight() - topMargin - bottomMargin;
	const scale = Math.ceil(Math.max((xMax - xMin) / innerWidth, (yMax - yMin) / innerHeight) * 100) / 100;
	pdf.setScale(scale, xMin, yMin, leftMargin, topMargin);
	pdf.setLineWidthScale(0.1);
	if (showGrid) {
		pdf.setFontSize(10);
		strokeGrid(pdf, withDoc, topMargin, leftMargin);
	}
	pdf.setFontSizeScale(14);

	const relations: ReturnType<typeof relationStats>[] = [];
	const seenRelation = await forEachRelation(context, db, allTables, async (masterTable, masterField, foreignTable, foreignField) => {
		const master = tables.get(masterTable) as PdfTable;
		const foreign = tables.get(foreignTable) as PdfTable;
		relations.push(relationStats(master.stats, masterField, foreign.stats, foreignField, 5));
	});
	if (seenRelation) {
		for (const [index, relation] of relations.entries()) {
			if (showColor) {
				// Six hues, each fading in four steps as the relations go on.
				const hue = index % 6;
				const step = ((index - hue) / 6) % 4;
				const fade = 1 - (step / 6);
				const [red, green, blue] = RELATION_COLORS[hue];
				pdf.setDrawColor(red * 255 * fade, green * 255 * fade, blue * 255 * fade);
			} else {
				pdf.setDrawColor(0);
			}
			for (const [line, [x1, y1, x2, y2]] of relationLines(relation).entries()) {
				if (line === 0) {
					pdf.setLineWidthScale(0.2);
				} else if (line === 2) {
					pdf.setLineWidthScale(0.1);
				}
				pdf.lineScale(x1, y1, x2, y2);
			}
			pdf.setDrawColor(0);
		}
	}

	for (const { stats } of tables.values()) {
		pdf.setXyScale(stats.x, stats.y);
		pdf.setFont('B');
		if (showColor) {
			pdf.setTextColor(200);
			pdf.setFillColor(0, 0, 128);
		}
		const docLinks = pdf.linksFor(pdf.docLinks, stats.tableName);
		const schemaLinks = pdf.linksFor(pdf.schemaLinks, stats.tableName);
		if (withDoc) {
			pdf.setLink(schemaLinks.get('-') as number);
		} else {
			docLinks.set('-', '');
		}
		pdf.cellScale(stats.width, stats.heightCell, title(stats), 1, 1, 'C', showColor, docLinks.get('-') ?? '');
		pdf.setXScale(stats.x);
		pdf.setFont('');
		pdf.setTextColor(0);
		pdf.setFillColor(255);
		for (const field of stats.fields) {
			if (showColor) {
				if (stats.primary.includes(field)) {
					pdf.setFillColor(215, 121, 123);
				}
				if (field === stats.displayfield) {
					pdf.setFillColor(142, 159, 224);
				}
			}
			if (withDoc) {
				pdf.setLink(schemaLinks.get(field) as number);
			} else {
				docLinks.set(field, '');
			}
			pdf.cellScale(stats.width, stats.heightCell, ` ${field}`, 1, 1, 'L', showColor, docLinks.get(field) ?? '');
			pdf.setXScale(stats.x);
			pdf.setFillColor(255);
		}
	}
	return pdf.output(now);
}

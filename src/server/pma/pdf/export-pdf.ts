// Ports of Plugins\Export\Helpers\Pdf and Plugins\Export\ExportPdf: tables of query results, structures and triggers.
import { PmaPdf } from './pma-pdf.ts';
import { escapeBinary } from '../../../lib/pma/export-import/bytes.ts';
import { type FieldMetadata, FieldType } from '../../../lib/pma/field-metadata.ts';
import { extractColumnSpec } from '../../../lib/pma/table-structure/column-spec.ts';
import { phpString } from '../../../lib/twig/php.ts';
import { getComments, getForeigners } from '../controllers/table-data/relation.ts';
import {
	type ExportAliases,
	ExportPlugin,
	PhpError,
	type StructureOptions,
	getTriggers,
	isBinaryField,
} from '../plugins/export/engine.ts';

import type { PmaContext } from '../core/context.ts';
import type { DbiValue } from '../core/dbi.ts';

/** Plugins\Export\Helpers\Pdf: a landscape A3 report whose column titles repeat on every page. */
class ReportPdf extends PmaPdf {
	private dataY = 0;
	/** The `global $maxY` of Header(): the lowest column title so far, never reset. */
	private maxY: number | null = null;
	private readonly headerSet = new Set<number>();
	tableWidths = new Map<number, number>();
	colTitles = new Map<number, string>();
	colAlign = new Map<number, string>();
	titleFontSize = 0;
	titleText = '';
	dbAlias = '';
	tableAlias = '';
	purpose = '';

	constructor() {
		super('L', 'pt', 'A3');
	}

	private width(column: number): number {
		return this.tableWidths.get(column) ?? 0;
	}

	protected override pageBreakY(): number {
		return this.dataY;
	}

	/** Pdf::Header(): the report title, the purpose line and the shaded column titles. */
	override header(): void {
		this.setAutoPageBreak(false);
		if (!this.headerSet.has(this.page)) {
			this.setY(this.tMargin - ((this.fontSizePt / this.unit) * 5));
			const cellFontSize = this.fontSizePt;
			this.setFont('', this.titleFontSize || this.fontSizePt);
			this.cell(0, this.fontSizePt, this.titleText, 0, 1, 'C');
			this.setFont('', cellFontSize);
			this.setY(this.tMargin - ((this.fontSizePt / this.unit) * 2.5));
			this.cell(0, this.fontSizePt, `Database: ${this.dbAlias},  Table: ${this.tableAlias},  Purpose: ${this.purpose}`, 0, 1, 'L');
			let left = this.lMargin;
			for (const [column, title] of this.colTitles) {
				this.setXY(left, this.tMargin);
				this.multiCell(this.width(column), this.fontSizePt, title);
				left += this.width(column);
				if (this.maxY === null || this.maxY < this.y) {
					this.maxY = this.y;
				}
			}
			this.setXY(this.lMargin, this.tMargin);
			this.setFillColor(200, 200, 200);
			left = this.lMargin;
			for (const [column, title] of this.colTitles) {
				this.setXY(left, this.tMargin);
				this.cell(this.width(column), (this.maxY ?? 0) - this.tMargin, '', 1, 0, 'L', true);
				this.setXY(left, this.tMargin);
				this.multiCell(this.width(column), this.fontSizePt, title, 'C');
				left += this.width(column);
			}
			this.setFillColor(255, 255, 255);
			this.headerSet.add(this.page);
		}
		this.dataY = this.maxY ?? 0;
		this.setAutoPageBreak(true);
	}

	/** Fresh column definitions as [column, title, width, align], replacing the previous table's. */
	startTable(columns: [number, string, number, string][]): void {
		this.colTitles = new Map(columns.map(column => [column[0], column[1]]));
		this.tableWidths = new Map(columns.map(column => [column[0], column[2]]));
		this.colAlign = new Map(columns.map(column => [column[0], column[3]]));
	}

	/** The row loop and border drawing that morepagestable(), getTableDef() and getTriggers() share; false is text TCPDF cannot read. */
	writeRows(rows: Iterable<(string | false)[]>, lineHeight: number): void {
		let left = this.lMargin;
		const startHeight = this.dataY;
		let height = startHeight;
		const startPage = this.page;
		let currentPage = this.page;
		let fullWidth = 0;
		for (const width of this.tableWidths.values()) {
			fullWidth += width;
		}
		const tmpHeight = new Map<string, number>();
		let maxPage = this.page;
		let row = 0;
		for (const data of rows) {
			this.page = currentPage;
			this.line(left, height, fullWidth + left, height);
			for (const [column, text] of data.entries()) {
				this.page = currentPage;
				this.setXY(left, height);
				const width = this.tableWidths.get(column);
				if (width !== undefined && width > 0) {
					if (text === false) {
						// TCPDF drops text that is not valid UTF-8, so the cell writes nothing.
						this.setY(this.y);
					} else {
						this.multiCell(width, lineHeight, text, this.colAlign.get(column) ?? '');
					}
					left += width;
				}
				const key = `${row}-${this.page}`;
				if ((tmpHeight.get(key) ?? 0) < this.y) {
					tmpHeight.set(key, this.y);
				}
				maxPage = Math.max(maxPage, this.page);
			}
			height = tmpHeight.get(`${row}-${maxPage}`) ?? 0;
			left = this.lMargin;
			currentPage = maxPage;
			row++;
		}
		this.page = maxPage;
		this.line(left, height, fullWidth + left, height);
		for (let page = startPage; page <= maxPage; page++) {
			this.page = page;
			left = this.lMargin;
			const top = page === startPage ? startHeight : this.tMargin;
			const bottom = page === maxPage ? height : this.pageHeight - this.bMargin;
			this.line(left, top, left, bottom);
			for (const width of this.tableWidths.values()) {
				left += width;
				this.line(left, top, left, bottom);
			}
		}
		this.page = maxPage;
	}

	/** setY($tMargin), AddPage() and the 9pt font every table starts with. */
	newTablePage(): void {
		this.setY(this.tMargin);
		this.addPage();
		this.setFont('', 9);
	}
}

/** A result value as TCPDF reads it: NULL spelled out, and bytes that are not UTF-8 unreadable (false). */
function cellText(value: DbiValue | undefined, meta: FieldMetadata): string | false {
	if (value === null || value === undefined) {
		return 'NULL';
	}
	const text = phpString(value);
	if (!isBinaryField(meta)) {
		return text;
	}
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(text, character => (character.codePointAt(0) as number) & 0xFF));
	} catch {
		return false;
	}
}

/** Pdf::mysqlReport(): sizes the columns to the titles and data, then prints every row. */
async function mysqlReport(context: PmaContext, pdf: ReportPdf, query: string, aliases: ExportAliases, db: string, table: string): Promise<void> {
	const { dbi } = context;
	const result = await dbi.query(query);
	const fields = result.getFieldsMeta();
	const numFields = result.numFields();
	const availableWidth = pdf.pageWidth - pdf.lMargin - pdf.rMargin;
	const startWidth = availableWidth / numFields;
	let totalTitleWidth = 0;
	const colFits = new Map<number, number>();
	const titleWidth = new Map<number, number>();
	const titles = new Map<number, string>();
	const aligns = new Map<number, string>();
	for (const [index, field] of fields.entries()) {
		const name = aliases[db]?.tables?.[table]?.columns?.[field.name] || field.name;
		const stringWidth = pdf.getStringWidth(name) + 6;
		titleWidth.set(index, stringWidth);
		totalTitleWidth += stringWidth;
		if (stringWidth < startWidth) {
			colFits.set(index, stringWidth);
		}
		aligns.set(index, field.isType(FieldType.INT) && !field.isType(FieldType.BLOB) ? 'R' : 'L');
		// Binary blobs get no title and no width.
		if (!field.isType(FieldType.BLOB) || !field.isBinary) {
			titles.set(index, name);
		}
	}
	const adjustingMode = totalTitleWidth > availableWidth;
	if (!adjustingMode) {
		for (const [key, width] of titleWidth) {
			colFits.set(key, width);
		}
	}
	const rowTexts = (row: DbiValue[]): (string | false)[] => row.map((value, index) => cellText(value, fields[index]));
	for (let row = result.fetchRow(); row !== null; row = result.fetchRow()) {
		const texts = rowTexts(row);
		for (const [key, fit] of colFits) {
			const stringWidth = pdf.getStringWidth(texts[key] || '') + 6;
			if (adjustingMode && stringWidth > startWidth) {
				colFits.delete(key);
			} else if (stringWidth > fit && stringWidth < startWidth * 3) {
				colFits.set(key, stringWidth);
			}
		}
	}
	let fitted = 0;
	for (const width of colFits.values()) {
		fitted += width;
	}
	let surplusToAdd = 0;
	if (adjustingMode) {
		if (numFields === colFits.size) {
			throw new PhpError('DivisionByZeroError');
		}
		surplusToAdd = ((colFits.size * startWidth) - fitted) / (numFields - colFits.size);
	}
	pdf.colTitles = titles;
	pdf.colAlign = aligns;
	pdf.tableWidths = new Map(fields.map((_field, index) => [index, titles.has(index) ? colFits.get(index) ?? startWidth + surplusToAdd : 0]));

	const rowsResult = await dbi.query(query);
	pdf.newTablePage();
	const rows = function *(): Generator<(string | false)[]> {
		for (let row = rowsResult.fetchRow(); row !== null; row = rowsResult.fetchRow()) {
			yield rowTexts(row);
		}
	};
	pdf.writeRows(rows(), pdf.fontSizePt);
}

/** Pdf::getTableDef(): one row per column with its type, nullability, default, relation and comment. */
async function tableDef(context: PmaContext, pdf: ReportPdf, db: string, table: string, doRelation: boolean): Promise<void> {
	const { dbi } = context;
	await dbi.selectDb(db);
	let haveRelation = false;
	if (doRelation) {
		haveRelation = Object.keys(await getForeigners(context, db, table)).length > 0;
	}
	const titles: [number, string, number, string][] = [[0, 'Column', 90, 'L'], [1, 'Type', 80, 'L'], [2, 'Null', 40, 'L'], [3, 'Default', 120, 'L']];
	if (doRelation && haveRelation) {
		titles.push([4, 'Links to', 120, 'L']);
	}
	// Upstream skips index 4 for the comments, so without relations they sit past the last printed column.
	titles.push([5, 'Comments', 120, 'L']);
	pdf.startTable(titles);
	pdf.newTablePage();
	const comments = await getComments(context, db, table);
	const rows: string[][] = [];
	const columns = await dbi.getColumns(db, table);
	for (const column of columns.values()) {
		let type = extractColumnSpec(phpString(column.Type)).print_type;
		if (type === '') {
			type = ' ';
		}
		let defaultValue = column.Default;
		if ((defaultValue === undefined || defaultValue === null) && column.Null !== 'NO') {
			defaultValue = 'NULL';
		}
		const nullable = phpString(column.Null);
		const data = [phpString(column.Field), type, nullable === '' || nullable === 'NO' ? 'No' : 'Yes', phpString(defaultValue)];
		if (doRelation && haveRelation) {
			// Only pmadb relations are keyed by column, so InnoDB keys never show here.
			data.push('');
		}
		data.push(comments[phpString(column.Field)] ?? '');
		rows.push(data);
	}
	pdf.writeRows(rows, pdf.fontSizePt);
}

/** Pdf::getTriggers(). */
async function triggerTable(context: PmaContext, pdf: ReportPdf, db: string, table: string): Promise<void> {
	const triggers = await getTriggers(context, db, table);
	if (triggers.length === 0) {
		return;
	}
	pdf.startTable([[0, 'Name', 90, 'L'], [1, 'Time', 80, 'L'], [2, 'Event', 40, 'L'], [3, 'Definition', 240, 'L']]);
	pdf.newTablePage();
	pdf.writeRows(triggers.map(trigger => [trigger.name, trigger.actionTiming, trigger.event, trigger.definition]), pdf.fontSizePt);
}

/** Plugins\Export\ExportPdf. */
export class ExportPdf extends ExportPlugin {
	private readonly pdf = new ReportPdf();

	async exportHeader(): Promise<boolean> {
		const title = this.run.context.request.post.pdf_report_title;
		this.pdf.titleFontSize = 18;
		this.pdf.titleText = typeof title === 'string' && title !== '0' ? title : '';
		this.pdf.tMargin = 30;
		return true;
	}

	override async exportFooter(): Promise<boolean> {
		const bytes = this.pdf.output(new Date());
		let text = '';
		for (const byte of bytes) {
			text += String.fromCodePoint(byte);
		}
		return this.run.write(escapeBinary(text));
	}

	override async exportDBHeader(): Promise<boolean> {
		return true;
	}

	override async exportDBFooter(): Promise<boolean> {
		return true;
	}

	override async exportDBCreate(): Promise<boolean> {
		return true;
	}

	async exportData(db: string, table: string, sqlQuery: string, aliases: ExportAliases): Promise<boolean> {
		const [dbAlias, tableAlias] = this.initAlias(aliases, db, table);
		this.pdf.dbAlias = dbAlias;
		this.pdf.tableAlias = tableAlias;
		this.pdf.purpose = 'Dumping data';
		await mysqlReport(this.run.context, this.pdf, sqlQuery, aliases, db, table);
		return true;
	}

	override async exportRawQuery(db: string | null, sqlQuery: string): Promise<boolean> {
		this.pdf.dbAlias = '----';
		this.pdf.tableAlias = '----';
		this.pdf.purpose = 'Query result data';
		if (db !== null) {
			await this.dbi.selectDb(db);
		}
		await mysqlReport(this.run.context, this.pdf, sqlQuery, {}, db ?? '', '');
		return true;
	}

	override async exportStructure(db: string, table: string, exportMode: string, _exportType: string, options: StructureOptions, aliases: ExportAliases): Promise<boolean> {
		const [dbAlias, tableAlias] = this.initAlias(aliases, db, table);
		const purposes: Record<string, string> = { create_table: 'Table structure', triggers: 'Triggers', create_view: 'View structure', stand_in: 'Stand in' };
		this.pdf.dbAlias = dbAlias;
		this.pdf.tableAlias = tableAlias;
		this.pdf.purpose = purposes[exportMode] ?? '';
		if (exportMode === 'create_table' || exportMode === 'create_view') {
			await tableDef(this.run.context, this.pdf, db, table, options.relation);
		} else if (exportMode === 'triggers') {
			await triggerTable(this.run.context, this.pdf, db, table);
		}
		return true;
	}
}

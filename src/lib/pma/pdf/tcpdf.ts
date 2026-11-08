// Translated from TCPDF 6.10 by Nicola Asuni (LGPL-3.0-or-later); see NOTICE.
// A small, dependency-free stand-in for the parts of TCPDF 6.10 that phpMyAdmin's PDF schema and PDF export use.
// Layout follows TCPDF (DejaVu Sans metrics, cell padding, wrapping, page breaks); the text is drawn with the standard
// Helvetica faces instead of embedded DejaVu subsets, so characters outside WinAnsi print as "?".
import {
	FONT_ASCENT,
	FONT_DESCENT,
	type FontStyle,
	charWidth,
	toWinAnsi,
} from './fonts.ts';

export type Orientation = 'P' | 'L';

/** TCPDF_STATIC::getPageSizeFromFormat() for the formats phpMyAdmin offers, in points (portrait). */
const PAGE_FORMATS: Record<string, [number, number]> = {
	A3: [841.89, 1190.551],
	A4: [595.276, 841.89],
	A5: [419.528, 595.276],
	LETTER: [612, 792],
	LEGAL: [612, 1008],
};

const CELL_HEIGHT_RATIO = 1.25;

/** getAliasNumPage() and getAliasNbPages() with a Unicode font: the extra braces count when centring the footer. */
export const ALIAS_NUM_PAGE = '{{:pnp:}}';
export const ALIAS_NB_PAGES = '{{:ptp:}}';

interface Padding {
	L: number;
	T: number;
	R: number;
	B: number;
}

interface GraphicVars {
	fontStyle: FontStyle;
	fontSizePt: number;
	lMargin: number;
	rMargin: number;
	cellPadding: Padding;
	lineWidth: number;
	drawColor: string;
	fillColor: string;
	textColor: string;
}

interface PageData {
	content: string;
	wPt: number;
	hPt: number;
	annotations: { rect: [number, number, number, number]; link: number; }[];
	/** Length of the footer at the end of the content; drawing added later goes in front of it. */
	footerLength: number;
}

interface Outline {
	title: string;
	level: number;
	page: number;
	y: number;
}

/** sprintf('%F'). */
export function fmt(value: number): string {
	return value.toFixed(6);
}

/** sprintf('%.Nf'): PHP rounds an exact tie such as 184.5 to the even neighbour, where toFixed() rounds it up. */
export function phpFixed(value: number, decimals: number): string {
	const factor = 10 ** decimals;
	const scaled = value * factor;
	if (Math.abs(scaled % 1) === 0.5 && scaled / factor === value) {
		const truncated = Math.trunc(scaled);
		const even = truncated % 2 === 0 ? truncated : truncated + Math.sign(scaled);
		return (even / factor).toFixed(decimals);
	}
	return value.toFixed(decimals);
}

/** TCPDF_STATIC::_escape(): the characters a PDF literal string needs escaped. */
function escapePdfString(value: string): string {
	return value.replaceAll('\\', '\\\\').replaceAll('(', String.raw`\(`).replaceAll(')', String.raw`\)`)
		.replaceAll('\r', String.raw`\r`);
}

/** A text string for the document catalogue: UTF-16BE with a byte order mark, as hex. */
function textString(value: string): string {
	const units = [0xFE_FF];
	for (const character of value) {
		const codePoint = character.codePointAt(0) as number;
		if (codePoint > 0xFF_FF) {
			units.push(0xD8_00 + ((codePoint - 0x1_00_00) >> 10), 0xDC_00 + ((codePoint - 0x1_00_00) & 0x3_FF));
		} else {
			units.push(codePoint);
		}
	}
	return `<${units.map(unit => unit.toString(16).toUpperCase().padStart(4, '0')).join('')}>`;
}

function colorOperator(red: number, green: number | undefined, blue: number | undefined, gray: string, rgb: string): string {
	if (green === undefined || blue === undefined) {
		return `${fmt(red / 255)} ${gray}`;
	}
	return `${fmt(red / 255)} ${fmt(green / 255)} ${fmt(blue / 255)} ${rgb}`;
}

/** D:YYYYMMDDHHmmss+00'00'. */
function pdfDate(date: Date): string {
	const pad = (value: number): string => String(value).padStart(2, '0');
	return `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}+00'00'`;
}

export class Tcpdf {
	/** The left and right margins of the first page, which headers and footers use. */
	private originalMargins: [number, number] | null = null;
	private readonly format: [number, number];
	private readonly links: { page: number; y: number; }[] = [];
	private readonly outlines: Outline[] = [];
	private readonly aliases = new Map<string, string>();
	private readonly defaultGraphicVars: GraphicVars;
	/** Scale factor: points per user unit. */
	readonly unit: number;
	pageWidth = 0;
	pageHeight = 0;
	curOrientation: Orientation = 'P';
	lMargin = 0;
	tMargin = 0;
	rMargin = 0;
	bMargin = 0;
	autoPageBreak = true;
	pageBreakTrigger = 0;
	cellPadding: Padding = { L: 0, T: 0, R: 0, B: 0 };
	lineWidth: number;
	fontStyle: FontStyle = '';
	fontSizePt = 12;
	fontSize = 0;
	fontAscent = 0;
	fontDescent = 0;
	x = 0;
	y = 0;
	lasth = 0;
	/** The page content goes to; phpMyAdmin moves it back to earlier pages directly. */
	page = 0;
	numpages = 0;
	inHeader = false;
	inFooter = false;
	/** setFooterFont(): the size the footer starts with. */
	footerFontSize = 12;
	drawColor = '0 G';
	fillColor = '0 g';
	textColor = '0 g';
	title = '';
	author = '';
	readonly pages: PageData[] = [];

	constructor(orientation: Orientation = 'P', unit: 'mm' | 'pt' = 'mm', format = 'A4') {
		this.unit = unit === 'pt' ? 1 : 72 / 25.4;
		// TCPDF looks the name up as given, so phpMyAdmin's "letter" and "legal" come out as A4.
		this.format = PAGE_FORMATS[format] ?? PAGE_FORMATS.A4;
		this.setPageOrientation(orientation);
		const margin = 28.35 / this.unit;
		this.setMargins(margin, margin);
		this.setCellPaddings(margin / 10, 0, margin / 10, 0);
		this.lineWidth = 0.57 / this.unit;
		this.setAutoPageBreak(true, 2 * margin);
		this.setFontSize(12);
		this.defaultGraphicVars = this.getGraphicVars();
	}

	private setPageOrientation(orientation: Orientation): void {
		this.curOrientation = orientation;
		const [short, long] = this.format;
		const [wPt, hPt] = orientation === 'L' ? [long, short] : [short, long];
		this.pageWidth = wPt / this.unit;
		this.pageHeight = hPt / this.unit;
		this.pageBreakTrigger = this.pageHeight - this.bMargin;
	}

	private getGraphicVars(): GraphicVars {
		return {
			fontStyle: this.fontStyle,
			fontSizePt: this.fontSizePt,
			lMargin: this.lMargin,
			rMargin: this.rMargin,
			cellPadding: { ...this.cellPadding },
			lineWidth: this.lineWidth,
			drawColor: this.drawColor,
			fillColor: this.fillColor,
			textColor: this.textColor,
		};
	}

	/** TCPDF::setGraphicVars(): restores the state and repeats it on the open page. */
	private setGraphicVars(vars: GraphicVars): void {
		this.lMargin = vars.lMargin;
		this.rMargin = vars.rMargin;
		this.cellPadding = { ...vars.cellPadding };
		this.lineWidth = vars.lineWidth;
		this.drawColor = vars.drawColor;
		this.fillColor = vars.fillColor;
		this.textColor = vars.textColor;
		this.out(`${this.lineStyle()} ${this.drawColor} ${this.fillColor}`);
		this.setFont(vars.fontStyle, vars.fontSizePt);
	}

	private lineStyle(): string {
		return `${fmt(this.lineWidth * this.unit)} w 0 J 0 j [] 0 d`;
	}

	private endPage(): void {
		// Only the newest page is open; earlier ones were closed when the next one was added.
		if (this.page === 0 || this.numpages > this.page) {
			return;
		}
		this.setFooter();
	}

	/** Runs header() or footer() on default settings inside a saved graphics state. */
	private runDecoration(y: number, draw: () => void): void {
		const lasth = this.lasth;
		this.setGraphicVars(this.defaultGraphicVars);
		this.out('q');
		const [left, right] = this.originalMargins as [number, number];
		this.lMargin = left;
		this.rMargin = right;
		this.cellPadding = { L: 0, T: 0, R: 0, B: 0 };
		this.setXY(this.lMargin, y);
		draw();
		this.setXY(this.lMargin, this.tMargin);
		this.out('Q');
		this.lasth = lasth;
	}

	private setHeader(): void {
		this.inHeader = true;
		this.runDecoration(0, () => {
			this.header();
		});
		this.inHeader = false;
	}

	private setFooter(): void {
		this.inFooter = true;
		const vars = this.getGraphicVars();
		const current = this.pages[this.page] as PageData;
		const start = current.content.length;
		this.out('');
		this.runDecoration(this.pageHeight, () => {
			this.setFont('', this.footerFontSize);
			this.footer();
		});
		this.setGraphicVars(vars);
		current.footerLength = current.content.length - start;
		this.inFooter = false;
	}

	/** The `x y w -h` operands of a rectangle, in points. */
	private rectangle(x: number, y: number, width: number, height: number): string {
		const { unit } = this;
		return `${fmt(x * unit)} ${fmt((this.pageHeight - y) * unit)} ${fmt(width * unit)} ${fmt(-height * unit)}`;
	}

	/** The fill and border of a cell (`re` with B, f or S), then its separate border lines. */
	private cellFrame(x: number, y: number, width: number, height: number, border: number | string, fill: boolean): string {
		const { unit } = this;
		let code = '';
		if (fill || border === 1) {
			let operator = 'S';
			if (fill) {
				operator = border === 1 ? 'B' : 'f';
			}
			code += `${this.rectangle(x, y, width, height)} re ${operator} `;
		}
		if (border === 1) {
			return `${code}${this.rectangle(x, y, width, height)} re S `;
		}
		if (typeof border === 'string') {
			const left = x * unit;
			const right = (x + width) * unit;
			const top = (this.pageHeight - y) * unit;
			const bottom = (this.pageHeight - y - height) * unit;
			// Each side is its own square-capped line, drawn in TCPDF's direction.
			const lines: Record<string, [number, number, number, number]> = {
				L: [left, bottom, left, top],
				T: [left, top, right, top],
				R: [right, top, right, bottom],
				B: [right, bottom, left, bottom],
			};
			for (const side of new Set(border)) {
				if (!Object.hasOwn(lines, side)) {
					continue;
				}

				const [x1, y1, x2, y2] = lines[side];
				code += `2 J 0 j \n${fmt(x1)} ${fmt(y1)} m ${fmt(x2)} ${fmt(y2)} l S \n${this.lineStyle()} ${this.drawColor}\n`;
			}
		}
		return code;
	}

	/** TCPDF::adjustCellPadding(): bordered sides get at least half the line width of padding. */
	private adjustCellPadding(border: number | string): void {
		const sides = border === 1 ? 'LTRB' : String(border);
		const adjusted = { ...this.cellPadding };
		for (const side of ['L', 'T', 'R', 'B'] as const) {
			if (sides.includes(side)) {
				adjusted[side] = Math.max(adjusted[side], this.lineWidth / 2);
			}
		}
		this.cellPadding = adjusted;
	}

	/** Splits text into the lines TCPDF::Write() prints in a box `wmax` wide (spaces and dashes between letters are break points). */
	private wrapLines(text: string, wmax: number, pageWidth: number): string[] {
		const chars = [...text.replaceAll('\r', '')];
		const lines: string[] = [];
		let start = 0;
		let separator = -1;
		let length = 0;
		for (let index = 0; index < chars.length; index++) {
			const character = chars[index];
			if (character === '\n') {
				lines.push(chars.slice(start, index).join(''));
				start = index + 1;
				separator = -1;
				length = 0;
				continue;
			}
			const isDash = character === '-' && /\p{L}/u.test(chars[index - 1] ?? '') && /\p{L}/u.test(chars[index + 1] ?? '');
			if (character !== '\u{A0}' && (/\s/u.test(character) || isDash)) {
				separator = index;
			}
			length += charWidth(this.fontStyle, character.codePointAt(0) as number) * this.fontSize / 1000;
			if (length <= wmax) {
				continue;
			}
			const nextWord = separator === -1 ? '' : chars.slice(separator + 1).join('').trim()
				.split(/\s/u, 1)[0];
			if (separator === -1 || this.getStringWidth(nextWord) > pageWidth) {
				// No break point, or the next word could never fit: break before this character.
				lines.push(chars.slice(start, index).join(''));
				start = index;
				index--;
			} else {
				const dash = chars[separator] === '-' ? '-' : '';
				lines.push(chars.slice(start, separator).join('') + dash);
				start = separator + 1;
				index = separator;
			}
			separator = -1;
			length = 0;
		}
		if (start < chars.length || lines.length === 0) {
			lines.push(chars.slice(start).join(''));
		}
		return lines;
	}

	/** Writes to the current page, like TCPDF::_out() while a page is open. */
	out(code: string): void {
		const current = this.pages[this.page];
		if (current === undefined) {
			return;
		}
		if (this.inFooter || current.footerLength === 0) {
			current.content += `${code}\n`;
		} else {
			const split = current.content.length - current.footerLength;
			current.content = `${current.content.slice(0, split)}${code}\n${current.content.slice(split)}`;
		}
	}

	setMargins(left: number, top: number, right = left): void {
		this.lMargin = left;
		this.tMargin = top;
		this.rMargin = right;
	}

	setAutoPageBreak(auto: boolean, margin = 0): void {
		this.autoPageBreak = auto;
		this.bMargin = margin;
		this.pageBreakTrigger = this.pageHeight - margin;
	}

	setCellPaddings(left: number, top: number, right: number, bottom: number): void {
		this.cellPadding = { L: left, T: top, R: right, B: bottom };
	}

	getPageWidth(): number {
		return this.pageWidth;
	}

	getPageHeight(): number {
		return this.pageHeight;
	}

	pageNo(): number {
		return this.page;
	}

	/** The page header, run for every new page; phpMyAdmin's subclasses override it. */
	header(): void {}

	/** The page footer, run when a page is closed; phpMyAdmin's subclasses override it. */
	footer(): void {}

	/** TCPDF::AddPage(): moves on to the next page, reusing one that already exists. */
	addPage(orientation: Orientation | '' = ''): void {
		this.originalMargins ??= [this.lMargin, this.rMargin];
		this.endPage();
		if (this.numpages > this.page) {
			this.page++;
			this.setY(this.tMargin);
			return;
		}
		this.numpages++;
		const vars = this.getGraphicVars();
		this.page++;
		this.setPageOrientation(orientation === '' ? this.curOrientation : orientation);
		this.pages[this.page] = { content: '', wPt: this.pageWidth * this.unit, hPt: this.pageHeight * this.unit, annotations: [], footerLength: 0 };
		this.x = this.lMargin;
		this.y = this.tMargin;
		this.setGraphicVars(vars);
		this.setHeader();
		this.setGraphicVars(vars);
	}

	setFont(style: FontStyle, size?: number): void {
		this.fontStyle = style;
		this.setFontSize(size ?? this.fontSizePt);
	}

	setFontSize(size: number): void {
		this.fontSizePt = size;
		this.fontSize = size / this.unit;
		this.fontAscent = (FONT_ASCENT * size / 1000) / this.unit;
		this.fontDescent = (FONT_DESCENT * size / 1000) / this.unit;
		this.out(`BT /F${this.fontStyle === 'B' ? 2 : 1} ${fmt(size)} Tf ET`);
	}

	/** TCPDF::GetStringWidth(): each character's width at the current font size, summed in order. */
	getStringWidth(text: string): number {
		let width = 0;
		for (const character of text) {
			width += charWidth(this.fontStyle, character.codePointAt(0) as number) * this.fontSize / 1000;
		}
		return width;
	}

	setLineWidth(width: number): void {
		this.lineWidth = width;
		this.out(`${fmt(width * this.unit)} w`);
	}

	/** setDrawColor($gray) or setDrawColor($r, $g, $b). */
	setDrawColor(red: number, green?: number, blue?: number): void {
		this.drawColor = colorOperator(red, green, blue, 'G', 'RG');
		this.out(this.drawColor);
	}

	setFillColor(red: number, green?: number, blue?: number): void {
		this.fillColor = colorOperator(red, green, blue, 'g', 'rg');
		this.out(this.fillColor);
	}

	setTextColor(red: number, green?: number, blue?: number): void {
		this.textColor = colorOperator(red, green, blue, 'g', 'rg');
	}

	setX(x: number): void {
		this.x = Math.min(Math.max(x >= 0 ? x : this.pageWidth + x, 0), this.pageWidth);
	}

	setY(y: number, resetX = true): void {
		if (resetX) {
			this.x = this.lMargin;
		}
		this.y = Math.min(Math.max(y >= 0 ? y : this.pageHeight + y, 0), this.pageHeight);
	}

	setXY(x: number, y: number): void {
		this.setY(y, false);
		this.setX(x);
	}

	ln(height?: number): void {
		this.x = this.lMargin;
		this.y += height ?? this.lasth;
	}

	/** TCPDF::getCellHeight(). */
	getCellHeight(fontSize: number): number {
		return Math.round((fontSize * CELL_HEIGHT_RATIO + this.cellPadding.T + this.cellPadding.B) * 1e6) / 1e6;
	}

	/** Where checkPageBreak() continues on the new page; the export helper starts below its table header. */
	protected pageBreakY(): number {
		return this.tMargin;
	}

	/** TCPDF::checkPageBreak(). */
	checkPageBreak(height: number): boolean {
		if (this.y + height > this.pageBreakTrigger && !this.inHeader && !this.inFooter && this.autoPageBreak) {
			const { x } = this;
			this.addPage(this.curOrientation);
			this.y = this.pageBreakY();
			this.x = x;
			return true;
		}
		return false;
	}

	line(x1: number, y1: number, x2: number, y2: number): void {
		const { unit, pageHeight } = this;
		this.out(`\n${fmt(x1 * unit)} ${fmt((pageHeight - y1) * unit)} m\n${fmt(x2 * unit)} ${fmt((pageHeight - y2) * unit)} l\nS`);
	}

	rect(x: number, y: number, width: number, height: number): void {
		this.out(`${this.rectangle(x, y, width, height)} re S`);
	}

	addLink(): number {
		this.links.push({ page: 0, y: 0 });
		return this.links.length;
	}

	/** setLink($link, -1): the link now points at the current position. */
	setLink(link: number): void {
		const target = this.links[link - 1];
		if (target !== undefined) {
			target.y = this.y;
			target.page = this.page;
		}
	}

	link(x: number, y: number, width: number, height: number, link: number): void {
		const { unit } = this;
		const top = (this.pageHeight - y) * unit;
		(this.pages[this.page] as PageData).annotations.push({ rect: [x * unit, top - (height * unit), (x + width) * unit, top], link });
	}

	/** TCPDF::Bookmark() at the current position; a level may only go one deeper than the previous entry. */
	bookmark(title: string, level = 0): void {
		const previous = this.outlines.at(-1)?.level ?? -1;
		this.outlines.push({ title, level: Math.min(level, previous + 1), page: this.page, y: this.y });
	}

	/** Replaces `name` with `value` in every page when the document is written. */
	setAlias(name: string, value: string): void {
		this.aliases.set(name, value);
	}

	/** TCPDF::Cell() with the default top cell alignment and middle vertical alignment. */
	cell(cellWidth: number, cellHeight = 0, text = '', border: number | string = 0, ln = 0, align = '', fill = false, link: number | '' = ''): void {
		const padding = this.cellPadding;
		this.adjustCellPadding(border);
		let height = cellHeight;
		const minimum = this.getCellHeight(this.fontSize);
		if (height < minimum) {
			height = minimum;
		}
		this.checkPageBreak(height);
		const { unit } = this;
		const { x, y } = this;
		let width = cellWidth;
		if (width <= 0) {
			width = this.pageWidth - this.rMargin - x;
		}
		let code = this.cellFrame(x, y, width, height, border, fill);
		const txt = text.replaceAll('\u{A0}', ' ').replaceAll('\u{AD}', '');
		if (txt !== '') {
			const textWidth = this.getStringWidth(txt);
			let dx = this.cellPadding.L;
			if (align === 'C') {
				dx = (width - textWidth) / 2;
			} else if (align === 'R') {
				dx = width - textWidth - this.cellPadding.R;
			}
			const yt = y + ((height - this.fontAscent - this.fontDescent) / 2);
			const baseline = yt + this.fontAscent;
			const draw = `BT ${fmt((x + dx) * unit)} ${fmt((this.pageHeight - baseline) * unit)} Td [(${escapePdfString(toWinAnsi(txt.replaceAll('\r', ' ')))})] TJ ET`;
			if (this.textColor === this.fillColor) {
				code += draw;
			} else {
				code += `q ${this.textColor} ${draw} Q`;
			}
			if (link !== '') {
				this.link(x + dx, yt, textWidth, this.fontAscent + this.fontDescent, link);
			}
		}
		this.lasth = height;
		if (ln > 0) {
			this.y = y + height;
			if (ln === 1) {
				this.x = this.lMargin;
			}
		} else {
			this.x = x + width;
		}
		this.out(`${this.lineStyle()} ${this.drawColor} ${this.fillColor}\n${code}`);
		this.cellPadding = padding;
	}

	/**
	 * TCPDF::MultiCell() without border or fill (phpMyAdmin never asks for them): the text wrapped into lines of the
	 * cell height, left at the start (ln 0), below (ln 1) or below and to the right (ln 2).
	 */
	multiCell(cellWidth: number, _cellHeight: number, text: string, align = 'J', ln = 1): void {
		const startPage = this.page;
		const { x, y } = this;
		let width = cellWidth;
		if (width <= 0) {
			width = this.pageWidth - x - this.rMargin;
		}
		const lMargin = this.lMargin;
		const rMargin = this.rMargin;
		this.lMargin = x;
		this.rMargin = this.pageWidth - x - width;
		this.lasth = this.getCellHeight(this.fontSize);
		const txt = text === '' ? ' ' : text;
		const wmax = width - this.cellPadding.L - this.cellPadding.R;
		let widest = 0;
		for (const character of `${txt.replaceAll('\r', '')}.`) {
			widest = Math.max(widest, charWidth(this.fontStyle, character.codePointAt(0) as number) * this.fontSize / 1000);
		}
		// TCPDF::Write() prints nothing when even one character is wider than the column.
		if (widest <= wmax) {
			const lines = this.wrapLines(txt, wmax, this.pageWidth - this.lMargin - this.rMargin);
			// Justified lines are printed left-aligned.
			const lineAlign = align === 'J' ? 'L' : align;
			for (const line of lines) {
				this.cell(width, this.lasth, line, 0, 1, lineAlign);
			}
		}
		const currentY = this.y;
		this.lMargin = lMargin;
		this.rMargin = rMargin;
		if (ln > 0) {
			this.setY(currentY);
			if (ln === 2) {
				this.setX(x + width);
			}
		} else {
			this.page = startPage;
			this.y = y;
			this.setX(x + width);
		}
	}

	/** TCPDF::Close() and the document writer: pages, fonts, links, outlines and the info dictionary. */
	output(now: Date): Uint8Array {
		if (this.page === 0) {
			this.addPage();
		}
		this.page = this.numpages;
		this.endPage();
		const objects: string[] = [];
		const add = (body: string): number => {
			objects.push(body);
			return objects.length;
		};
		const catalogId = add('');
		const pagesId = add('');
		const regularId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
		const boldId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
		// Page objects come first so annotations and outlines can point at them.
		const pageIds = this.pages.slice(1).map(() => add(''));
		const destination = (page: number, y: number): string => {
			const target = this.pages[page] ?? this.pages[1];
			const pageId = pageIds[this.pages.indexOf(target) - 1];
			return `[${pageId} 0 R /XYZ 0 ${fmt(target.hPt - (y * this.unit))} null]`;
		};
		for (const [index, pageData] of this.pages.slice(1).entries()) {
			let content = pageData.content.replaceAll(ALIAS_NUM_PAGE, () => String(index + 1)).replaceAll(ALIAS_NB_PAGES, () => String(this.numpages));
			for (const [name, value] of this.aliases) {
				content = content.replaceAll(name, () => value);
			}
			const contentId = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
			const annotationIds = pageData.annotations.map(({ rect, link }) => {
				const target = this.links[link - 1] ?? { page: 1, y: 0 };
				return add(`<< /Type /Annot /Subtype /Link /Rect [${rect.map(value => fmt(value)).join(' ')}] /Border [0 0 0] /Dest ${destination(target.page, target.y)} >>`);
			});
			const annotations = annotationIds.length > 0 ? ` /Annots [${annotationIds.map(id => `${id} 0 R`).join(' ')}]` : '';
			objects[pageIds[index] - 1] = `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${fmt(pageData.wPt)} ${fmt(pageData.hPt)}] /Resources << /Font << /F1 ${regularId} 0 R /F2 ${boldId} 0 R >> >> /Contents ${contentId} 0 R${annotations} >>`;
		}
		objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
		let outlines = '';
		if (this.outlines.length > 0) {
			const rootId = add('');
			const firstId = objects.length + 1;
			const ids = this.outlines.map((_outline, index) => firstId + index);
			// Each entry's parent is the closest earlier entry one level up; siblings link to each other.
			const parents = this.outlines.map((outline, index) => {
				for (let previous = index - 1; previous >= 0; previous--) {
					if (this.outlines[previous].level < outline.level) {
						return ids[previous];
					}
				}
				return rootId;
			});
			const childrenOf = (parent: number): number[] => ids.filter((_id, index) => parents[index] === parent);
			for (const [index, outline] of this.outlines.entries()) {
				const siblings = childrenOf(parents[index]);
				const position = siblings.indexOf(ids[index]);
				const children = childrenOf(ids[index]);
				let entry = `<< /Title ${textString(outline.title)} /Parent ${parents[index]} 0 R`;
				if (position > 0) {
					entry += ` /Prev ${siblings[position - 1]} 0 R`;
				}
				if (position < siblings.length - 1) {
					entry += ` /Next ${siblings[position + 1]} 0 R`;
				}
				if (children.length > 0) {
					entry += ` /First ${children[0]} 0 R /Last ${children.at(-1)} 0 R /Count 0`;
				}
				add(`${entry} /Dest ${destination(outline.page, outline.y)} >>`);
			}
			const top = childrenOf(rootId);
			objects[rootId - 1] = `<< /Type /Outlines /First ${top[0]} 0 R /Last ${top.at(-1)} 0 R >>`;
			outlines = ` /Outlines ${rootId} 0 R /PageMode /UseOutlines`;
		}
		objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R${outlines} >>`;
		const date = pdfDate(now);
		const infoId = add(`<< /Title ${textString(this.title)} /Author ${textString(this.author)} /Producer ${textString('phpMyAdmin')} /CreationDate (${date}) /ModDate (${date}) >>`);

		let pdf = '%PDF-1.7\n%\u{E2}\u{E3}\u{CF}\u{D3}\n';
		const offsets: number[] = [];
		for (const [index, body] of objects.entries()) {
			offsets.push(pdf.length);
			pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
		}
		const xref = pdf.length;
		pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
		for (const offset of offsets) {
			pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
		}
		pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
		return Uint8Array.from(pdf, character => character.codePointAt(0) as number);
	}
}

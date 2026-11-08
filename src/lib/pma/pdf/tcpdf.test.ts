import { describe, expect, it } from 'vitest';

import {
	ALIAS_NB_PAGES,
	ALIAS_NUM_PAGE,
	Tcpdf,
	fmt,
	phpFixed,
} from './tcpdf.ts';

const NOW = new Date(Date.UTC(2026, 10, 7, 8, 45, 5));

function latin1(bytes: Uint8Array): string {
	return String.fromCodePoint(...bytes);
}

/** The text-drawing operators of a page, as "x y text". */
function texts(pdf: Tcpdf, page = pdf.page): string[] {
	return (pdf.pages[page]?.content ?? '').matchAll(/BT ([\d.-]+) ([\d.-]+) Td \[\((.*?)\)\] TJ ET/g).map(match => `${match[1]} ${match[2]} ${match[3]}`).toArray();
}

/** An A3 landscape report in points, as the PDF export builds it. */
function report(): Tcpdf {
	const pdf = new Tcpdf('L', 'pt', 'A3');
	pdf.addPage();
	return pdf;
}

describe('page setup', () => {
	it('sizes pages from the format and orientation, in user units', () => {
		const pdf = new Tcpdf('L', 'mm', 'A4');
		expect(pdf.getPageWidth()).toBeCloseTo(297, 2);
		expect(pdf.getPageHeight()).toBeCloseTo(210, 2);
		expect(new Tcpdf('P', 'pt', 'A3').getPageHeight()).toBe(1190.551);
	});

	it('looks formats up by their exact name, so lowercase letter is A4 as in TCPDF', () => {
		expect(new Tcpdf('P', 'pt', 'letter').getPageWidth()).toBe(595.276);
		expect(new Tcpdf('P', 'pt', 'LETTER').getPageWidth()).toBe(612);
	});

	it('writes one empty page for a document nobody drew on', () => {
		const output = latin1(new Tcpdf().output(NOW));
		expect(output.startsWith('%PDF-1.7')).toBe(true);
		expect(output).toContain('/Count 1');
		expect(output).toContain('/CreationDate (D:20261107084505+00\'00\')');
	});
});

describe('cell', () => {
	it('draws a shaded, bordered title cell and its centred text where TCPDF does', () => {
		const pdf = report();
		pdf.setFont('', 12);
		pdf.setFillColor(200, 200, 200);
		pdf.setXY(28.35, 30);
		pdf.cell(18.782, 15.57, '', 1, 0, 'L', true);
		pdf.setXY(28.35, 30);
		pdf.multiCell(18.782, 12, 'id', 'C');
		const content = pdf.pages[1].content;
		expect(content).toContain('28.350000 811.890000 18.782000 -15.570000 re B 28.350000 811.890000 18.782000 -15.570000 re S');
		expect(content).toContain('q 0 g BT 32.263000 800.238000 Td [(id)] TJ ET Q');
	});

	it('right-aligns numbers inside the cell padding and moves down one line', () => {
		const pdf = report();
		pdf.setFont('', 9);
		pdf.setXY(28.35, 45);
		pdf.multiCell(18.782, 9, '1', 'R');
		expect(texts(pdf)).toEqual(['38.573000 788.151000 1']);
		expect(pdf.y).toBe(56.25);
		expect(pdf.x).toBe(28.35);
	});

	it('centres phpMyAdmin\'s footer with TCPDF\'s aliases measured at full width', () => {
		class Footed extends Tcpdf {
			override footer(): void {
				this.setY(-15);
				this.setFont('', 14);
				this.cell(0, 6, `Page number: ${ALIAS_NUM_PAGE}/${ALIAS_NB_PAGES}`, 'T', 0, 'C');
			}
		}
		const output = latin1(new Footed('L', 'pt', 'A3').output(NOW));
		expect(output).toContain('2 J 0 j \n28.350000 15.000000 m 1162.201000 15.000000 l S');
		expect(output).toContain('BT 471.508500 1.263500 Td [(Page number: 1/1)] TJ ET');
	});

	it('grows to the font\'s line height and pads bordered sides by half the line width', () => {
		const pdf = report();
		pdf.setFont('', 10);
		pdf.cell(50, 1, 'x', 0, 1);
		expect(pdf.lasth).toBe(12.5);
		pdf.cell(50, 1, 'x', 1, 1);
		expect(pdf.lasth).toBe(13.07);
		pdf.cell(50, 1, 'x', 'B', 1);
		expect(pdf.lasth).toBe(12.785);
	});

	it('fills without a border, frames only the known sides and recolours the text', () => {
		const pdf = report();
		pdf.setFillColor(255);
		pdf.setTextColor(10, 20, 30);
		pdf.cell(40, 20, 'a', 0, 0, '', true);
		pdf.cell(40, 20, 'b', 'TX', 2);
		const content = pdf.pages[1].content;
		expect(content).toMatch(/re f q 0\.039216 0\.078431 0\.117647 rg BT/);
		expect(content.match(/2 J 0 j/g)).toHaveLength(1);
		expect([pdf.x, pdf.y]).toEqual([28.35 + 40, 28.35 + 20]);
	});

	it('cleans the text the way TCPDF does before drawing it', () => {
		const pdf = report();
		pdf.cell(0, 10, 'a\u{A0}b\u{AD}c(d)\re 漢');
		expect(texts(pdf)[0]).toMatch(/ a bc\\\(d\\\) e \?$/);
		expect(pdf.x).toBeCloseTo(pdf.getPageWidth() - pdf.rMargin);
	});

	it('links the text of a cell to a position set later', () => {
		const pdf = report();
		const link = pdf.addLink();
		pdf.cell(100, 10, 'go', 0, 1, 'L', false, link);
		pdf.addPage();
		pdf.setY(100);
		pdf.setLink(link);
		pdf.setLink(99);
		const output = latin1(pdf.output(NOW));
		expect(output).toMatch(/\/Annots \[\d+ 0 R\]/);
		expect(output).toMatch(/\/Subtype \/Link \/Rect \[[\d. ]+\] \/Border \[0 0 0\] \/Dest \[6 0 R \/XYZ 0 741\.890000 null\]/);
	});

	it('points unknown or unset links at the top of the first page', () => {
		const pdf = report();
		pdf.link(0, 0, 10, 10, pdf.addLink());
		pdf.link(0, 0, 10, 10, 42);
		const output = latin1(pdf.output(NOW));
		expect(output.match(/\/Dest \[5 0 R \/XYZ 0 841\.890000 null\]/g)).toHaveLength(2);
	});
});

describe('multiCell', () => {
	/** A 10pt report whose 64pt column fits about ten "a"s. */
	function narrow(): Tcpdf {
		const pdf = report();
		pdf.setFont('', 10);
		return pdf;
	}

	it('wraps at spaces and drops the space it broke at', () => {
		const pdf = narrow();
		pdf.multiCell(70, 10, 'aaaa bbbb cccc dddd');
		expect(texts(pdf).map(line => line.split(' ').slice(2).join(' '))).toEqual(['aaaa bbbb', 'cccc dddd']);
		expect(pdf.y).toBe(28.35 + 25);
	});

	it('breaks after a dash between letters and keeps the dash', () => {
		const pdf = narrow();
		pdf.multiCell(70, 10, 'aaaaa-bbbbbbb');
		expect(texts(pdf).map(line => line.split(' ', 3)[2])).toEqual(['aaaaa-', 'bbbbbbb']);
	});

	it('does not break at a dash that starts or ends the text', () => {
		const pdf = narrow();
		pdf.multiCell(30, 10, '-abc-');
		expect(texts(pdf).map(line => line.split(' ', 3)[2])).toEqual(['-abc', '-']);
	});

	it('breaks inside a word without spaces, and before a word too long for the page', () => {
		const pdf = narrow();
		pdf.multiCell(40, 10, 'abcdefghij');
		expect(texts(pdf).map(line => line.split(' ', 3)[2])).toEqual(['abcdef', 'ghij']);
		const wide = narrow();
		wide.multiCell(40, 10, `ab ${'m'.repeat(200)}`);
		expect(texts(wide, 1)[0].split(' ').slice(2)).toEqual(['ab', 'm']);
		expect(texts(wide, 1)[1].split(' ', 3)[2]).toBe('mmm');
	});

	it('starts a new line at each newline, keeping empty lines', () => {
		const pdf = narrow();
		pdf.multiCell(200, 10, 'one\n\ntwo\n');
		expect(texts(pdf).map(line => line.split(' ', 3)[2])).toEqual(['one', 'two']);
		expect(pdf.y).toBe(28.35 + 37.5);
	});

	it('prints nothing when a character is wider than the column', () => {
		const pdf = narrow();
		pdf.multiCell(7, 10, 'W');
		expect(texts(pdf)).toEqual([]);
		expect(pdf.y).toBe(28.35);
	});

	it('writes a blank line for empty text and fills the rest of the line when no width is given', () => {
		const pdf = narrow();
		pdf.multiCell(0, 10, '');
		expect(texts(pdf)).toHaveLength(1);
		expect(pdf.y).toBe(28.35 + 12.5);
	});

	it('returns to the top right of the cell (ln 0) or moves below and right (ln 2)', () => {
		const pdf = narrow();
		pdf.setXY(100, 200);
		pdf.multiCell(50, 10, 'a', 'L', 0);
		expect([pdf.x, pdf.y]).toEqual([150, 200]);
		pdf.multiCell(50, 10, 'b', 'L', 2);
		expect([pdf.x, pdf.y]).toEqual([200, 212.5]);
	});
});

describe('pages', () => {
	class Decorated extends Tcpdf {
		headers = 0;
		bottom = 0;

		override header(): void {
			this.headers++;
			this.cell(0, 2000, 'head');
		}

		override footer(): void {
			this.setY(-10);
			this.cell(0, 30, 'foot');
		}

		protected override pageBreakY(): number {
			return this.bottom;
		}
	}

	it('breaks to a new page before a cell that would cross the bottom margin, keeping x', () => {
		const pdf = new Decorated('P', 'pt', 'A4');
		pdf.bottom = 77;
		pdf.addPage();
		pdf.setXY(50, pdf.getPageHeight() - 60);
		pdf.cell(10, 20, 'below');
		expect(pdf.page).toBe(2);
		expect(pdf.headers).toBe(2);
		expect(texts(pdf, 2).at(-1)).toMatch(/^52\.835000 [\d.]+ below$/);
		expect(pdf.y).toBe(77);
	});

	it('does not break while auto page breaks are off', () => {
		const pdf = report();
		pdf.setAutoPageBreak(false);
		pdf.setY(-5);
		pdf.cell(10, 100, 'x');
		expect(pdf.page).toBe(1);
	});

	it('reuses a page that already exists instead of adding one', () => {
		const pdf = report();
		pdf.addPage();
		pdf.page = 1;
		pdf.addPage();
		expect([pdf.pageNo(), pdf.numpages, pdf.y, pdf.x]).toEqual([2, 2, pdf.tMargin, pdf.lMargin]);
	});

	it('puts drawing on a finished page before its footer', () => {
		const pdf = new Decorated('P', 'pt', 'A4');
		pdf.addPage();
		pdf.addPage();
		pdf.page = 1;
		pdf.line(1, 2, 3, 4);
		const content = pdf.pages[1].content;
		expect(content.indexOf('1.000000 839.890000 m')).toBeLessThan(content.indexOf('(foot)'));
	});

	it('replaces the page aliases and custom aliases in every page', () => {
		const pdf = report();
		pdf.cell(0, 10, `${ALIAS_NUM_PAGE} of ${ALIAS_NB_PAGES} {00}`);
		pdf.setAlias('{00}', 'two');
		pdf.addPage();
		pdf.cell(0, 10, ALIAS_NUM_PAGE);
		const output = latin1(pdf.output(NOW));
		expect(output).toContain('(1 of 2 two)');
		expect(output).toContain('(2)');
	});
});

describe('drawing state', () => {
	it('positions from the far edge for negative coordinates and keeps them on the page', () => {
		const pdf = report();
		pdf.setXY(-100, -100);
		expect([pdf.x, pdf.y]).toEqual([pdf.getPageWidth() - 100, pdf.getPageHeight() - 100]);
		pdf.setXY(99999, -99999);
		expect([pdf.x, pdf.y]).toEqual([pdf.getPageWidth(), 0]);
		pdf.setY(10);
		pdf.ln(5);
		pdf.cell(10, 30, 'x');
		pdf.ln();
		expect(pdf.y).toBe(45);
	});

	it('writes gray and RGB colours, line widths, lines and rectangles in points', () => {
		const pdf = new Tcpdf('P', 'mm', 'A4');
		pdf.addPage();
		pdf.setDrawColor(0);
		pdf.setDrawColor(255, 0, 51);
		pdf.setLineWidth(1);
		pdf.rect(10, 10, 20, 5);
		pdf.setFont('B', 8);
		const content = pdf.pages[1].content;
		expect(content).toContain('0.000000 G\n1.000000 0.000000 0.200000 RG\n2.834646 w\n28.346457 813.543543 56.692913 -14.173228 re S\nBT /F2 8.000000 Tf ET');
		expect(pdf.getStringWidth('ab')).toBeCloseTo((675 + 716) * pdf.fontSize / 1000);
		pdf.setFont('');
		expect([pdf.fontStyle, pdf.fontSizePt]).toEqual(['', 8]);
	});
});

describe('outlines and document info', () => {
	it('nests bookmarks by level, never more than one level deeper than the last', () => {
		const pdf = report();
		pdf.bookmark('Tables');
		pdf.bookmark('players', 1);
		pdf.bookmark('id', 5);
		pdf.bookmark('name', 2);
		pdf.bookmark('Schema');
		const output = latin1(pdf.output(NOW));
		expect(output).toContain('/Outlines 7 0 R /PageMode /UseOutlines');
		expect(output).toContain('<< /Type /Outlines /First 8 0 R /Last 12 0 R >>');
		expect(output).toMatch(/8 0 obj\n<< \/Title <FEFF005400610062006C00650073> \/Parent 7 0 R \/Next 12 0 R \/First 9 0 R \/Last 9 0 R \/Count 0/);
		expect(output).toMatch(/10 0 obj\n<< \/Title [^/]+\/Parent 9 0 R \/Next 11 0 R \/Dest/);
		expect(output).toMatch(/11 0 obj\n<< \/Title [^/]+\/Parent 9 0 R \/Prev 10 0 R \/Dest/);
	});

	it('stores the title and author as UTF-16 text strings', () => {
		const pdf = report();
		pdf.title = 'Schéma 😀';
		pdf.author = 'phpMyAdmin';
		const output = latin1(pdf.output(NOW));
		expect(output).toContain('/Title <FEFF00530063006800E9006D00610020D83DDE00>');
		expect(output).toMatch(/xref\n0 \d+\n0000000000 65535 f \n/);
		expect(output.endsWith('%%EOF\n')).toBe(true);
	});
});

describe('number formatting', () => {
	it('prints %F with six decimals', () => {
		expect(fmt(1.5)).toBe('1.500000');
	});

	it('rounds exact ties to even like PHP\'s sprintf', () => {
		expect(phpFixed(184.5, 0)).toBe('184');
		expect(phpFixed(185.5, 0)).toBe('186');
		expect(phpFixed(-2.5, 0)).toBe('-2');
		expect(phpFixed(-3.5, 0)).toBe('-4');
		expect(phpFixed(0.125, 2)).toBe('0.12');
		expect(phpFixed(70.4, 0)).toBe('70');
		expect(phpFixed(20, 6)).toBe('20.000000');
	});
});

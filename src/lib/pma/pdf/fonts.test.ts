import { describe, expect, it } from 'vitest';

import { charWidth, listedWidth, toWinAnsi } from './fonts.ts';

describe('DejaVu metrics', () => {
	it('reads the regular and bold widths TCPDF lays text out with', () => {
		expect(charWidth('', 'a'.codePointAt(0) as number)).toBe(613);
		expect(charWidth('B', 'a'.codePointAt(0) as number)).toBe(675);
		expect(charWidth('', 0x4_16)).toBe(1077);
	});

	it('makes soft hyphens invisible and gives unlisted glyphs the default width', () => {
		expect(charWidth('', 173)).toBe(0);
		expect(listedWidth('', 0x4E_00)).toBeUndefined();
		expect(charWidth('', 0x4E_00)).toBe(600);
		expect(listedWidth('', 9)).toBeUndefined();
	});
});

describe('toWinAnsi', () => {
	it('keeps ASCII and Latin-1, maps the cp1252 extras and replaces the rest', () => {
		expect(toWinAnsi('A é € — 漢 \u{80}')).toBe('A \u{E9} \u{80} \u{97} ? ?');
	});
});

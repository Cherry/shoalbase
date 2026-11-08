// DejaVu Sans metrics (TCPDF's dejavusans.php and dejavusansb.php) for layout, and the WinAnsi bytes of the Helvetica faces that draw the text.
import data from './dejavu-widths.json' with { type: 'json' };

export type FontStyle = '' | 'B';

interface FontMetrics {
	dw: number;
	ranges: [number, (number | null)[]][];
}

const METRICS: Record<FontStyle, FontMetrics> = {
	'': data.regular as unknown as FontMetrics,
	'B': data.bold as unknown as FontMetrics,
};

/** Both faces share these descriptor values (Ascent 928, Descent -236). */
export const FONT_ASCENT = 928;
export const FONT_DESCENT = 236;

/** $CurrentFont['cw'][$codePoint] in font units, undefined where the font lists no width. */
export function listedWidth(style: FontStyle, codePoint: number): number | undefined {
	for (const [start, widths] of METRICS[style].ranges) {
		const width = widths[codePoint - start];
		if (width !== undefined && width !== null) {
			return width;
		}
	}
	return undefined;
}

/** TCPDF::getRawCharWidth() in font units: soft hyphens are invisible and unknown glyphs take the default width. */
export function charWidth(style: FontStyle, codePoint: number): number {
	if (codePoint === 173) {
		return 0;
	}
	return listedWidth(style, codePoint) ?? METRICS[style].dw;
}

// The code points cp1252 puts in 0x80-0x9F; the rest of Latin-1 maps to itself.
const WIN_ANSI_HIGH = [
	0x20_AC,
	-1,
	0x20_1A,
	0x01_92,
	0x20_1E,
	0x20_26,
	0x20_20,
	0x20_21,
	0x02_C6,
	0x20_30,
	0x01_60,
	0x20_39,
	0x01_52,
	-1,
	0x01_7D,
	-1,
	-1,
	0x20_18,
	0x20_19,
	0x20_1C,
	0x20_1D,
	0x20_22,
	0x20_13,
	0x20_14,
	0x02_DC,
	0x21_22,
	0x01_61,
	0x20_3A,
	0x01_53,
	-1,
	0x01_7E,
	0x01_78,
];

/** The text as WinAnsiEncoding bytes (one char per byte); characters Helvetica cannot show become "?". */
export function toWinAnsi(text: string): string {
	let result = '';
	for (const character of text) {
		const codePoint = character.codePointAt(0) as number;
		const high = WIN_ANSI_HIGH.indexOf(codePoint);
		if (high !== -1) {
			result += String.fromCodePoint(0x80 + high);
		} else if (codePoint < 0x80 || (codePoint >= 0xA0 && codePoint <= 0xFF)) {
			result += character;
		} else {
			result += '?';
		}
	}
	return result;
}

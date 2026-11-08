// Port of PhpMyAdmin\Font::getStringWidth(): the rough text width the schema exporters size tables with.

const CHAR_LISTS: [string[], number][] = [
	[['i', 'j', 'l'], 0.23],
	[['f'], 0.27],
	[['t', 'I'], 0.28],
	[['r'], 0.34],
	[['1'], 0.49],
	[['c', 'k', 's', 'v', 'x', 'y', 'z', 'J'], 0.5],
	[['a', 'b', 'd', 'e', 'g', 'h', 'n', 'o', 'p', 'q', 'u', 'L', '0', '2', '3', '4', '5', '6', '7', '8', '9'], 0.56],
	[['F', 'T', 'Z'], 0.61],
	[['A', 'B', 'E', 'K', 'P', 'S', 'V', 'X', 'Y'], 0.67],
	[['w', 'C', 'D', 'H', 'N', 'R', 'U'], 0.73],
	[['G', 'O', 'Q'], 0.78],
	[['m', 'M'], 0.84],
	[['W'], 0.95],
	[[' '], 0.28],
];

const FONT_MODIFIERS: Record<string, number> = {
	'times': 0.92,
	'serif': 0.92,
	'brushscriptstd': 0.92,
	'californian fb': 0.92,
	'broadway': 1.23,
};

/** Font::getStringWidth() with the default character lists. */
export function getStringWidth(text: string, font: string, fontSize: number): number {
	const characters = [...text];
	let count = 0;
	for (const [chars, modifier] of CHAR_LISTS) {
		count += characters.filter(character => chars.includes(character)).length * modifier;
	}
	count += characters.filter(character => character !== ' ' && !/[a-z0-9]/i.test(character)).length * 0.3;
	const modifier = FONT_MODIFIERS[font.toLowerCase()] ?? 1;
	return Math.ceil(count * fontSize * modifier);
}

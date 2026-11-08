// PHP's json_encode() with default flags, whose escaping differs from JSON.stringify().

function escapeUnit(unit: number): string {
	return String.raw`\u${unit.toString(16).padStart(4, '0')}`;
}

/** PHP's php_gcvt() switches to exponent form below 1e-4 and always keeps a fraction digit, as in 8.2e-5 and 1.0e-5. */
function phpNumber(token: string): string {
	const value = Number(token);
	if (value === 0 || Math.abs(value) >= 1e-4) {
		return token;
	}
	const [mantissa, exponent] = value.toExponential().split('e', 2);
	return `${mantissa.includes('.') ? mantissa : `${mantissa}.0`}e${exponent}`;
}

/** Rewrites the numbers of JSON text the way PHP's json_encode() prints floats, leaving strings untouched. */
export function phpJsonNumbers(json: string): string {
	return json.replaceAll(/"(?:[^"\\]|\\.)*"|-?\d[\d.e+-]*/gi, token => (token.startsWith('"') ? token : phpNumber(token)));
}

/**
 * json_encode($value): escapes "/" and non-ASCII as lowercase \uXXXX, using surrogate pairs above U+FFFF.
 * `pretty` is JSON_PRETTY_PRINT, which indents with four spaces like JSON.stringify().
 */
export function phpJsonEncode(value: unknown, pretty = false): string {
	let encoded = '';
	for (const character of JSON.stringify(value, null, pretty ? 4 : undefined)) {
		const codePoint = character.codePointAt(0) as number;
		if (character === '/') {
			encoded += String.raw`\/`;
		} else if (codePoint < 0x80) {
			encoded += character;
		} else if (codePoint < 0x1_00_00) {
			encoded += escapeUnit(codePoint);
		} else {
			const offset = codePoint - 0x1_00_00;
			encoded += escapeUnit(0xD8_00 + Math.floor(offset / 0x4_00)) + escapeUnit(0xDC_00 + (offset % 0x4_00));
		}
	}
	return phpJsonNumbers(encoded);
}

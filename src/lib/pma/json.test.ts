import { describe, expect, it } from 'vitest';

import { phpJsonEncode } from './json';

// Built from code points so the expectations show exactly which escapes PHP emits.
const ellipsis = String.fromCodePoint(0x20_26);
const emoji = String.fromCodePoint(0x1_F6_00);
const del = String.fromCodePoint(0x7F);
const escaped = (hex: string): string => String.raw`\u${hex}`;

describe('phpJsonEncode', () => {
	it('escapes slashes and non-ASCII like PHP json_encode()', () => {
		expect(phpJsonEncode({ path: 'Primary Key/Index', text: `Loading${ellipsis}`, emoji, del }))
			.toBe(String.raw`{"path":"Primary Key\/Index","text":"Loading${escaped('2026')}","emoji":"${escaped('d83d')}${escaped('de00')}","del":"${del}"}`);
	});

	it('keeps JSON.stringify escapes for quotes and control characters', () => {
		expect(phpJsonEncode(['"a"\n', true, 1])).toBe(String.raw`["\"a\"\n",true,1]`);
	});

	it('prints floats below 1e-4 in PHP exponent form and leaves strings alone', () => {
		expect(phpJsonEncode({ a: 0.000082, b: 0.00001, c: -0.0000005, d: 0.000104, e: 0, f: '8.2e-5', g: 'x 0.00001' }))
			.toBe('{"a":8.2e-5,"b":1.0e-5,"c":-5.0e-7,"d":0.000104,"e":0,"f":"8.2e-5","g":"x 0.00001"}');
	});

	it('indents with four spaces for JSON_PRETTY_PRINT', () => {
		expect(phpJsonEncode({ 'Server/hide_db': '', '2fa': { settings: [] } }, true))
			.toBe('{\n    "Server\\/hide_db": "",\n    "2fa": {\n        "settings": []\n    }\n}');
	});
});

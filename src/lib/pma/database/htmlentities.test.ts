import { describe, expect, it } from 'vitest';

import { htmlentities } from './htmlentities.ts';

describe('htmlentities', () => {
	it('escapes the special characters, quotes included', () => {
		expect(htmlentities('<a href="x">\'&')).toBe('&lt;a href=&quot;x&quot;&gt;&#039;&amp;');
	});

	it('names Latin-1, Greek and symbol characters like PHP', () => {
		expect(htmlentities('café ñ ÿ \u{A0}')).toBe('caf&eacute; &ntilde; &yuml; &nbsp;');
		expect(htmlentities('ΑΩαςσω')).toBe('&Alpha;&Omega;&alpha;&sigmaf;&sigma;&omega;');
		expect(htmlentities('€—≤♦Œ')).toBe('&euro;&mdash;&le;&diams;&OElig;');
	});

	it('leaves characters without a named entity alone', () => {
		expect(htmlentities('΢ ł 日本 😀')).toBe('΢ ł 日本 😀');
	});
});

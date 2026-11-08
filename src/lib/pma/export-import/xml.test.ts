import { describe, expect, it } from 'vitest';

import {
	attributeOf,
	childNamed,
	childrenOf,
	directText,
	parseXml,
	usesPrefix,
} from './xml.ts';

import type { XmlElement } from './xml.ts';

// The element, failing the test when it is missing.
function must(element: XmlElement | null | undefined): XmlElement {
	if (element === null || element === undefined) {
		throw new Error('missing element');
	}
	return element;
}

describe('parseXml', () => {
	const document = `<?xml version="1.0"?>\r\n<!DOCTYPE r [<!ELEMENT r ANY>]><!-- note -->
<r xmlns:t="urn:t" t:name="a&amp;b" plain='x&#10;y&#x41;'>
	<t:row><t:cell>one <t:span>two</t:span> three</t:cell><t:cell/></t:row>
	<other><![CDATA[<raw> & text]]></other>
</r>`;

	it('reads elements, prefixed names, attributes, entities and CDATA', () => {
		const root = must(parseXml(document));
		expect(root.name).toBe('r');
		expect(attributeOf(root, 't', 'name')).toBe('a&b');
		expect(attributeOf(root, null, 'plain')).toBe('x\nyA');
		expect(attributeOf(root, null, 'missing')).toBe('');
		const row = must(childNamed(root, 't', 'row'));
		expect(childrenOf(row, 't').map(cell => cell.localName)).toEqual(['cell', 'cell']);
		expect(directText(childrenOf(row, 't')[0])).toBe('one  three');
		expect(directText(must(childNamed(root, null, 'other')))).toBe('<raw> & text');
		expect(childNamed(root, 't', 'other')).toBeUndefined();
	});

	it('allows whitespace after the root element', () => {
		expect(parseXml('<a/>\n')?.name).toBe('a');
	});

	it('lists a prefix only when it is declared and used', () => {
		const root = must(parseXml(document));
		expect(usesPrefix(root, 't')).toBe(true);
		expect(usesPrefix(must(parseXml('<a xmlns:p="u"><b/></a>')), 'p')).toBe(false);
		expect(usesPrefix(must(parseXml('<a><p:b/></a>')), 'p')).toBe(false);
	});

	it.each([
		['', 'no root'],
		['<a><b></a>', 'mismatched tags'],
		['<a>', 'unclosed root'],
		['<a/>junk', 'text after the root'],
		['<a/><b/>', 'two roots'],
		['<a>&nbsp;</a>', 'an undefined entity'],
		['<a>&#0;</a>', 'a forbidden character reference'],
		['<a>&#xZZ;</a>', 'a bad hexadecimal reference'],
		['<a>&#x110000;</a>', 'a reference past Unicode'],
		['<a>&#xD800;</a>', 'a surrogate reference'],
		['<a>&</a>', 'a bare ampersand'],
		['<a x="1" x="2"/>', 'a repeated attribute'],
		['<a x="<"/>', 'a less-than sign in an attribute'],
		['<a x="1/>', 'an unterminated attribute'],
		['<a x=1/>', 'an unquoted attribute'],
		['<1a/>', 'a bad element name'],
		['<a><!-- open</a>', 'an unterminated comment'],
		['<a><![CDATA[open</a>', 'unterminated CDATA'],
		['<![CDATA[x]]><a/>', 'CDATA outside the root'],
		['<a><!DOCTYPE a></a>', 'a declaration inside the root'],
		['<!DOCTYPE a [', 'an unterminated declaration'],
		['<?xml version="1.0"', 'an unterminated declaration of XML'],
	])('rejects %j (%s), as simplexml_load_string() does', (source) => {
		expect(parseXml(source)).toBeNull();
	});
});

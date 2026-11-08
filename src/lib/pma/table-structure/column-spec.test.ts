import { describe, expect, it } from 'vitest';

import {
	convertBitDefaultValue,
	escapeCompat,
	extractColumnSpec,
	isForeignKeySupportedEngine,
	parseEnumSetValues,
	strGetCsv,
} from './column-spec.ts';

describe('escapeCompat', () => {
	it('escapes double quotes but keeps single quotes like ENT_COMPAT', () => {
		expect(escapeCompat('<a href="x">it\'s & more</a>')).toBe('&lt;a href=&quot;x&quot;&gt;it\'s &amp; more&lt;/a&gt;');
	});
});

describe('strGetCsv', () => {
	it('splits quoted values, keeping escapes and folding doubled quotes', () => {
		expect(strGetCsv(String.raw`'a','b''c','d\'e'`)).toEqual(['a', 'b\'c', String.raw`d\'e`]);
	});

	it('skips whitespace before an opening quote and keeps unquoted text', () => {
		expect(strGetCsv('\'a\',  \'b\',c')).toEqual(['a', 'b', 'c']);
		expect(strGetCsv('plain')).toEqual(['plain']);
	});

	it('keeps text after a closing quote and an unterminated quote', () => {
		expect(strGetCsv('\'a\'x,\'b')).toEqual(['ax', 'b']);
	});
});

describe('parseEnumSetValues', () => {
	it('reads the values in brackets and unescapes doubled backslashes', () => {
		expect(parseEnumSetValues(String.raw`enum('a','b''c','d\\e')`, false)).toEqual(['a', 'b\'c', String.raw`d\e`]);
	});

	it('escapes HTML by default', () => {
		expect(parseEnumSetValues('set(\'<x>\',\'y\')')).toEqual(['&lt;x&gt;', 'y']);
	});

	it('returns one empty value without brackets', () => {
		expect(parseEnumSetValues('int')).toEqual(['']);
	});
});

describe('convertBitDefaultValue', () => {
	it('strips the b\'...\' wrapper after decoding entities', () => {
		expect(convertBitDefaultValue('b\'101\'')).toBe('101');
		expect(convertBitDefaultValue('b&#039;11&#039;')).toBe('11');
		expect(convertBitDefaultValue('b&#39;1')).toBe('1');
	});

	it('leaves other values and treats null as empty', () => {
		expect(convertBitDefaultValue('&lt;&gt;&amp;&quot;')).toBe('<>&"');
		expect(convertBitDefaultValue(null)).toBe('');
	});
});

describe('extractColumnSpec', () => {
	it('splits the type and its bracketed spec and flags unsigned zerofill', () => {
		const spec = extractColumnSpec('int(10) unsigned zerofill');
		expect(spec).toMatchObject({
			type: 'int',
			spec_in_brackets: '10',
			print_type: 'int(10)',
			unsigned: true,
			zerofill: true,
			attribute: 'UNSIGNED ZEROFILL',
			can_contain_collation: false,
			displayed_type: 'int(10)',
		});
	});

	it('lists enum values and spaces them in the printed type', () => {
		const spec = extractColumnSpec('enum(\'a\',\'b\')');
		expect(spec.enum_set_values).toEqual(['a', 'b']);
		expect(spec.print_type).toBe('enum(\'a\', \'b\')');
		expect(spec.can_contain_collation).toBe(true);
		expect(spec.attribute).toBe(' ');
	});

	it('treats a binary attribute apart from the binary types', () => {
		expect(extractColumnSpec('varchar(5) binary')).toMatchObject({ binary: true, attribute: 'BINARY', can_contain_collation: false, print_type: 'varchar(5)' });
		expect(extractColumnSpec('varbinary(10)')).toMatchObject({ binary: false, print_type: 'varbinary(10)' });
	});

	it('reports the MariaDB compressed attribute', () => {
		expect(extractColumnSpec('text /*!100301 COMPRESSED*/').attribute).toBe('COMPRESSED=zlib');
	});

	it('takes the first word as the type without brackets', () => {
		expect(extractColumnSpec('TEXT CHARACTER SET utf8')).toMatchObject({ type: 'text', spec_in_brackets: '' });
	});

	it('gives an empty spec when the closing bracket is missing, like mb_substr() with a negative length', () => {
		expect(extractColumnSpec('decimal(10,2').spec_in_brackets).toBe('');
	});

	it('abbreviates a printed type longer than LimitChars', () => {
		expect(extractColumnSpec('varchar(255)', 5).displayed_type).toBe('<abbr title="varchar(255)">varch...</abbr>');
	});
});

describe('isForeignKeySupportedEngine', () => {
	it('accepts InnoDB and PBXT in any case only', () => {
		expect(isForeignKeySupportedEngine('innodb')).toBe(true);
		expect(isForeignKeySupportedEngine('PBXT')).toBe(true);
		expect(isForeignKeySupportedEngine('MyISAM')).toBe(false);
	});
});

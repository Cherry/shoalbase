import { describe, expect, it } from 'vitest';

import {
	type ServerKind,
	getAttributes,
	getColumnTypes,
	getSupportedDatatypesHtml,
	getSupportedDatatypesList,
	getTypeDescription,
	isCompatibleRenameIndex,
	isIntegersSupportLength,
	isUUIDSupported,
	isVirtualColumnsSupported,
	supportsStoredKeywordForVirtualColumns,
} from './types.ts';

const mysql8: ServerKind = { type: 'MySQL', version: 80400 };
const mysql57: ServerKind = { type: 'MySQL', version: 50744 };
const mysql56: ServerKind = { type: 'MySQL', version: 50600 };
const maria12: ServerKind = { type: 'MariaDB', version: 120300 };
const maria10: ServerKind = { type: 'MariaDB', version: 100100 };

describe('compatibility checks', () => {
	it('follows the server type and version thresholds', () => {
		expect([isUUIDSupported(maria12), isUUIDSupported(maria10), isUUIDSupported(mysql8)]).toEqual([true, false, false]);
		expect([isVirtualColumnsSupported(maria10), isVirtualColumnsSupported(mysql57), isVirtualColumnsSupported(mysql56)]).toEqual([true, true, false]);
		expect([supportsStoredKeywordForVirtualColumns(maria10), supportsStoredKeywordForVirtualColumns(maria12), supportsStoredKeywordForVirtualColumns(mysql57)]).toEqual([false, true, true]);
		expect([isCompatibleRenameIndex(maria10), isCompatibleRenameIndex(maria12), isCompatibleRenameIndex(mysql57), isCompatibleRenameIndex(mysql56)]).toEqual([false, true, true, false]);
	});

	it('restricts integer display widths on MySQL 8.0.18+', () => {
		expect(isIntegersSupportLength('INT', '11', mysql8)).toBe(false);
		expect(isIntegersSupportLength('TINYINT', '1', mysql8)).toBe(true);
		expect(isIntegersSupportLength('TINYINT', '2', mysql8)).toBe(false);
		expect(isIntegersSupportLength('INT', '11', mysql57)).toBe(true);
		expect(isIntegersSupportLength('VARCHAR', '11', mysql8)).toBe(true);
	});
});

describe('getAttributes', () => {
	it('adds zlib compression on MariaDB 10.1+', () => {
		expect(getAttributes(mysql8)).not.toContain('COMPRESSED=zlib');
		expect(getAttributes(maria10)).toContain('COMPRESSED=zlib');
	});
});

describe('getColumnTypes', () => {
	it('adds UUID, INET6 and JSON by server', () => {
		const maria = getColumnTypes(maria12);
		expect(maria.slice(0, 5)).toEqual(['INT', 'VARCHAR', 'TEXT', 'DATE', 'UUID']);
		expect(maria.at(-1)).toEqual(['UUID', ['UUID']]);
		expect(JSON.stringify(maria)).toContain('INET6');
		expect(JSON.stringify(getColumnTypes(mysql8))).toContain('["JSON",["JSON"]]');
		expect(JSON.stringify(getColumnTypes(mysql56))).not.toContain('JSON');
		expect(JSON.stringify(getColumnTypes(maria10))).not.toContain('JSON');
	});
});

describe('getTypeDescription', () => {
	it('looks types up case-insensitively', () => {
		expect(getTypeDescription('date')).toBe('A date, supported range is 1000-01-01 to 9999-12-31');
		expect(getTypeDescription('nope')).toBe('');
	});
});

describe('getSupportedDatatypesHtml', () => {
	it('renders options with separators and the selected type', () => {
		const html = getSupportedDatatypesHtml(mysql8, 'VARCHAR');
		expect(html.startsWith('<option data-length-restricted="1"  title="A 4-byte integer')).toBe(true);
		expect(html).toContain('<option data-length-restricted="0" selected="selected" title="A variable-length (0-65,535) string, the effective maximum length is subject to the maximum row size">VARCHAR</option>');
		expect(html).toContain('<optgroup label="Date and time">');
		expect(html).toContain('<option disabled="disabled">-</option>');
	});
});

describe('getSupportedDatatypesList', () => {
	it('flattens the groups without separators', () => {
		const list = getSupportedDatatypesList(mysql8);
		expect(list.slice(0, 5)).toEqual(['INT', 'VARCHAR', 'TEXT', 'DATE', 'TINYINT']);
		expect(list).not.toContain('-');
	});
});

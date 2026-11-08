import { describe, expect, it } from 'vitest';

import { getImportList, getImportPlugin } from './import-plugins.ts';
import { type OptionsGroup, OptionsItem } from './properties.ts';

const param = (importType: string) => { return { importType, columnsHint: '<hint>' }; };

// The names of a plugin's general options, in order.
function optionNames(importType: string, format: string): (string | null)[] {
	const plugin = getImportPlugin(format, param(importType));
	const general = plugin?.properties.options?.properties[0] as OptionsGroup;
	return general.properties.map(item => (item instanceof OptionsItem ? item.name : null));
}

describe('getImportList', () => {
	it('sorts by display name and offers LOAD DATA only on a table', () => {
		expect(getImportList(param('database')).map(plugin => plugin.name)).toEqual(['csv', 'shp', 'mediawiki', 'ods', 'sql', 'xml']);
		expect(getImportList(param('table')).map(plugin => plugin.name)).toEqual(['csv', 'ldi', 'shp', 'mediawiki', 'ods', 'sql', 'xml']);
	});
});

describe('CSV options per import type', () => {
	it('asks for a column list on a table and for new table and database names elsewhere', () => {
		expect(optionNames('table', 'csv')).toEqual(['replace', 'terminated', 'enclosed', 'escaped', 'new_line', 'partial_import', 'columns', 'ignore']);
		expect(optionNames('database', 'csv')).toEqual(['replace', 'terminated', 'enclosed', 'escaped', 'new_line', 'new_tbl_name', 'partial_import', 'col_names', 'ignore']);
		expect(optionNames('server', 'csv')).toContain('new_db_name');
	});

	it('puts the hint after the column label', () => {
		const plugin = getImportPlugin('CSV', param('table'));
		const general = plugin?.properties.options?.properties[0] as OptionsGroup;
		expect((general.properties[6] as OptionsItem).text).toBe('Column names: <hint>');
	});
});

describe('getImportPlugin', () => {
	it('finds formats case-insensitively and refuses LOAD DATA outside a table or unknown names', () => {
		expect(getImportPlugin('SQL', param('server'))?.properties.extension).toBe('sql');
		expect(getImportPlugin('ldi', param('database'))).toBeNull();
		expect(getImportPlugin('pdf', param('table'))).toBeNull();
	});
});

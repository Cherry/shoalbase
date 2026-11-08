import { describe, expect, it } from 'vitest';

import { type ExportPluginParam, getExportList, getExportPlugin } from './export-plugins.ts';
import { type PluginInfo, getOptions } from './properties.ts';

const param = (overrides: Partial<ExportPluginParam> = {}): ExportPluginParam => { return { exportType: 'server', singleTable: false, rawQuery: false, isView: false, db: '', ...overrides }; };

describe('getExportList', () => {
	it('sorts by display name and leaves XML out of a server export', () => {
		expect(getExportList(param()).map(plugin => plugin.properties.text)).toEqual([
			'CodeGen',
			'CSV',
			'CSV for MS Excel',
			'JSON',
			'LaTeX',
			'MediaWiki Table',
			'Microsoft Word 2000',
			'OpenDocument Spreadsheet',
			'OpenDocument Text',
			'PDF',
			'PHP array',
			'SQL',
			'Texy! text',
			'YAML',
		]);
		expect(getExportList(param({ exportType: 'database', db: 'shop' })).map(plugin => plugin.name)).toContain('xml');
	});
});

describe('getExportPlugin', () => {
	it('returns null for unknown formats and accepts any case', () => {
		expect(getExportPlugin('nope', param())).toBeNull();
		expect(getExportPlugin('SQL', param())?.name).toBe('sql');
	});

	it('hides the SQL options for a table export opened without single_table, unless it is a raw query', () => {
		expect(getExportPlugin('sql', param({ exportType: 'table' }))?.properties.options).toBeNull();
		expect(getExportPlugin('sql', param({ exportType: 'table', rawQuery: true }))?.properties.options).not.toBeNull();
	});

	it('names the drop statements after the export level', () => {
		const request = { get: {}, request: {}, timeoutPassed: false, section: {} };
		const html = (overrides: Partial<ExportPluginParam>): string => getOptions(request, [getExportPlugin('sql', param(overrides)) as PluginInfo]);
		expect(html({})).toContain('Add <code>DROP DATABASE IF EXISTS</code> statement');
		expect(html({ exportType: 'database' })).toContain('Add <code>CREATE DATABASE / USE</code> statement');
		expect(html({ exportType: 'table', singleTable: true })).toContain('Add <code>DROP TABLE</code><code> / TRIGGER</code> statement');
		expect(html({ exportType: 'table', singleTable: true, isView: true })).toContain('Add <code>DROP VIEW</code><code> / TRIGGER</code> statement');
	});

	it('drops the LaTeX and OpenDocument structure options for a multi-table table export', () => {
		const request = { get: {}, request: {}, timeoutPassed: false, section: {} };
		for (const format of ['latex', 'odt']) {
			expect(getOptions(request, [getExportPlugin(format, param({ exportType: 'table' })) as PluginInfo])).not.toContain(`id="${format}_structure"`);
			expect(getOptions(request, [getExportPlugin(format, param({ exportType: 'table', singleTable: true })) as PluginInfo])).toContain(`id="${format}_structure"`);
		}
	});
});

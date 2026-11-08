import { describe, expect, it } from 'vitest';

import {
	type ConfigForm,
	applyUserPreferences,
	arrayRead,
	arrayWrite,
	fieldInfo,
	itemPath,
	jsDefaultLine,
	jsValidateLines,
	pageForms,
	readPostedForms,
	replaceRecursive,
	strictEquals,
	userForms,
	userPreferencesToSave,
	validateValues,
} from './config-forms.ts';
import { createConfig } from './config.ts';

const form = (name: string, fields: ConfigForm['fields']): ConfigForm => {
	return { name, title: name, desc: '', fields };
};

describe('form definitions', () => {
	it('lists the page settings groups and user preference tabs upstream defines', () => {
		expect(pageForms('Navi')?.map(item => item.name)).toEqual(['Navi_panel', 'Navi_tree', 'Navi_servers', 'Navi_databases', 'Navi_tables']);
		expect(pageForms('Edit')?.map(item => item.name)).toEqual(['Edit', 'Text_fields']);
		expect(pageForms('Startup')).toBeNull();
		expect(userForms('Main')?.map(item => item.name)).toContain('DbStructure');
		expect(userForms('Nope')).toBeNull();
	});

	it('types fields like Form::readTypes() and keeps sanitized descriptions', () => {
		expect(fieldInfo('MaxRows')).toMatchObject({ type: 'select', default: 25, validators: [['validatePositiveNumber']] });
		expect(fieldInfo('NavigationLogoLinkWindow').desc).toContain('<code>main</code>');
		expect(fieldInfo('Export/charset').doc).toBe('');
		expect(fieldInfo('ForeignKeyDropdownOrder').type).toBe('list');
	});

	it('tells field paths from group markers', () => {
		expect(itemPath('MaxRows')).toBe('MaxRows');
		expect(itemPath({ path: 'Export/asfile', setvalue: ':group' })).toBe('Export/asfile');
		expect(itemPath({ group: 'end' })).toBeNull();
	});
});

describe('config paths', () => {
	it('reads and writes slash-separated paths like Core::arrayRead() and arrayWrite()', () => {
		const target: Record<string, unknown> = { Export: { format: 'sql' }, flat: 1 };
		expect(arrayRead('Export/format', target)).toBe('sql');
		expect(arrayRead('Export/missing', target, 'x')).toBe('x');
		expect(arrayRead('flat/deeper', target)).toBeNull();
		arrayWrite('Import/charset', target, 'latin1');
		arrayWrite('flat/inner', target, 2);
		expect(target).toEqual({ Export: { format: 'sql' }, flat: { inner: 2 }, Import: { charset: 'latin1' } });
	});

	it('merges nested overlays and replaces scalars and lists', () => {
		const target: Record<string, unknown> = { Export: { format: 'sql', charset: '' }, ForeignKeyDropdownOrder: ['a', 'b'] };
		replaceRecursive(target, { Export: { format: 'csv' }, ForeignKeyDropdownOrder: ['c'] });
		expect(target).toEqual({ Export: { format: 'csv', charset: '' }, ForeignKeyDropdownOrder: ['c'] });
	});

	it('compares like PHP ===, including key order and types', () => {
		expect(strictEquals([1, 2], [1, 2])).toBe(true);
		expect(strictEquals([1, 2], [2, 1])).toBe(false);
		expect(strictEquals([1], [1, 2])).toBe(false);
		expect(strictEquals({ a: 1 }, { b: 1 })).toBe(false);
		expect(strictEquals('1', 1)).toBe(false);
		expect(strictEquals(null, {})).toBe(false);
	});
});

describe('applyUserPreferences', () => {
	it('keeps allowed paths only, minus UserprefsDisallow', () => {
		const overlay = applyUserPreferences({ 'MaxRows': 50, 'Export/format': 'csv', 'ThemeDefault': 'metro', 'ShowSQL': false, 'blowfish_secret': 'x' }, ['ShowSQL']);
		expect(overlay).toEqual({ MaxRows: 50, Export: { format: 'csv' }, ThemeDefault: 'metro' });
	});
});

describe('JavaScript defaults and validators', () => {
	it('writes default values the way FormDisplay::displayFieldInput() does per type', () => {
		expect(jsDefaultLine('ShowAll', fieldInfo('ShowAll'))).toBe('\'ShowAll\': false');
		expect(jsDefaultLine('BrowsePointerEnable', fieldInfo('BrowsePointerEnable'))).toBe('\'BrowsePointerEnable\': true');
		expect(jsDefaultLine('MaxRows', fieldInfo('MaxRows'))).toBe('\'MaxRows\': [\'25\']');
		expect(jsDefaultLine('Export/format', fieldInfo('Export/format'))).toBe('\'Export-format\': [\'sql\']');
		expect(jsDefaultLine('LimitChars', fieldInfo('LimitChars'))).toBe('\'LimitChars\': \'50\'');
		expect(jsDefaultLine('DefaultTransformations/Inline', fieldInfo('DefaultTransformations/Inline'))).toBe(String.raw`'DefaultTransformations-Inline': '100\n100\n'`);
		expect(jsDefaultLine('DefaultTransformations/External', fieldInfo('DefaultTransformations/External'))).toBe(String.raw`'DefaultTransformations-External': '0\n-f /dev/null -i -wrap -q\n1\n1'`);
		expect(jsDefaultLine('x', { type: 'select', name: '', desc: '', cmt: '', doc: '', default: true })).toBe('\'x\': [\'1\']');
		expect(jsDefaultLine('y', { type: 'list', name: '', desc: '', cmt: '', doc: '', default: [true, false, null] })).toBe(String.raw`'y': '1\n\n'`);
	});

	it('registers validators with their escaped arguments', () => {
		expect(jsValidateLines('QueryHistoryMax', [['validatePositiveNumber'], ['validateUpperBound', 25]])).toEqual([
			'registerFieldValidator(\'QueryHistoryMax\', \'validatePositiveNumber\', true)',
			'registerFieldValidator(\'QueryHistoryMax\', \'validateUpperBound\', true, [\'25\'])',
		]);
	});
});

describe('readPostedForms', () => {
	it('casts posted values by type and treats missing checkboxes as off', () => {
		const forms = [form('Browse', ['ShowAll', 'MaxRows', 'RepeatCells', 'Order', 'ForeignKeyDropdownOrder', 'NavigationLogoLink', { group: 'header', text: 'x' }, { group: 'end' }])];
		const { values, errors } = readPostedForms(forms, {
			MaxRows: '50',
			RepeatCells: '12abc',
			Order: 'DESC',
			ForeignKeyDropdownOrder: 'id-content\n\ncontent-id',
			NavigationLogoLink: 'https://example.com',
		});
		expect(errors.size).toBe(0);
		expect(Object.fromEntries(values)).toEqual({
			ShowAll: false,
			MaxRows: 50,
			RepeatCells: 12,
			Order: 'DESC',
			ForeignKeyDropdownOrder: ['id-content', 'content-id'],
			NavigationLogoLink: 'https://example.com',
		});
	});

	it('casts checkbox, empty integer and list-array posts as settype() would', () => {
		const { values } = readPostedForms([form('f', ['ShowAll', 'LimitChars', 'ForeignKeyDropdownOrder', 'BrowsePointerEnable', 'RepeatCells', 'ShowSQL'])], {
			ShowAll: 'on',
			LimitChars: '',
			ForeignKeyDropdownOrder: ['a', '', 'b'],
			BrowsePointerEnable: '0',
			RepeatCells: 'abc',
			ShowSQL: '',
		});
		expect(Object.fromEntries(values)).toEqual({ ShowAll: true, LimitChars: '', ForeignKeyDropdownOrder: ['a', 'b'], BrowsePointerEnable: false, RepeatCells: 0, ShowSQL: '' });
	});

	it('reports missing fields by form and unknown select options by field', () => {
		const { values, errors } = readPostedForms([form('Navi_panel', ['NavigationLogoLink', 'NavigationLogoLinkWindow', 'MaxRows'])], {
			NavigationLogoLinkWindow: 'elsewhere',
			MaxRows: ['25'],
		});
		expect(Object.fromEntries(errors)).toEqual({
			Navi_panel: ['Missing data for <i>Logo link URL</i>'],
			NavigationLogoLinkWindow: ['Incorrect value!'],
			MaxRows: ['Incorrect value!'],
		});
		expect(values.size).toBe(0);
	});

	it('matches select options loosely only between numbers, and keeps the option key type', () => {
		const posted = readPostedForms([form('f', ['MaxRows', 'ProtectBinary', 'Import/ldi_local_option'])], { 'MaxRows': '050', 'ProtectBinary': 'blob', 'Import-ldi_local_option': '1' });
		expect(Object.fromEntries(posted.values)).toEqual({ 'MaxRows': 50, 'ProtectBinary': 'blob', 'Import/ldi_local_option': 1 });
		expect(readPostedForms([form('f', ['ProtectBinary'])], { ProtectBinary: '0' }).values.get('ProtectBinary')).toBe(0);
	});
});

describe('validateValues', () => {
	it('applies upstream number, bound and regex validators', () => {
		const errors = validateValues(new Map<string, unknown>([
			['MaxRows', -5],
			['RepeatCells', 0],
			['LimitChars', 0],
			['QueryHistoryMax', 30],
			['Import/csv_terminated', ';;'],
			['Import/csv_enclosed', ''],
			['TextareaCols', 2.5],
			['Servers/1/hide_db', '('],
			['ShowAll', true],
			['MaxDbList', 50],
		]));
		expect(Object.fromEntries(errors)).toEqual({
			'MaxRows': ['Not a positive number!'],
			'QueryHistoryMax': ['Value must be less than or equal to 25!'],
			'Import/csv_terminated': ['Incorrect value!'],
		});
		expect(validateValues(new Map<string, unknown>([['Import/csv_escaped', null]])).size).toBe(0);
	});
});

describe('userPreferencesToSave', () => {
	it('stores allowed values that differ from the defaults or the server configuration', () => {
		const base = createConfig({ host: 'h' }) as unknown as Record<string, unknown>;
		const config = structuredClone(base);
		arrayWrite('MaxRows', config, 50);
		arrayWrite('Export/format', config, 'csv');
		arrayWrite('Server/hide_db', config, '^x');
		delete config.LimitChars;
		const saved = userPreferencesToSave(config, base);
		expect(saved).toMatchObject({ 'MaxRows': 50, 'Export/format': 'csv', 'Server/hide_db': '^x', 'ShowServerInfo': false });
		expect(saved).not.toHaveProperty('LimitChars');
		expect(saved).not.toHaveProperty('blowfish_secret');
	});

	it('drops lists emptied in a form, which upstream flattens away', () => {
		const base = createConfig({ host: 'h' }) as unknown as Record<string, unknown>;
		const config = structuredClone(base);
		arrayWrite('Server/only_db', config, []);
		expect(userPreferencesToSave(config, base)).not.toHaveProperty('Server/only_db');
		arrayWrite('Server/only_db', config, ['a']);
		expect(userPreferencesToSave(config, base)).toHaveProperty('Server/only_db', ['a']);
	});
});

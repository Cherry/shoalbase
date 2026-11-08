import { describe, expect, it } from 'vitest';

import {
	UserConfigFile,
	castFieldValue,
	fixErrors,
	flattenConfig,
	saveForms,
} from './user-config.ts';
import { fieldInfo, userForms } from '../config-forms.ts';
import { createConfig } from '../config.ts';

import type { ConfigForm } from '../config-forms.ts';

const base = (): Record<string, unknown> => createConfig({ host: 'h' }) as unknown as Record<string, unknown>;
const allowed = new Set(['MaxRows', 'NaturalOrder', 'Servers/1/hide_db', 'Servers/1/only_db', 'Export/format', 'Export/charset', 'MaxDbList', 'ShowServerInfo']);

describe('flattenConfig', () => {
	it('keeps lists whole and splits maps, dropping empty arrays and splitting lists that start with null', () => {
		const flat = flattenConfig({ a: { b: 1, c: [] }, d: ['x'], e: [null, 2], f: { 0: 'k', g: 1 }, h: new Map([['i', 3]]) });
		expect([...flat]).toEqual([['a/b', 1], ['d', ['x']], ['e/0', null], ['e/1', 2], ['f', { 0: 'k', g: 1 }], ['h/i', 3]]);
	});

	it('keeps a flat path over the same path from a later nested array, like PHP\'s array union', () => {
		expect([...flattenConfig({ 'a/b': 1, 'a': { b: 2, c: 3 } })]).toEqual([['a/b', 1], ['a/c', 3]]);
	});
});

describe('UserConfigFile', () => {
	it('stores values that differ from the default or whose base config differs, in insertion order', () => {
		const cf = new UserConfigFile(base(), allowed);
		cf.updateWithGlobalConfig({ ...base(), MaxRows: 50 });
		cf.set('Export/format', 'csv');
		cf.set('NaturalOrder', true);
		cf.set('Unknown', 1);
		// Production turns ShowServerInfo off in config.inc.php, and Servers/1 has no base values at all.
		expect(cf.getConfigArray()).toEqual({ 'ShowServerInfo': false, 'MaxRows': 50, 'Export/format': 'csv', 'Server/hide_db': '', 'Server/only_db': '' });
		expect(Object.keys(cf.getConfigArray()).at(-1)).toBe('Server/only_db');
		cf.set('Export/format', 'sql');
		expect(cf.get('Export')).toBeNull();
		expect(cf.getValue('Export/format')).toBe('sql');
		cf.set('Servers/1/only_db', []);
		expect(cf.getConfigArray()).not.toHaveProperty('Server/only_db');
		cf.resetConfigData();
		expect(cf.getConfigArray()).toEqual({});
	});

	it('only removes a value from containers that exist', () => {
		const cf = new UserConfigFile(base(), allowed);
		cf.set('Export/charset', '');
		expect(cf.get('Export/charset')).toBeNull();
		cf.set('Export/format', 'csv');
		cf.set('Export/charset', '');
		expect(cf.get('Export/format')).toBe('csv');
		expect(cf.get('Export/format/x')).toBeNull();
		// A stored null reads like a missing value, so getValue() falls back to the default.
		cf.set('Servers/1/hide_db', null);
		expect(cf.get('Servers/1/hide_db')).toBeNull();
		expect(cf.getValue('Servers/1/hide_db')).toBe('');
	});
});

describe('castFieldValue', () => {
	it('casts like FormDisplay::save()', () => {
		expect(castFieldValue(fieldInfo('NaturalOrder'), '')).toEqual({ ok: true, value: '' });
		expect(castFieldValue(fieldInfo('NaturalOrder'), '0')).toEqual({ ok: true, value: false });
		expect(castFieldValue(fieldInfo('NaturalOrder'), ['on'])).toEqual({ ok: true, value: true });
		expect(castFieldValue(fieldInfo('NaturalOrder'), [])).toEqual({ ok: true, value: false });
		expect(castFieldValue(fieldInfo('MaxDbList'), ' 12abc')).toEqual({ ok: true, value: 12 });
		expect(castFieldValue(fieldInfo('MaxDbList'), '1e3')).toEqual({ ok: true, value: 1000 });
		expect(castFieldValue(fieldInfo('MaxDbList'), 'x')).toEqual({ ok: true, value: 0 });
		expect(castFieldValue(fieldInfo('Servers/1/hide_db'), '  ^a  ')).toEqual({ ok: true, value: '^a' });
		expect(castFieldValue(fieldInfo('Servers/1/only_db'), 'a\n\n b ')).toEqual({ ok: true, value: ['a', 'b'] });
		expect(castFieldValue(fieldInfo('Servers/1/only_db'), { x: 'a', y: 7 })).toEqual({ ok: true, value: ['a', '7'] });
	});

	it('matches select options loosely by type, then casts to the option key type', () => {
		const maxRows = fieldInfo('MaxRows');
		expect(castFieldValue(maxRows, '50')).toEqual({ ok: true, value: 50 });
		expect(castFieldValue(maxRows, 50.7)).toEqual({ ok: false, value: 50.7 });
		expect(castFieldValue(maxRows, 50)).toEqual({ ok: true, value: 50 });
		expect(castFieldValue(maxRows, 'fifty')).toEqual({ ok: false, value: 'fifty' });
		expect(castFieldValue(maxRows, null)).toEqual({ ok: false, value: null });
		expect(castFieldValue(maxRows, ['50'])).toEqual({ ok: false, value: ['50'] });
		const format = fieldInfo('Export/format');
		expect(castFieldValue(format, 'csv')).toEqual({ ok: true, value: 'csv' });
		expect(castFieldValue(format, true)).toEqual({ ok: false, value: true });
		expect(castFieldValue(maxRows, true)).toEqual({ ok: true, value: true });
		expect(castFieldValue(fieldInfo('FirstDayOfCalendar'), false)).toEqual({ ok: false, value: false });
		expect(castFieldValue({ ...format, values: [[0, 'zero'], ['', 'empty']] }, null)).toEqual({ ok: true, value: '' });
		expect(castFieldValue({ ...format, values: undefined }, 'csv')).toEqual({ ok: false, value: 'csv' });
	});
});

describe('saveForms', () => {
	const features = userForms('Features') as ConfigForm[];
	const databases = features.filter(form => form.name === 'Databases');

	it('saves nothing when a full save has missing data, and reports it by form', () => {
		const cf = new UserConfigFile(base(), new Set(['MaxDbList', 'MaxTableList', 'Servers/1/hide_db', 'Servers/1/only_db']));
		const saved = saveForms(cf, databases, key => ({ MaxDbList: '50' } as Record<string, string>)[key], false);
		expect(saved.result).toBe(false);
		expect(saved.errors.get('Databases')).toContain('Missing data for <i>Hide databases</i>');
		expect(cf.get('MaxDbList')).toBeNull();
	});

	it('lets validation errors replace the others and keeps the values of a partial save', () => {
		const cf = new UserConfigFile(base(), new Set(['MaxDbList', 'MaxTableList', 'Servers/1/hide_db', 'Servers/1/only_db']));
		const post: Record<string, unknown> = { 'MaxDbList': '500', 'Servers-1-only_db': '' };
		const saved = saveForms(cf, databases, key => post[key], true);
		expect(saved.result).toBe(false);
		expect(saved.errors.keys().toArray()).toEqual(['MaxDbList']);
		expect(cf.get('MaxDbList')).toBe(500);
		fixErrors(cf, databases, new Map([['MaxDbList', ['x']], ['Databases', ['y']]]));
		expect(cf.get('MaxDbList')).toBeNull();
	});

	it('treats unchecked checkboxes as false and rejects unknown choices', () => {
		const general = features.filter(form => form.name === 'General');
		const cf = new UserConfigFile(base(), new Set(general.flatMap(form => form.fields as string[])));
		const posted: Record<string, string> = { FirstDayOfCalendar: '9' };
		const saved = saveForms(cf, general, key => posted[key] ?? (fieldInfo(key.replaceAll('-', '/'))?.type === 'checkbox' ? undefined : '1'), false);
		expect(saved.errors.get('FirstDayOfCalendar')).toEqual(['Incorrect value!']);
	});
});

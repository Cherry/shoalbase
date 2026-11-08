import { describe, expect, it } from 'vitest';

import {
	importConfiguration,
	settingsAsJson,
	settingsAsJsonString,
	settingsAsPhp,
	splitReturnUrl,
	userFormFields,
	varExport,
} from './preferences-manage.ts';
import { UserConfigFile } from './user-config.ts';
import { createConfig } from '../config.ts';

const base = (): Record<string, unknown> => createConfig({ host: 'h' }) as unknown as Record<string, unknown>;

function freshConfigFile(config: Record<string, unknown> = base()): UserConfigFile {
	const cf = new UserConfigFile(base(), userFormFields());
	cf.updateWithGlobalConfig(config);
	return cf;
}

// The fields upstream's flattened defaults never post, which fail every import that leaves them out.
const complete = { 'FirstDayOfCalendar': 1, 'DefaultTransformations/TextImageLink': ['a'], 'DefaultTransformations/TextLink': [] };

describe('settings exports', () => {
	it('writes PHP json_encode() output, with [] for no settings', () => {
		expect(settingsAsJson({})).toBe('[]');
		expect(settingsAsJsonString({})).toBe('[]');
		expect(settingsAsJson({ 'Server/hide_db': 'a/b' })).toBe('{\n    "Server\\/hide_db": "a\\/b"\n}');
		expect(settingsAsJsonString({ MaxRows: 50 })).toBe('{"MaxRows":50}');
	});

	it('writes $cfg lines with var_export() values', () => {
		expect(settingsAsPhp({ 'Server/hide_db': 'it\'s \\', 'MaxRows': 50, 'Confirm': false, 'X': null, '2fa': { backend: '', settings: [] }, 'L': ['a', true] }))
			.toBe('/* phpMyAdmin configuration snippet */\n\n/* Paste it to your config.inc.php */\n\n'
				+ '$cfg[\'Server\'][\'hide_db\'] = \'it\\\'s \\\\\';\n'
				+ '$cfg[\'MaxRows\'] = 50;\n'
				+ '$cfg[\'Confirm\'] = false;\n'
				+ '$cfg[\'X\'] = NULL;\n'
				+ '$cfg[\'2fa\'] = array (\n  \'backend\' => \'\',\n  \'settings\' => \n  array (\n  ),\n);\n'
				+ '$cfg[\'L\'] = array (\n  0 => \'a\',\n  1 => true,\n);\n');
		expect(varExport({ '-1': 1, '07': 2 })).toBe('array (\n  -1 => 1,\n  \'07\' => 2,\n)');
	});
});

describe('importConfiguration', () => {
	it('stops at the first page that fails, like BaseFormList::process()', () => {
		const outcome = importConfiguration(freshConfigFile(), { MaxRows: 50 }, false, false);
		expect(outcome.ok).toBe(false);
		expect(outcome.errors).toHaveLength(6);
		expect([...outcome.errors[0].errors]).toEqual([['FirstDayOfCalendar', ['Incorrect value!']]]);
		expect(outcome.errors.slice(1).every(page => page.errors.size === 0)).toBe(true);
	});

	it('fixes errors on request, keeping only what the processed pages saved', () => {
		const cf = freshConfigFile();
		expect(importConfiguration(cf, { MaxRows: 50, MaxDbList: 500 }, false, true)).toEqual({ ok: true, errors: [] });
		const saved = cf.getConfigArray();
		expect(saved).not.toHaveProperty('MaxRows');
		expect(saved).not.toHaveProperty('MaxDbList');
	});

	it('imports a complete configuration, merged with the current settings on request', () => {
		const cf = freshConfigFile({ ...base(), Confirm: false });
		const outcome = importConfiguration(cf, { ...complete, 'MaxRows': 50, 'Export/format': 'csv', 'Servers/1/hide_db': 'x' }, true, false);
		expect(outcome).toEqual({ ok: true, errors: [] });
		const saved = cf.getConfigArray();
		expect(saved).toMatchObject({ 'MaxRows': 50, 'Export/format': 'csv', 'Confirm': false, 'Server/hide_db': 'x', 'DefaultTransformations/Hex': ['2'] });
		expect(Object.keys(saved).at(-1)).toBe('Server/hide_db');
	});
});

describe('splitReturnUrl', () => {
	it('keeps the raw query values except the token', () => {
		expect(splitReturnUrl('index.php?route=%2Fsql&amp;db=x&token=t&flag#top')).toEqual({ path: 'index.php', params: { 'route': '%2Fsql', 'db': 'x', '': 'lag' } });
		expect(splitReturnUrl('https://host:1/pma/index.php?a=1')).toEqual({ path: '/pma/index.php', params: { a: '1' } });
		expect(splitReturnUrl('index.php')).toEqual({ path: 'index.php', params: {} });
	});
});

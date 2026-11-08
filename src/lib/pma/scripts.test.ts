import { describe, expect, it } from 'vitest';

import {
	type ScriptEntry,
	addScriptFile,
	getScriptFiles,
	hasOnloadEvent,
} from './scripts';

describe('script list', () => {
	it('flags files without onload handlers like Scripts::hasOnloadEvent()', () => {
		expect(hasOnloadEvent('home.js')).toBe(true);
		expect(hasOnloadEvent('vendor/jquery/jquery.min.js')).toBe(false);
		expect(hasOnloadEvent('codemirror/addon/lint/sql-lint.js')).toBe(false);
	});

	it('keeps the first occurrence, ignores empty names and defaults params', () => {
		const list: ScriptEntry[] = [];
		addScriptFile(list, { filename: 'config.js' });
		addScriptFile(list, { filename: 'messages.php', params: { l: 'en' } });
		addScriptFile(list, { filename: 'config.js', params: { x: '1' } });
		addScriptFile(list, { filename: '' });
		expect(list).toEqual([
			{ filename: 'config.js', params: {}, has_onload: 1 },
			{ filename: 'messages.php', params: { l: 'en' }, has_onload: 0 },
		]);
	});

	it('leaves files with query strings out of AJAX script lists', () => {
		const list: ScriptEntry[] = [];
		addScriptFile(list, { filename: 'home.js' });
		addScriptFile(list, { filename: 'x.js?v=1' });
		expect(getScriptFiles(list)).toEqual([{ name: 'home.js', fire: 1 }]);
	});
});

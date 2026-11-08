import { describe, expect, it } from 'vitest';

import {
	type OptionRequest,
	OptionsGroup,
	OptionsItem,
	checkboxCheck,
	getChoice,
	getDefault,
	getHtmlForProperty,
	getOneOption,
	getOptions,
	looseKeyEquals,
} from './properties.ts';

function request(section: Record<string, unknown> = {}, get: Record<string, unknown> = {}, params: Record<string, unknown> = {}, timeoutPassed = false): OptionRequest {
	return { get, request: params, timeoutPassed, section };
}

describe('looseKeyEquals', () => {
	it('compares numeric keys numerically and others as strings', () => {
		expect(looseKeyEquals(0, '0')).toBe(true);
		expect(looseKeyEquals(1, '1.0')).toBe(true);
		expect(looseKeyEquals('10', '1e1')).toBe(true);
		expect(looseKeyEquals(0, '')).toBe(false);
		expect(looseKeyEquals('both', 'both')).toBe(true);
		expect(looseKeyEquals('both', 'none')).toBe(false);
	});
});

describe('checkboxCheck', () => {
	it('follows the request, then the timeout replay, then the configuration', () => {
		expect(checkboxCheck(request({ sql_x: true }), 'sql_x')).toBe(' checked="checked"');
		expect(checkboxCheck(request({ sql_x: false }), 'sql_x')).toBe('');
		expect(checkboxCheck(request({}, { sql_x: '' }), 'sql_x')).toBe(' checked="checked"');
		expect(checkboxCheck(request({ sql_x: true }, { repopulate: '1' }), 'sql_x')).toBe('');
		expect(checkboxCheck(request({}, {}, { sql_x: 'on' }, true), 'sql_x')).toBe(' checked="checked"');
		expect(checkboxCheck(request({}, {}, { sql_x: 'on' }, false), 'sql_x')).toBe('');
	});
});

describe('getDefault', () => {
	it('escapes the GET value first, then the replayed request value', () => {
		expect(getDefault(request({ a: 'x' }, { a: '<b>' }), 'a')).toBe('&lt;b&gt;');
		expect(getDefault(request({ a: 'x' }, {}, { a: '"q"' }, true), 'a')).toBe('&quot;q&quot;');
	});

	it('casts configuration values like PHP and expands the LaTeX caption strings', () => {
		expect(getDefault(request({ a: true }), 'a')).toBe('1');
		expect(getDefault(request({ a: false }), 'a')).toBe('');
		expect(getDefault(request({ a: 50000 }), 'a')).toBe('50000');
		expect(getDefault(request({}), 'missing')).toBe('');
		expect(getDefault(request({ a: null }), 'a')).toBe('');
		expect(getDefault(request({ a: 'strLatexStructure strLatexContinued' }), 'a')).toBe('Structure of table @TABLE@ (continued)');
		expect(getDefault(request({ a: 'strUnknown & more' }), 'a')).toBe('strUnknown &amp; more');
	});
});

describe('getChoice', () => {
	it('marks the default format and keeps force_file', () => {
		const list = [
			{ name: 'csv', properties: { text: 'CSV', extension: 'csv', mimeType: 'text/csv', forceFile: false, options: null } },
			{ name: 'ods', properties: { text: 'ODS', extension: 'ods', mimeType: 'x', forceFile: true, options: null } },
		];
		expect(getChoice(list, 'ods')).toEqual([
			{ name: 'csv', text: 'CSV', is_selected: false, force_file: false },
			{ name: 'ods', text: 'ODS', is_selected: true, force_file: true },
		]);
	});
});

describe('getHtmlForProperty', () => {
	const empty = request();

	it('adds the force guard to a boolean that depends on another option', () => {
		const html = getHtmlForProperty(empty, 'sql', new OptionsItem('bool', 'truncate', 'Truncate').setForce('structure'));
		expect(html).toBe('<li class="list-group-item">\n<div class="form-check form-switch">\n<input class="form-check-input" type="checkbox" role="switch" name="sql_truncate" value="something" id="checkbox_sql_truncate" '
			+ ' onclick="if (!this.checked &amp;&amp; (!document.getElementById(\'checkbox_sql_structure\') || !document.getElementById(\'checkbox_sql_structure\').checked)) return false; else return true;"><label class="form-check-label" for="checkbox_sql_truncate">Truncate</label></div>');
	});

	it('renders radios, selects, text and number inputs with the configured default', () => {
		const section = request({ x_mode: 'b', x_pick: 1, x_text: 'v', x_num: 7 });
		expect(getHtmlForProperty(section, 'x', new OptionsItem('radio', 'mode').setValues([['a', 'A'], ['b', 'B']])))
			.toBe('<li class="list-group-item"><div class="form-check"><input type="radio" name="x_mode" class="form-check-input" value="a" id="radio_x_mode_a"><label class="form-check-label" for="radio_x_mode_a">A</label></div>'
				+ '<div class="form-check"><input type="radio" name="x_mode" class="form-check-input" value="b" id="radio_x_mode_b" checked><label class="form-check-label" for="radio_x_mode_b">B</label></div></li>');
		expect(getHtmlForProperty(section, 'x', new OptionsItem('select', 'pick', 'Pick:').setValues([[0, 'zero'], [1, 'one']])))
			.toBe('<li class="list-group-item">\n<label for="select_x_pick" class="form-label">Pick:</label><select class="form-select" name="x_pick" id="select_x_pick"><option value="0">zero</option><option value="1" selected>one</option></select>');
		const text = new OptionsItem('text', 'text', 'Text:');
		text.size = 5;
		text.len = 9;
		expect(getHtmlForProperty(section, 'x', text)).toBe('<li class="list-group-item">\n<label for="text_x_text" class="form-label">Text:</label><input class="form-control" type="text" name="x_text" value="v" id="text_x_text" size="5" maxlength="9">');
		expect(getHtmlForProperty(section, 'x', new OptionsItem('number', 'num', 'Num:')))
			.toBe('<li class="list-group-item">\n<label for="number_x_num" class="form-label">Num:</label><input class="form-control" type="number" name="x_num" value="7" id="number_x_num" min="0">');
		expect(getHtmlForProperty(section, 'x', new OptionsItem('hidden', 'structure_or_data'))).toBe('<li class="list-group-item"><input type="hidden" name="x_structure_or_data" value=""></li>');
		expect(getHtmlForProperty(section, 'x', new OptionsItem('doc', 'doc'))).toBe('');
	});

	it('renders a message given only as the first argument with no text, as upstream does', () => {
		expect(getHtmlForProperty(empty, 'sql', new OptionsItem('message', 'Instead of <code>INSERT</code> statements, use:'))).toBe('<li class="list-group-item">\n');
		expect(getHtmlForProperty(empty, 'sql', new OptionsItem('message', null, 'Syntax:'))).toBe('<li class="list-group-item">\nSyntax:');
	});
});

describe('getOneOption', () => {
	it('closes only the last item of a group and renders subgroup headers with their ul id', () => {
		const group = new OptionsGroup('main', 'general_opts', 'General')
			.add(new OptionsGroup('subgroup', 'sub').setHeader(new OptionsItem('bool', 'head', 'Head')).add(new OptionsItem('text', 'inner', 'Inner')))
			.add(new OptionsItem('bool', 'last', 'Last'));
		const html = getOneOption(request(), 'p', group);
		expect(html.startsWith('\n<div id="p_general_opts"><h5 class="card-title mt-4 mb-2">General</h5><ul class="list-group">\n<li class="list-group-item">')).toBe(true);
		expect(html).toContain('</div></li>\n<li class="list-group-item"><ul class="list-group" id="ul_head">\n<li class="list-group-item">\n<label for="text_p_inner"');
		expect(html).toContain('id="text_p_inner"></ul></li></li>\n');
		expect(html.endsWith('<label class="form-check-label" for="checkbox_p_last">Last</label></div></ul></div></li>\n')).toBe(true);
	});

	it('leaves a subgroup without header unnamed and does not close after radios', () => {
		const group = new OptionsGroup('main', 'g').add(new OptionsGroup('subgroup').add(new OptionsItem('radio', 'r').setValues([['a', 'A']])));
		expect(getOneOption(request(), 'p', group)).toBe('\n<div id="p_g"><ul class="list-group"><li class="list-group-item"><ul class="list-group">\n<li class="list-group-item"><div class="form-check"><input type="radio" name="p_r" class="form-check-input" value="a" id="radio_p_r_a"><label class="form-check-label" for="radio_p_r_a">A</label></div></li></ul></li>\n</ul></div>\n');
	});
});

describe('getOptions', () => {
	it('says a format has no options when its groups only hold hidden fields', () => {
		const hiddenOnly = new OptionsGroup('root').add(new OptionsGroup('main', 'general_opts').add(new OptionsItem('hidden', 'structure_or_data')));
		const html = getOptions(request(), [
			{ name: 'yaml', properties: { text: 'YAML', extension: 'yml', mimeType: 'text/yaml', forceFile: true, options: hiddenOnly } },
			{ name: 'none', properties: { text: 'None', extension: 'x', mimeType: 'x', forceFile: false, options: null } },
		]);
		expect(html).toBe('<div id="yaml_options" class="format_specific_options"><h3>YAML</h3>\n<div id="yaml_general_opts"><ul class="list-group"><li class="list-group-item"><input type="hidden" name="yaml_structure_or_data" value=""></li></ul></div>\n'
			+ '<p class="card-text">This format has no options</p></div><div id="none_options" class="format_specific_options"><h3>None</h3><p class="card-text">This format has no options</p></div>');
	});
});

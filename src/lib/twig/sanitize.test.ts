import { describe, expect, it } from 'vitest';

import {
	backquote,
	escapeJsString,
	escapeMysqlWildcards,
	getJsValue,
	jsFormat,
	sanitizeMessage,
} from './sanitize';

import type { GeneratorState } from './html';

const state: GeneratorState = { config: {}, hasLocalDocs: true, mysqlVersion: 0, gettext: message => message };

describe('sanitizeMessage', () => {
	it('matches the blowfish warning rendered on the live home page', () => {
		expect(sanitizeMessage(state, 'It should only be 32 bytes long. Please refer to the [doc@cfg_blowfish_secret]documentation[/doc].'))
			.toBe('It should only be 32 bytes long. Please refer to the <a href="./doc/html/config.html#cfg_blowfish_secret" target="documentation">documentation</a>.');
	});

	it('converts BBCode tags and escapes raw HTML unless marked safe', () => {
		expect(sanitizeMessage(state, '[em]a[/em][strong]b[/strong][code]c[/code][kbd]d[/kbd][br][sup]e[/sup] <i>[a] [doc]'))
			.toBe('<em>a</em><strong>b</strong><code>c</code><kbd>d</kbd><br><sup>e</sup> &lt;i&gt;[a] [doc]');
		expect(sanitizeMessage(state, '<i>[dochelpicon]', false, true))
			.toBe('<i><img src="themes/dot.gif" title="Documentation" alt="Documentation" class="icon ic_b_help">');
		expect(sanitizeMessage(state, '[conferr]')).toContain('<iframe src="show_config_errors.php">');
		expect(sanitizeMessage(state, '[em]"x"[/em]', true)).toBe('&lt;em&gt;&quot;x&quot;&lt;/em&gt;');
	});

	it('only links to allowed targets', () => {
		expect(sanitizeMessage(state, '[a@https://www.php.net/manual/en/session.configuration.php#ini.session.gc-maxlifetime@_blank]x[/a]'))
			.toBe('<a href="./url.php?url=https%3A%2F%2Fwww.php.net%2Fmanual%2Fen%2Fsession.configuration.php%23ini.session.gc-maxlifetime" target="_blank" rel="noopener noreferrer">x</a>');
		expect(sanitizeMessage(state, '[a@./doc/html/faq.html@documentation]x[/a]')).toBe('<a href="./doc/html/faq.html" target="documentation">x</a>');
		expect(sanitizeMessage(state, '[a@./index.php?route=/]x[/a]')).toBe('<a href="./index.php?route=/">x</a>');
		expect(sanitizeMessage(state, '[a@javascript:alert(1)]x[/a]')).toBe('[a@javascript:alert(1)]x</a>');
		expect(sanitizeMessage(state, '[a@https://x.test/@bad-target]x[/a]')).toBe('[a@https://x.test/@bad-target]x</a>');
	});

	it('guesses the documentation page from the anchor prefix', () => {
		expect(sanitizeMessage(state, '[doc@faq1-1]')).toBe('<a href="./doc/html/faq.html#faq1-1" target="documentation">');
		expect(sanitizeMessage(state, '[doc@setup-script]')).toBe('<a href="./doc/html/setup.html#setup-script" target="documentation">');
		expect(sanitizeMessage(state, '[doc@config@cfg_Servers]')).toBe('<a href="./doc/html/config.html#cfg_Servers" target="documentation">');
		expect(sanitizeMessage(state, '[doc@intro@]')).toBe('<a href="./doc/html/intro.html" target="documentation">');
	});
});

describe('JavaScript helpers', () => {
	it('escapes strings for inline JavaScript like Sanitize::escapeJsString()', () => {
		// The PHP replacement is a fixed lowercase string, so the original casing of </SCRIPT is lost.
		expect(escapeJsString('it\'s "a"\\\n\r\0</SCRIPT>')).toBe(String.raw`it\'s \"a\"\\\n\r</' + 'script>`);
		expect(escapeJsString(null)).toBe('');
	});

	it('formats values with js_format', () => {
		expect(jsFormat('a#b<c>')).toBe('`a\\#b&lt;c&gt;`');
		expect(jsFormat('x', false)).toBe('x');
	});

	it('emits JavaScript assignments with get_js_value', () => {
		expect(getJsValue('a', 'x\'y')).toBe('a = "x\\\'y";\n');
		expect(getJsValue('b', [true, 3, 'z'])).toBe('b = [true,3,"z",];\n');
		expect(getJsValue('c', { k: false })).toBe('c = [false,];\n');
		expect(getJsValue('d', '[1]', false)).toBe('d = [1]');
	});
});

describe('SQL helpers', () => {
	it('backquotes identifiers like Util::backquote()', () => {
		expect(backquote('my`table')).toBe('`my``table`');
		expect(backquote('*')).toBe('*');
		expect(backquote('')).toBe('');
	});

	it('escapes LIKE wildcards', () => {
		expect(escapeMysqlWildcards('my_db%')).toBe(String.raw`my\_db\%`);
	});
});

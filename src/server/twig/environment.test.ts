// @vitest-environment node
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createPmaEnvironment } from './environment';
import { type TemplateStateInput, createTemplateState } from './state';

import { toTwigContext } from '~/lib/twig/values';

// Inline templates are parsed here in Node; the Worker only ever loads precompiled ASTs.
async function render(source: string, context: Record<string, unknown> = {}, state: TemplateStateInput = {}): Promise<string> {
	const env = createPmaEnvironment({ templates: { 't.twig': source }, state: createTemplateState(state) });
	return env.render('t.twig', toTwigContext(context));
}

describe('PHP Twig semantics on Twing', () => {
	it('escapes single quotes like htmlspecialchars(ENT_QUOTES)', async () => {
		expect(await render('{{ v }}', { v: 'it\'s "x" <y> &' })).toBe('it&#039;s &quot;x&quot; &lt;y&gt; &amp;');
	});

	it('leaves the js and url strategies to Twing, matching Twig PHP', async () => {
		expect(await render('{{ v|e(\'js\') }}|{{ v|e(\'url\') }}', { v: 'it\'s <a>' })).toBe(String.raw`it\u0027s\u0020\u003Ca\u003E|it%27s%20%3Ca%3E`);
	});

	it('casts booleans and null like PHP when concatenating', async () => {
		expect(await render('{{ t ~ \'|\' ~ f ~ \'|\' ~ n }}', { t: true, f: false, n: null })).toBe('1||');
	});

	it('treats null as an empty string in raw, case and format filters', async () => {
		expect(await render('[{{ n|raw }}{{ n|lower }}{{ n|upper }}{{ n|title }}{{ n|capitalize }}{{ \'%s!\'|format(n) }}]', { n: null })).toBe('[!]');
		expect(await render('{{ \'%s and %2$s\'|format(\'<b>\', 2)|raw }} {{ \'hello world\'|title }}')).toBe('<b> and 2 Hello World');
	});

	it('keeps PHP arrays as hashes so length, merge and keys work', async () => {
		expect(await render('{{ a|length }} {{ a|merge({z: 1})|keys|join(\',\') }}', { a: { k: 'v', j: 2 } })).toBe('2 k,j,z');
	});

	it('passes raw objects through untouched', async () => {
		expect(await render('{% set x = a|raw %}{{ x.k }}', { a: { k: 'v' } })).toBe('v');
	});
});

describe('{% trans %}', () => {
	it('translates the inline form without escaping, like TransNode', async () => {
		expect(await render('{% trans \'Log in\' %}|{% trans \'<b>\' %}')).toBe('Log in|<b>');
	});

	it('escapes the |trans filter output because it is not marked safe', async () => {
		expect(await render('{{ \'a<b\'|trans }}')).toBe('a&lt;b');
	});

	it('trims the block body and substitutes variables unescaped', async () => {
		expect(await render('{% trans %}\n  Hello {{ name }}!\n{% endtrans %}', { name: '<Bob>' })).toBe('Hello <Bob>!');
	});

	it('selects plural forms and binds %count% to the plural expression', async () => {
		const source = '{% trans %}{{ count }} table{% plural n %}{{ count }} tables{% endtrans %}';
		expect(await render(source, { n: 1 })).toBe('1 table');
		expect(await render(source, { n: -3 })).toBe('3 tables');
	});

	it('accepts context and notes sections', async () => {
		expect(await render('{% trans %}View all{% context %}View all themes{% endtrans %}')).toBe('View all');
		expect(await render('{% trans %}Rows{% notes %}Shown in the table header{% endtrans %}')).toBe('Rows');
		expect(await render('{% trans %}{{ n }} row{% plural n %}{{ n }} rows{% context %}Rows{% endtrans %}', { n: 2 })).toBe('2 rows');
	});

	it('looks messages and contexts up in the configured catalog', async () => {
		const catalog = {
			gettext: (message: string, context: string | null) => `[${context ?? '-'}] ${message}`,
			ngettext: (singular: string) => `[n] ${singular}`,
		};
		expect(await render('{% trans %}View all{% context %}View all themes{% endtrans %}', {}, { catalog })).toBe('[View all themes] View all');
		expect(await render('{{ \'Go\'|trans }}', {}, { catalog })).toBe('[-] Go');
	});

	it('rejects expressions other than simple variables and translation domains', async () => {
		await expect(render('{% trans %}Hi {{ user.name }}{% endtrans %}')).rejects.toThrow('simple variables');
		await expect(render('{% trans from \'x\' %}Hi{% endtrans %}')).rejects.toThrow('domains');
	});
});

describe('phpMyAdmin helpers', () => {
	it('renders hidden inputs and URLs with the request token and server', async () => {
		const state = { url: { token: 'abc', server: 2, hasLangCookie: false } };
		expect(await render('{{ get_hidden_inputs({db: \'x\'}) }}', {}, state)).toBe(
			'<input type="hidden" name="db" value="x"><input type="hidden" name="server" value="2"><input type="hidden" name="lang" value="en"><input type="hidden" name="token" value="abc">',
		);
		expect(await render('{{ url(\'/sql\', {db: \'a b\'}) }}', {}, state)).toBe('index.php?route=/sql&db=a+b&server=2&lang=en');
	});

	it('treats is_safe helpers as safe for HTML only, like Twig PHP\'s compile-time analysis', async () => {
		const image = '<img src="themes/dot.gif" title="" alt="" class="icon ic_b_help">';
		expect(await render('{{ get_image(\'b_help\') }}')).toBe(image);
		expect(await render('{{ x ? get_image(\'b_help\') : \'<i>\' ~ y }}', { x: false, y: '<b>' })).toBe('&lt;i&gt;&lt;b&gt;');
		expect(await render('{{ x ? get_image(\'b_help\') : \'<i>\' ~ y }}', { x: true, y: '' })).toBe(image);
		// A safe result stored in a variable is plain text again, so printing it escapes it.
		expect(await render('{% set i = get_image(\'b_help\') %}{{ i }}')).toBe('&lt;img src=&quot;themes/dot.gif&quot; title=&quot;&quot; alt=&quot;&quot; class=&quot;icon ic_b_help&quot;&gt;');
		// In a js context the same helper is JS-escaped, as in the mysqlDocTemplate line of the live login page.
		const login = readFileSync(new URL('../../../tests/fixtures/pma-5.2.3/login.page.html', import.meta.url), 'utf8');
		const liveTemplate = /var mysqlDocTemplate = '([^']*)';/.exec(login)?.[1];
		expect(await render('{% autoescape \'js\' %}{{ get_mysql_docu_url(\'%s\') }}|{% trans "it\'s" %}{% endautoescape %}', {}, { mysqlVersion: 55000 }))
			.toBe(`${liveTemplate}|it's`);
	});

	it('fails loudly when a database-backed helper has no request-bound implementation', async () => {
		const source = '{{ get_tracker_version(\'db\', \'t\') }}';
		await expect(render(source)).rejects.toThrow('get_tracker_version is not implemented yet');
		expect(await render(source, {}, { functionOverrides: { get_tracker_version: () => 3 } })).toBe('3');
	});
});

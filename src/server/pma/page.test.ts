// @vitest-environment node
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { getAjaxScripts, renderPage } from './page';
import { buildCommonParams, defaultShellConfig, pageTitle } from '../../lib/pma/header';

const live = readFileSync(new URL('../../../tests/fixtures/pma-5.2.3/home.live.html', import.meta.url), 'utf8');
const liveToken = '304b74753071683670656e7632287b46';
const url = { token: liveToken, hasLangCookie: true };
const state = { url, mysqlVersion: 80400 };
const jsParams = buildCommonParams({
	url: { server: 1, serverDefault: 1, lang: 'en', ...url },
	config: defaultShellConfig,
	sessionGcMaxlifetime: 1440,
	loggedIn: true,
	isHttps: false,
	authType: 'cookie',
	user: 'customer',
});

// Navigation, menu, console and content are separate ports, so the test treats them as opaque slots.
const slots = ['NAVIGATION', 'PREFERENCES', 'MENU', 'CONSOLE', 'CONTENT'];
const slot = (name: string): string => `@@${name}@@`;

function slotPattern(html: string): RegExp {
	let pattern = html.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`);
	for (const name of slots) {
		pattern = pattern.replace(slot(name), String.raw`[\s\S]*?`);
	}
	return new RegExp(`^${pattern}$`);
}

describe('renderPage', () => {
	it('reproduces the logged-in home page shell of phpMyAdmin 5.2.3 around the separately ported parts', async () => {
		const html = await renderPage({
			content: slot('CONTENT'),
			state,
			jsParams,
			isLoggedIn: true,
			menuEnabled: true,
			navigation: slot('NAVIGATION'),
			loadUserPreferences: slot('PREFERENCES'),
			menu: slot('MENU'),
			console: slot('CONSOLE'),
			extraScripts: [{ filename: 'home.js' }],
			route: '/',
			title: pageTitle({ httpHost: '127.0.0.1:8088', server: 1, serverHost: 'dbadmin-mysql' }),
		});
		expect(live).toMatch(slotPattern(html));
	});

	it('returns only the content and recent tables for AJAX requests', async () => {
		const html = await renderPage({ content: '<p>x</p>', state, jsParams, isLoggedIn: true, isAjax: true, menuEnabled: true, recentTable: '<r>' });
		expect(html).toBe('<r><p>x</p>');
		expect(await renderPage({ content: 'c', state, jsParams, isLoggedIn: true, isAjax: true, menuEnabled: true })).toBe('c');
	});

	it('escapes the title and body id twice, as Header::setTitle() and the template both escape', async () => {
		const html = await renderPage({ content: '', state, jsParams, isLoggedIn: false, menuEnabled: false, title: 'a & b', bodyId: 'x"y', isMinimal: true });
		expect(html).toContain('<title>a &amp;amp; b</title>');
		expect(html).toContain('<body id=x&amp;quot;y>');
		expect(html).not.toContain('id="selflink"');
	});

	it('hides the menu and navigation without a server and builds the self link from the route, db and table', async () => {
		const html = await renderPage({
			content: '',
			state: { url: { ...url, server: 0 } },
			jsParams,
			isLoggedIn: true,
			menuEnabled: true,
			menu: '<menu>',
			navigation: '<nav>',
			db: 'shop',
			table: 'orders',
			config: { ...defaultShellConfig, ShowHint: false },
		});
		expect(html).not.toContain('<menu>');
		expect(html).not.toContain('<nav>');
		expect(html).toContain('<span id="no_hint" class="hide"></span>');
		expect(html).toContain('<a href="index.php?db=shop&amp;table=orders&amp;server=0"');
	});
});

describe('getAjaxScripts', () => {
	it('lists the default and controller scripts but not the display-time ones', () => {
		const scripts = getAjaxScripts({ lang: 'en', extraScripts: [{ filename: 'home.js' }] });
		expect(scripts.at(-1)).toEqual({ name: 'home.js', fire: 1 });
		expect(scripts.some(file => file.name === 'console.js')).toBe(false);
		expect(getAjaxScripts({ lang: 'en' }).at(-1)).toEqual({ name: 'page_settings.js', fire: 1 });
	});
});

// @vitest-environment node
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { renderTemplate } from './render';

import type { TemplateStateInput } from './state';

interface Language {
	code: string;
	name: string;
}

const fixtureDir = new URL('../../../tests/fixtures/pma-5.2.3/', import.meta.url);
const readFixture = (name: string): string => readFileSync(new URL(name, fixtureDir), 'utf8');

// Stand-ins for PhpMyAdmin\Language objects; templates call these methods.
const toLanguages = (languages: Language[], active: string): unknown[] => languages.map(({ code, name }) => {
	return {
		getCode: () => code,
		getName: () => name,
		isActive: () => code === active,
	};
});

const servers = [
	{ value: 1, label: 'dbadmin-mysql', selected: 1 },
	{ value: 2, label: 'dbadmin-mysql-b', selected: 0 },
];

describe('renderTemplate against live phpMyAdmin 5.2.3 output', () => {
	it('renders the cookie login page body byte-for-byte', async () => {
		const live = readFixture('login.live.html');
		const context = JSON.parse(readFixture('login-context.json')) as { token: string; sessionId: string; languages: Language[]; };
		// First visit: no pma_lang cookie yet, so phpMyAdmin adds lang=en to forms and URLs.
		const state: TemplateStateInput = { url: { token: context.token, hasLangCookie: false } };

		// The same calls AuthenticationCookie::showLoginForm() makes.
		const rendered = await renderTemplate('login/form', {
			login_header: await renderTemplate('login/header', { add_class: '', session_expired: 0 }, state),
			is_demo: false,
			error_messages: '',
			available_languages: toLanguages(context.languages, 'en'),
			is_session_expired: false,
			has_autocomplete: true,
			session_id: context.sessionId,
			is_arbitrary_server_allowed: false,
			default_server: '',
			default_user: '',
			has_servers: true,
			server_options: await renderTemplate('server/select/index', { not_only_options: false, omit_fieldset: false, servers: { select: servers } }, state),
			server: 1,
			lang: 'en',
			has_captcha: false,
			use_captcha_checkbox: false,
			captcha_api: '',
			captcha_req: '',
			captcha_resp: '',
			captcha_key: '',
			form_params: {},
			errors: '',
			login_footer: await renderTemplate('login/footer', { session_expired: 0 }, state),
			config_footer: '',
		}, state);

		const fragment = live.slice(live.indexOf('<div class="container">'), live.lastIndexOf('  </div>\n  </body>'));
		expect(rendered).toBe(fragment);
	});

	it('renders the home page body byte-for-byte', async () => {
		const live = readFixture('home.live.html');
		const context = JSON.parse(readFixture('home-context.json')) as {
			token: string;
			mysqlVersion: number;
			languages: Language[];
			charsets: unknown[];
			configStorageMessage: string;
		};
		const state: TemplateStateInput = { url: { token: context.token }, mysqlVersion: context.mysqlVersion };

		const rendered = await renderTemplate('home/index', {
			db: '',
			table: '',
			message: '',
			partial_logout: '',
			is_git_revision: false,
			server: 1,
			sync_favorite_tables: '',
			has_server: true,
			is_demo: false,
			has_server_selection: true,
			server_selection: await renderTemplate('server/select/index', {
				not_only_options: true,
				omit_fieldset: true,
				form_action: 'index.php?route=/',
				servers: { select: servers },
			}, state),
			has_change_password_link: true,
			charsets: context.charsets,
			available_languages: toLanguages(context.languages, 'en'),
			database_server: [],
			web_server: [],
			show_php_info: false,
			is_version_checked: true,
			phpmyadmin_version: '5.2.3',
			phpmyadmin_major_version: '5.2',
			// Built by the controller with Message::addParamHtml(), not by a template.
			config_storage_message: context.configStorageMessage,
			has_theme_manager: true,
			themes: [
				{ id: 'bootstrap', name: 'Bootstrap', is_active: false },
				{ id: 'metro', name: 'Metro', is_active: false },
				{ id: 'original', name: 'Original', is_active: false },
				{ id: 'pmahomme', name: 'pmahomme', is_active: true },
			],
			errors: [{
				message: 'The cookie encryption key in the configuration file is longer than necessary. It should only be 32 bytes long. Please refer to the [doc@cfg_blowfish_secret]documentation[/doc].',
				severity: 'warning',
			}],
		}, state);

		const start = live.indexOf('<div id="maincontainer">');
		expect(rendered.trimStart().startsWith('<div id="maincontainer">')).toBe(true);
		expect(rendered.trim()).toBe(live.slice(start, live.indexOf('\n  </div>\n      <div id="selflink"')).trim());
		expect(live).toContain(rendered);
	});

	it('rejects unknown templates', async () => {
		await expect(renderTemplate('does/not/exist', {})).rejects.toThrow('Unknown template "does/not/exist.twig"');
	});
});

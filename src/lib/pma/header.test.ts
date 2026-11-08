import { describe, expect, it } from 'vitest';

import {
	addDisplayScripts,
	buildCommonParams,
	commonParamsCode,
	defaultScripts,
	defaultShellConfig,
	pageHttpHeaders,
	pageTitle,
} from './header';
import { getScriptFiles } from './scripts';

import type { UrlState } from '../twig/url';

const loginUrl: UrlState = { server: 1, serverDefault: 1, lang: 'en', hasLangCookie: false, token: '247c47354f40654b7a50393d6c504178' };

// AJAX.scriptHandler.add() lines from the live 5.2.3 login page.
const liveLoginScripts = [
	['vendor/jquery/jquery.min.js', 0],
	['vendor/jquery/jquery-migrate.min.js', 0],
	['vendor/sprintf.js', 1],
	['ajax.js', 0],
	['keyhandler.js', 1],
	['vendor/jquery/jquery-ui.min.js', 0],
	['name-conflict-fixes.js', 1],
	['vendor/bootstrap/bootstrap.bundle.min.js', 1],
	['vendor/js.cookie.js', 1],
	['vendor/jquery/jquery.validate.min.js', 0],
	['vendor/jquery/jquery-ui-timepicker-addon.js', 0],
	['vendor/jquery/jquery.debounce-1.0.6.js', 0],
	['menu_resizer.js', 1],
	['cross_framing_protection.js', 0],
	['messages.php', 0],
	['config.js', 1],
	['doclinks.js', 1],
	['functions.js', 1],
	['navigation.js', 1],
	['indexes.js', 1],
	['common.js', 1],
	['page_settings.js', 1],
	['vendor/codemirror/lib/codemirror.js', 0],
	['vendor/codemirror/mode/sql/sql.js', 0],
	['vendor/codemirror/addon/runmode/runmode.js', 0],
	['vendor/codemirror/addon/hint/show-hint.js', 0],
	['vendor/codemirror/addon/hint/sql-hint.js', 0],
	['vendor/codemirror/addon/lint/lint.js', 0],
	['codemirror/addon/lint/sql-lint.js', 0],
	['vendor/tracekit.js', 1],
	['error_report.js', 1],
	['drag_drop_import.js', 1],
	['shortcuts_handler.js', 1],
	['console.js', 1],
].map(([name, fire]) => { return { name, fire }; });

describe('page scripts', () => {
	it('matches the script list and onload flags of the live login page', () => {
		const list = defaultScripts(defaultShellConfig, 'en');
		addDisplayScripts(list, defaultShellConfig);
		expect(getScriptFiles(list)).toEqual(liveLoginScripts);
		expect(list.find(entry => entry.filename === 'messages.php')?.params).toEqual({ l: 'en' });
	});

	it('drops optional scripts when their features are off', () => {
		const config = {
			...defaultShellConfig,
			AllowThirdPartyFraming: true,
			CodemirrorEnable: false,
			SendErrorReports: 'never' as const,
			enable_drag_drop_import: false,
			DisableShortcutKeys: true,
		};
		const list = defaultScripts(config, 'de');
		addDisplayScripts(list, config);
		const names = getScriptFiles(list).map(file => file.name);
		expect(names).not.toContain('cross_framing_protection.js');
		expect(names.slice(-2)).toEqual(['page_settings.js', 'console.js']);
	});

	it('loads CodeMirror without the linter when LintEnable is off', () => {
		const list = defaultScripts(defaultShellConfig, 'en');
		addDisplayScripts(list, { ...defaultShellConfig, LintEnable: false });
		const names = getScriptFiles(list).map(file => file.name);
		expect(names).toContain('vendor/codemirror/addon/hint/sql-hint.js');
		expect(names).not.toContain('vendor/codemirror/addon/lint/lint.js');
	});
});

describe('CommonParams', () => {
	it('matches CommonParams.setAll() on the live login page', () => {
		const params = buildCommonParams({
			url: loginUrl,
			config: defaultShellConfig,
			sessionGcMaxlifetime: 1440,
			loggedIn: false,
			isHttps: false,
			authType: 'cookie',
			user: 'root',
		});
		expect(commonParamsCode(params)).toBe(
			'CommonParams.setAll({common_query:"lang=en",opendb_url:"index.php?route=/database/structure&lang=en",lang:"en",server:"1",'
			+ 'table:"",db:"",token:"247c47354f40654b7a50393d6c504178",text_dir:"ltr",LimitChars:"50",pftext:"",confirm:true,'
			+ 'LoginCookieValidity:"1440",session_gc_maxlifetime:"1440",logged_in:false,is_https:false,rootPath:true,arg_separator:"&",'
			+ 'version:"5.2.3",auth_type:"cookie",user:"root"});',
		);
	});

	it('includes db, table and the user only when known, and escapes values for JS', () => {
		const params = buildCommonParams({
			url: { ...loginUrl, hasLangCookie: true },
			config: { ...defaultShellConfig, DefaultTabDatabase: 'sql' },
			db: 'it\'s',
			table: 't',
			pftext: 'P',
			textDir: 'rtl',
			sessionGcMaxlifetime: 60,
			loggedIn: true,
			isHttps: true,
			authType: 'cookie',
		});
		expect(params).toMatchObject({ common_query: '', opendb_url: 'index.php?route=/database/sql', db: 'it\'s', table: 't', pftext: 'P', text_dir: 'rtl' });
		expect(params.user).toBeUndefined();
		expect(commonParamsCode(params)).toContain(String.raw`db:"it\'s"`);
		expect(buildCommonParams({ url: loginUrl, config: defaultShellConfig, sessionGcMaxlifetime: 1, loggedIn: false, isHttps: false }).auth_type).toBeUndefined();
	});
});

describe('pageTitle', () => {
	const base = { httpHost: '127.0.0.1:8088', server: 1, serverHost: 'dbadmin-mysql' };

	it('matches the live home page title', () => {
		expect(pageTitle(base)).toBe('127.0.0.1:8088 / dbadmin-mysql | phpMyAdmin 5.2.3');
	});

	it('uses the database and table formats, the verbose name and the no-server fallbacks', () => {
		expect(pageTitle({ ...base, db: 'shop', serverVerbose: 'Main' })).toBe('127.0.0.1:8088 / Main / shop | phpMyAdmin 5.2.3');
		expect(pageTitle({ ...base, db: 'shop', table: 'o@TABLE@' })).toBe('127.0.0.1:8088 / dbadmin-mysql / shop / o@TABLE@ | phpMyAdmin 5.2.3');
		expect(pageTitle({ ...base, serverHost: '' })).toBe('127.0.0.1:8088 | phpMyAdmin 5.2.3');
		expect(pageTitle({ ...base, server: 0 })).toBe('phpMyAdmin');
	});

	it('expands user title preferences with every strtr() placeholder', () => {
		const titles = { TitleServer: '@SERVER@|__SERVER__|@VERBOSE@|@NOPE@', TitleDatabase: '__DB__', TitleTable: '__TABLE__ @TABLE@', TitleDefault: 'd' };
		expect(pageTitle({ ...base, titles })).toBe('dbadmin-mysql|dbadmin-mysql||@NOPE@');
		expect(pageTitle({ ...base, titles, db: 'shop' })).toBe('shop');
		expect(pageTitle({ ...base, titles, db: 'shop', table: 't' })).toBe('t t');
		expect(pageTitle({ ...base, titles, serverHost: '' })).toBe('d');
	});
});

describe('pageHttpHeaders', () => {
	const now = new Date('2026-11-06T16:39:09Z');

	it('matches the headers phpMyAdmin sent with the live login page', () => {
		expect(pageHttpHeaders(defaultShellConfig, now)).toEqual([
			['X-Frame-Options', 'DENY'],
			['Referrer-Policy', 'same-origin'],
			['Content-Security-Policy', 'default-src \'self\' ;script-src \'self\' \'unsafe-inline\' \'unsafe-eval\' ;style-src \'self\' \'unsafe-inline\' ;img-src \'self\' data:  *.tile.openstreetmap.org;object-src \'none\';'],
			['X-Content-Security-Policy', 'default-src \'self\' ;options inline-script eval-script;referrer no-referrer;img-src \'self\' data:  *.tile.openstreetmap.org;object-src \'none\';'],
			['X-WebKit-CSP', 'default-src \'self\' ;script-src \'self\'  \'unsafe-inline\' \'unsafe-eval\';referrer no-referrer;style-src \'self\' \'unsafe-inline\' ;img-src \'self\' data:  *.tile.openstreetmap.org;object-src \'none\';'],
			['X-XSS-Protection', '1; mode=block'],
			['X-Content-Type-Options', 'nosniff'],
			['X-Permitted-Cross-Domain-Policies', 'none'],
			['X-Robots-Tag', 'noindex, nofollow'],
			['Expires', 'Fri, 06 Nov 2026 16:39:09 +0000'],
			['Cache-Control', 'no-store, no-cache, must-revalidate, pre-check=0, post-check=0, max-age=0'],
			['Pragma', 'no-cache'],
			['Last-Modified', 'Fri, 06 Nov 2026 16:39:09 +0000'],
			['Content-Type', 'text/html; charset=utf-8'],
		]);
	});

	it('follows AllowThirdPartyFraming and CSPAllow', () => {
		const sameOrigin = pageHttpHeaders({ ...defaultShellConfig, AllowThirdPartyFraming: 'sameorigin', CSPAllow: 'cdn.test' }, now);
		expect(sameOrigin[0]).toEqual(['X-Frame-Options', 'SAMEORIGIN']);
		expect(sameOrigin[2][1]).toContain('img-src \'self\' data: cdn.test *.tile.openstreetmap.org;');
		expect(pageHttpHeaders({ ...defaultShellConfig, AllowThirdPartyFraming: true }, now)[0][0]).toBe('Referrer-Policy');
	});
});

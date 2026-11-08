// Pure parts of PhpMyAdmin\Header: default scripts, CommonParams, page title and HTTP headers.
import { type ScriptEntry, addScriptFile } from './scripts.ts';
import { escapeJsString } from '../twig/sanitize.ts';
import { type UrlState, getCommon, getFromRoute } from '../twig/url.ts';

export const PMA_VERSION = '5.2.3';

/** The $cfg settings the page shell reads, named as in phpMyAdmin. */
export interface ShellConfig {
	AllowThirdPartyFraming: boolean | 'sameorigin';
	CodemirrorEnable: boolean;
	LintEnable: boolean;
	SendErrorReports: 'ask' | 'always' | 'never';
	enable_drag_drop_import: boolean;
	DisableShortcutKeys: boolean;
	ConsoleEnterExecutes: boolean;
	FirstDayOfCalendar: number;
	LimitChars: number;
	Confirm: boolean;
	LoginCookieValidity: number;
	DefaultTabDatabase: 'structure' | 'sql' | 'search' | 'operations';
	GridEditing: 'double-click' | 'click' | 'disabled';
	ShowHint: boolean;
	/** $cfg['CSPAllow'], appended to every CSP source list. */
	CSPAllow: string;
}

/** phpMyAdmin 5.2.3 defaults, which the production config does not override for these keys. */
export const defaultShellConfig: ShellConfig = {
	AllowThirdPartyFraming: false,
	CodemirrorEnable: true,
	LintEnable: true,
	SendErrorReports: 'ask',
	enable_drag_drop_import: true,
	DisableShortcutKeys: false,
	ConsoleEnterExecutes: false,
	FirstDayOfCalendar: 0,
	LimitChars: 50,
	Confirm: true,
	LoginCookieValidity: 1440,
	DefaultTabDatabase: 'structure',
	GridEditing: 'double-click',
	ShowHint: true,
	CSPAllow: '',
};

/** Header::addDefaultScripts(), in upstream order. */
export function defaultScripts(config: ShellConfig, lang: string): ScriptEntry[] {
	const list: ScriptEntry[] = [];
	const add = (filename: string, params?: Record<string, string>): void => addScriptFile(list, { filename, params });
	add('vendor/jquery/jquery.min.js');
	add('vendor/jquery/jquery-migrate.min.js');
	add('vendor/sprintf.js');
	add('ajax.js');
	add('keyhandler.js');
	add('vendor/jquery/jquery-ui.min.js');
	add('name-conflict-fixes.js');
	add('vendor/bootstrap/bootstrap.bundle.min.js');
	add('vendor/js.cookie.js');
	add('vendor/jquery/jquery.validate.min.js');
	add('vendor/jquery/jquery-ui-timepicker-addon.js');
	add('vendor/jquery/jquery.debounce-1.0.6.js');
	add('menu_resizer.js');
	if (config.AllowThirdPartyFraming === false) {
		add('cross_framing_protection.js');
	}
	add('messages.php', { l: lang });
	add('config.js');
	add('doclinks.js');
	add('functions.js');
	add('navigation.js');
	add('indexes.js');
	add('common.js');
	add('page_settings.js');
	return list;
}

/** Scripts Header::getDisplay() adds for full (non-AJAX) pages, after any controller scripts. */
export function addDisplayScripts(list: ScriptEntry[], config: ShellConfig): void {
	const add = (filename: string): void => addScriptFile(list, { filename });
	if (config.CodemirrorEnable) {
		add('vendor/codemirror/lib/codemirror.js');
		add('vendor/codemirror/mode/sql/sql.js');
		add('vendor/codemirror/addon/runmode/runmode.js');
		add('vendor/codemirror/addon/hint/show-hint.js');
		add('vendor/codemirror/addon/hint/sql-hint.js');
		if (config.LintEnable) {
			add('vendor/codemirror/addon/lint/lint.js');
			add('codemirror/addon/lint/sql-lint.js');
		}
	}
	if (config.SendErrorReports !== 'never') {
		add('vendor/tracekit.js');
		add('error_report.js');
	}
	if (config.enable_drag_drop_import) {
		add('drag_drop_import.js');
	}
	if (!config.DisableShortcutKeys) {
		add('shortcuts_handler.js');
	}
	// Console::getScripts(), added even when the console itself is disabled.
	add('console.js');
}

export interface PageTitleInput {
	/** The request's Host header. */
	httpHost: string;
	/** $GLOBALS['server']; 0 means no server is selected. */
	server: number;
	/** $cfg['Server']['host'] and ['verbose']. */
	serverHost: string;
	serverVerbose?: string;
	db?: string;
	table?: string;
	/** $cfg['TitleTable'] and friends when user preferences changed them; the defaults apply otherwise. */
	titles?: Partial<Record<'TitleTable' | 'TitleDatabase' | 'TitleServer' | 'TitleDefault', string>>;
}

/**
 * Header::getPageTitle() with the Title* formats, expanded like Util::expandUserString() without its strftime()
 * conversions; Header::setTitle() escaping is left to the caller.
 */
export function pageTitle(input: PageTitleInput): string {
	if (input.server <= 0) {
		return 'phpMyAdmin';
	}
	const titles = input.titles ?? {};
	let format = titles.TitleDefault ?? '@HTTP_HOST@ | @PHPMYADMIN@';
	if (input.table) {
		format = titles.TitleTable ?? '@HTTP_HOST@ / @VSERVER@ / @DATABASE@ / @TABLE@ | @PHPMYADMIN@';
	} else if (input.db) {
		format = titles.TitleDatabase ?? '@HTTP_HOST@ / @VSERVER@ / @DATABASE@ | @PHPMYADMIN@';
	} else if (input.serverHost) {
		format = titles.TitleServer ?? '@HTTP_HOST@ / @VSERVER@ | @PHPMYADMIN@';
	}
	const replacements: Record<string, string> = {
		'@HTTP_HOST@': input.httpHost,
		'@SERVER@': input.serverHost,
		'__SERVER__': input.serverHost,
		'@VERBOSE@': input.serverVerbose ?? '',
		'@VSERVER@': input.serverVerbose || input.serverHost,
		'@DATABASE@': input.db ?? '',
		'__DB__': input.db ?? '',
		'@TABLE@': input.table ?? '',
		'__TABLE__': input.table ?? '',
		'@PHPMYADMIN@': `phpMyAdmin ${PMA_VERSION}`,
	};
	// strtr(): one pass, so replaced text is never expanded again.
	return format.replaceAll(/@(?:HTTP_HOST|SERVER|VERBOSE|VSERVER|DATABASE|TABLE|PHPMYADMIN)@|__(?:SERVER|DB|TABLE)__/g, token => replacements[token]);
}

/** Header::getJsParams(); values keep upstream order and types. */
export type CommonParams = Record<string, boolean | number | string>;

export interface CommonParamsInput {
	url: UrlState;
	config: ShellConfig;
	db?: string;
	table?: string;
	/** $_SESSION['tmpval']['pftext']. */
	pftext?: string;
	textDir?: 'ltr' | 'rtl';
	/** ini_get('session.gc_maxlifetime'). */
	sessionGcMaxlifetime: number;
	loggedIn: boolean;
	isHttps: boolean;
	/** $cfg['Server']['auth_type'] and ['user']; upstream reports the default user "root" even for cookie auth. */
	authType?: string;
	user?: string;
}

export function buildCommonParams(input: CommonParamsInput): CommonParams {
	const params: CommonParams = {
		common_query: getCommon(input.url, {}, ''),
		opendb_url: getFromRoute(input.url, `/database/${input.config.DefaultTabDatabase}`),
		lang: input.url.lang,
		server: input.url.server,
		table: input.table ?? '',
		db: input.db ?? '',
		token: input.url.token,
		text_dir: input.textDir ?? 'ltr',
		LimitChars: input.config.LimitChars,
		pftext: input.pftext ?? '',
		confirm: input.config.Confirm,
		LoginCookieValidity: input.config.LoginCookieValidity,
		session_gc_maxlifetime: input.sessionGcMaxlifetime,
		logged_in: input.loggedIn,
		is_https: input.isHttps,
		// Config::getRootPath() is a non-empty string, which upstream coerces to true.
		rootPath: true,
		arg_separator: '&',
		version: PMA_VERSION,
	};
	if (input.authType !== undefined) {
		params.auth_type = input.authType;
		if (input.user !== undefined) {
			params.user = input.user;
		}
	}
	return params;
}

/** Header::getJsParamsCode(): every non-boolean value is emitted as a JS string. */
export function commonParamsCode(params: CommonParams): string {
	const pairs = Object.entries(params).map(([key, value]) => {
		if (typeof value === 'boolean') {
			return `${key}:${value ? 'true' : 'false'}`;
		}
		return `${key}:"${escapeJsString(value)}"`;
	});
	return `CommonParams.setAll({${pairs.join(',')}});`;
}

// DATE_RFC1123 as PHP's gmdate() formats it: a numeric "+0000" zone instead of "GMT".
function rfc1123(date: Date): string {
	return date.toUTCString().replace(/GMT$/, '+0000');
}

/** Header::getHttpHeaders() for HTML pages, in upstream order, without captcha CSP sources. */
export function pageHttpHeaders(config: ShellConfig, now: Date): [string, string][] {
	const headers: [string, string][] = [];
	if (config.AllowThirdPartyFraming === 'sameorigin') {
		headers.push(['X-Frame-Options', 'SAMEORIGIN']);
	} else if (config.AllowThirdPartyFraming !== true) {
		headers.push(['X-Frame-Options', 'DENY']);
	}
	const allow = config.CSPAllow;
	const tiles = ' *.tile.openstreetmap.org';
	const date = rfc1123(now);
	headers.push(
		['Referrer-Policy', 'same-origin'],
		[
			'Content-Security-Policy',
			`default-src 'self' ${allow};script-src 'self' 'unsafe-inline' 'unsafe-eval' ${allow};`
			+ `style-src 'self' 'unsafe-inline' ${allow};img-src 'self' data: ${allow}${tiles};object-src 'none';`,
		],
		[
			'X-Content-Security-Policy',
			`default-src 'self' ${allow};options inline-script eval-script;`
			+ `referrer no-referrer;img-src 'self' data: ${allow}${tiles};object-src 'none';`,
		],
		[
			'X-WebKit-CSP',
			`default-src 'self' ${allow};script-src 'self' ${allow} 'unsafe-inline' 'unsafe-eval';`
			+ 'referrer no-referrer;style-src \'self\' \'unsafe-inline\' ;'
			+ `img-src 'self' data: ${allow}${tiles};object-src 'none';`,
		],
		['X-XSS-Protection', '1; mode=block'],
		['X-Content-Type-Options', 'nosniff'],
		['X-Permitted-Cross-Domain-Policies', 'none'],
		['X-Robots-Tag', 'noindex, nofollow'],
		// Core::getNoCacheHeaders()
		['Expires', date],
		['Cache-Control', 'no-store, no-cache, must-revalidate, pre-check=0, post-check=0, max-age=0'],
		['Pragma', 'no-cache'],
		['Last-Modified', date],
		['Content-Type', 'text/html; charset=utf-8'],
	);
	return headers;
}

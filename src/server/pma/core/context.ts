// The per-request globals phpMyAdmin's Common::run() sets up, gathered into one object for ported controllers.
import { DatabaseInterface } from './dbi.ts';
import { ResponseRenderer } from './response.ts';
import { type PmaConfig, createConfig } from '../../../lib/pma/config.ts';
import { phpCookieName } from '../../../lib/pma/cookies.ts';
import { currentDatabaseAndTable } from '../../../lib/pma/dbi-sql.ts';
import { PmaSession } from '../../../lib/pma/session.ts';
import { activeThemeId, themeCookieName } from '../../../lib/pma/themes.ts';
import { applySessionPreferences, loadUserPreferences, setUserValue } from '../../../lib/pma/user-preferences.ts';
import { getFromRoute } from '../../../lib/twig/url.ts';
import { themeImageSet } from '../../twig/render.ts';

import type { PmaRequest } from '../../../lib/pma-request.ts';
import type { UrlState } from '../../../lib/twig/url.ts';
import type { TemplateStateInput } from '../../twig/state.ts';
import type { Connection } from 'mysql2/promise';

export interface PmaContext {
	request: PmaRequest;
	/** $route. */
	route: string;
	/** $GLOBALS['cfg'] with the selected server in config.Server, after the session's user preferences are merged in. */
	config: PmaConfig;
	/** Config::$baseSettings: $cfg before user preferences. */
	readonly baseConfig: PmaConfig;
	/** $_SESSION, stored again by ResponseRenderer::response() when it changed. */
	session: PmaSession;
	dbi: DatabaseInterface;
	/** $GLOBALS['db'] and $GLOBALS['table'], validated like Common::setDatabaseAndTableFromRequest(); controllers may change them. */
	db: string;
	table: string;
	/** The db and table when the Header was built; its Menu and CommonParams code keep them when a controller changes db or table. */
	readonly headerDb: string;
	readonly headerTable: string;
	/** $GLOBALS['server']: the 1-based index of the signed-in server. */
	server: number;
	/** The session CSRF token. */
	token: string;
	/** The signed-in MySQL account. */
	user: string;
	/** $GLOBALS['lang']. */
	lang: string;
	isHttps: boolean;
	/** The request's Host header, for the page title. */
	httpHost: string;
	hasLangCookie: boolean;
	/** $_COOKIE[Config::getCookieName($name)]. */
	getCookie(name: string): string | undefined;
	/** ThemeManager's active theme id. */
	theme: string;
	/** URL helper state for getFromRoute(), getCommon() and friends. */
	urlState(): UrlState;
	/** Twig request state; connects first so templates see the server version, as upstream always has a connection. */
	templateState(): Promise<TemplateStateInput>;
	response: ResponseRenderer;
}

export interface PmaContextInput {
	request: PmaRequest;
	url: URL;
	auth: { user: string; host: string; serverIndex: number; token: string; ssl?: boolean; };
	connect: () => Promise<Connection>;
	hasLangCookie: boolean;
	/** Reads a request cookie by its raw name. */
	cookie?: (name: string) => string | undefined;
	/** The opened session cookies; a fresh session when absent. */
	session?: PmaSession;
}

/** Config::loadUserPreferences(): merges the session preferences, then remembers a theme picked through the theme cookie. */
function loadPreferences(config: PmaConfig, session: PmaSession, themeCookie: string | undefined, setTheme: unknown): string {
	const cfg = config as unknown as Record<string, unknown>;
	applySessionPreferences(session, cfg);
	const theme = activeThemeId(themeCookie, config.ThemeDefault);
	if ((themeCookie !== undefined && themeCookie !== '' && themeCookie !== '0') || setTheme !== undefined) {
		const now = Math.floor(Date.now() / 1000);
		const stored = loadUserPreferences(session, now).config_data.ThemeDefault;
		if ((stored === undefined && theme !== 'original') || (stored !== undefined && stored !== theme)) {
			setUserValue(session, cfg, 'ThemeDefault', theme, 'original', now);
		}
	}
	return theme;
}

/** Builds the controller context; the database connection opens lazily on first use. */
export function createPmaContext(input: PmaContextInput): PmaContext {
	const { request, url, auth } = input;
	const isHttps = url.protocol === 'https:';
	const getCookie = (name: string): string | undefined => input.cookie?.(phpCookieName(name, isHttps));
	const baseConfig = createConfig({ host: auth.host, ssl: auth.ssl, user: auth.user });
	const config = structuredClone(baseConfig);
	const session = input.session ?? new PmaSession();
	const theme = loadPreferences(config, session, getCookie(themeCookieName(config.ThemePerServer, auth.serverIndex)), request.params.set_theme);
	const { db, table } = currentDatabaseAndTable(request.params.db, request.params.table);
	const lang = 'en';
	const urlState = (): UrlState => {
		return { server: auth.serverIndex, serverDefault: config.ServerDefault, lang, hasLangCookie: input.hasLangCookie, token: auth.token };
	};
	// SessionCache keeps values in $_SESSION['cache']['server_<n>'].
	const cacheKey = `server_${auth.serverIndex}`;
	const sessionCache = {
		get: (name: string): unknown => (session.data.cache as Record<string, Record<string, unknown>> | undefined)?.[cacheKey]?.[name],
		set: (name: string, value: unknown): void => {
			const cache = (session.data.cache ?? {}) as Record<string, Record<string, unknown>>;
			cache[cacheKey] = { ...cache[cacheKey], [name]: value };
			session.data.cache = cache;
		},
	};
	const dbi = new DatabaseInterface({ connect: input.connect, config, routeUrl: route => getFromRoute(urlState(), route), sessionCache });
	// The renderer reads the context, so it is attached once the rest exists.
	const context = {
		request,
		route: request.route,
		config,
		baseConfig,
		session,
		dbi,
		db,
		table,
		headerDb: db,
		headerTable: table,
		server: auth.serverIndex,
		token: auth.token,
		user: auth.user,
		lang,
		isHttps,
		httpHost: url.host,
		hasLangCookie: input.hasLangCookie,
		getCookie,
		theme,
		urlState,
		templateState: async () => {
			await dbi.connect();
			return {
				url: urlState(),
				config: config as unknown as Record<string, unknown>,
				mysqlVersion: dbi.getVersion(),
				serverType: dbi.isMariaDB() ? 'MariaDB' : (dbi.isPercona() ? 'Percona Server' : 'MySQL'),
				themeImgPath: `./themes/${theme}/img/`,
				themeImages: themeImageSet(theme),
				request: request.params,
			};
		},
	} as PmaContext;
	context.response = new ResponseRenderer(context);
	return context;
}

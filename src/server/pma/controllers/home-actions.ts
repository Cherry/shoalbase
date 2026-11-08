// The small routes the home page calls: connection collation, themes, recent tables, Git revision and version check.
import { jsonHttpHeaders } from '../../../lib/pma/ajax-response.ts';
import { phpCookieName, removeCookieHeader, setCookieHeader } from '../../../lib/pma/cookies.ts';
import { phpJsonEncode } from '../../../lib/pma/json.ts';
import { isInstalledTheme, themeCookieName, themesArray } from '../../../lib/pma/themes.ts';
import { loadUserPreferences, saveUserPreferences, setUserValue } from '../../../lib/pma/user-preferences.ts';
import { PHP_VERSION, latestCompatibleVersion, parseVersionData } from '../../../lib/pma/version-check.ts';
import { getCommon } from '../../../lib/twig/url.ts';
import { configuredServers } from '../../auth-runtime.ts';
import { renderTemplate } from '../../twig/render.ts';
import { getHtmlList } from '../core/recent-favorite-table.ts';

import type { PmaContext } from '../core/context.ts';

const VERSION_URL = 'https://www.phpmyadmin.net/home_page/version.json';
const VERSION_CACHE_SECONDS = 3600 * 6;

// Upstream caches version.json in the session for six hours; an isolate-wide cache is the closest Workers equivalent.
let versionCache: { response: string; timestamp: number; } | undefined;

/** The Location every settings route sends back to: index.php?route=/ plus Url::getCommonRaw([], '&'). */
function homeLocation(context: PmaContext): string {
	return `index.php?route=/${getCommon(context.urlState(), {}, '&')}`;
}

/**
 * Config::setCookie(): a value equal to the default removes the cookie, and an unchanged value sends nothing.
 * `validity` 0 makes a session cookie.
 */
export function setConfigCookie(context: PmaContext, name: string, value: string, defaultValue: string, validity?: number): void {
	const httpName = phpCookieName(name, context.isHttps);
	const current = context.getCookie(name);
	if (value === defaultValue || value === '') {
		if (current !== undefined) {
			context.response.header('Set-Cookie', removeCookieHeader(httpName, context.isHttps));
		}
		return;
	}
	if (current !== value) {
		context.response.header('Set-Cookie', setCookieHeader(httpName, value, { isHttps: context.isHttps, now: new Date(), validity, sameSite: context.config.CookieSameSite }));
	}
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** CollationConnectionController: Config::setUserValue() keeps the choice in the session's user preferences. */
export async function collationConnectionController(context: PmaContext): Promise<Response> {
	const collation = context.request.post.collation_connection;
	const config = context.config as unknown as Record<string, unknown>;
	setUserValue(context.session, config, 'DefaultConnectionCollation', collation ?? null, 'utf8mb4_unicode_ci', nowSeconds());
	context.response.header('Location', homeLocation(context));
	return context.response.response();
}

/** ThemesController: the "View all" themes modal body. */
export async function themesController(context: PmaContext): Promise<Response> {
	const { response } = context;
	const html = await renderTemplate('home/themes', { themes: themesArray(context.theme) }, await context.templateState());
	response.isAjax = true;
	response.addJSON('themes', html);
	return response.response();
}

/** ThemeSetController: sets the theme cookie and records the theme in the session's user preferences. */
export async function themeSetController(context: PmaContext): Promise<Response> {
	const { config, response } = context;
	const requested = context.request.post.set_theme;
	if (config.ThemeManager && requested !== undefined) {
		// An unknown theme is a fatal error upstream; here the active theme simply stays.
		const theme = isInstalledTheme(requested) ? requested : context.theme;
		setConfigCookie(context, themeCookieName(config.ThemePerServer, context.server), theme, config.ThemeDefault);
		const preferences = loadUserPreferences(context.session, nowSeconds());
		preferences.config_data.ThemeDefault = requested;
		saveUserPreferences(context.session, preferences.config_data, nowSeconds());
	}
	response.header('Location', homeLocation(context));
	return response.response();
}

/** RecentTablesListController. */
export async function recentTablesListController(context: PmaContext): Promise<Response> {
	const { response } = context;
	if (response.isAjax) {
		response.addJSON('list', await getHtmlList(context, 'recent'));
	}
	return response.response();
}

/** GitInfoController: a release has no Git checkout, so there is never anything to add. */
export async function gitInfoController(context: PmaContext): Promise<Response> {
	return context.response.response();
}

// Only usable answers are cached, so a failed fetch is retried on the next request.
function rememberVersion(body: string, now: number): void {
	if (parseVersionData(body) !== null) {
		versionCache = { response: body, timestamp: now };
	}
}

async function latestVersionResponse(now: number): Promise<string> {
	if (versionCache !== undefined && now < versionCache.timestamp + VERSION_CACHE_SECONDS) {
		return versionCache.response;
	}
	let body = '';
	try {
		const fetched = await fetch(VERSION_URL, { headers: { 'User-Agent': 'phpMyAdmin/5.2.3' }, signal: AbortSignal.timeout(10000) });
		if (fetched.ok) {
			body = await fetched.text();
		}
	} catch {
		body = '';
	}
	rememberVersion(body, now);
	return body;
}

/** VersionCheckController: a caching proxy for phpmyadmin.net's version.json that answers with the newest compatible release. */
export async function versionCheckController(context: PmaContext): Promise<Response> {
	const now = new Date();
	const headers = jsonHttpHeaders(now);
	const data = context.config.VersionCheck ? parseVersionData(await latestVersionResponse(Math.floor(now.getTime() / 1000))) : null;
	if (data === null) {
		return new Response('[]', { headers });
	}
	const serverCount = configuredServers().length;
	let mysqlVersion: string | null = null;
	if (serverCount === 1) {
		await context.dbi.connect();
		mysqlVersion = context.dbi.getVersionString();
	}
	const latest = latestCompatibleVersion(data.releases, { phpVersion: PHP_VERSION, mysqlVersion, serverCount });
	return new Response(phpJsonEncode({ version: latest?.version ?? '', date: latest?.date ?? '' }), { headers });
}

export const controllers = {
	CollationConnectionController: collationConnectionController,
	ThemesController: themesController,
	ThemeSetController: themeSetController,
	RecentTablesListController: recentTablesListController,
	GitInfoController: gitInfoController,
	VersionCheckController: versionCheckController,
};

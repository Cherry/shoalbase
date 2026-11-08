// Preferences\ManageController: export, import and reset of the session-only user preferences.
import { setConfigCookie } from '../home-actions.ts';
import {
	disableNaviSettings,
	nowSeconds,
	pageInit,
	redirectSaved,
	reloadUserPreferences,
	renderPreferencesHeader,
} from './preferences-forms.ts';
import { noCacheHeaders } from '../../../../lib/pma/ajax-response.ts';
import { phpCookieName, removeCookieHeader } from '../../../../lib/pma/cookies.ts';
import {
	importConfiguration,
	settingsAsJson,
	settingsAsJsonString,
	settingsAsPhp,
	splitReturnUrl,
} from '../../../../lib/pma/misc/preferences-manage.ts';
import { isInstalledTheme, themeCookieName } from '../../../../lib/pma/themes.ts';
import { loadUserPreferences, saveUserPreferences } from '../../../../lib/pma/user-preferences.ts';
import { urlencode } from '../../../../lib/twig/php.ts';
import { renderTemplate } from '../../../twig/render.ts';
import { renderErrors } from '../../core/page-settings.ts';

import type { ControllerContext } from '../../dispatcher.ts';

// $GLOBALS['config']->get('max_upload_size') with the image's 2M upload_max_filesize.
const MAX_UPLOAD_SIZE = 2_097_152;

/** Core::downloadHeader() on a disabled response: no-cache headers plus the attachment ones. */
function download(context: ControllerContext, extension: string, mimeType: string, body: string): Promise<Response> {
	const { response } = context;
	response.disable();
	const filename = `phpMyAdmin-config-${urlencode(context.httpHost)}.${extension}`.replaceAll(/[^\w.-]/g, '_');
	for (const [name, value] of noCacheHeaders(new Date())) {
		response.header(name, value);
	}
	response.header('Content-Description', 'File Transfer');
	response.header('Content-Disposition', `attachment; filename="${filename}"`);
	response.header('Content-Type', mimeType);
	response.header('Content-Transfer-Encoding', 'binary');
	response.addHTML(body);
	return response.response();
}

/** The uploaded settings file, or the json field (filled from local storage) when no usable file came with the form. */
async function importedJson(context: ControllerContext): Promise<string> {
	const { post } = context.request;
	const file = context.files.import_file as File | undefined;
	if (post.import_type === 'text_file' && file !== undefined && file.name !== '' && file.size <= MAX_UPLOAD_SIZE) {
		return file.text();
	}
	return typeof post.json === 'string' ? post.json : '';
}

// json_decode($json, true): only objects and arrays count as a configuration.
function decodeConfiguration(json: string): Record<string, unknown> | null {
	try {
		const decoded = JSON.parse(json) as unknown;
		if (typeof decoded === 'object' && decoded !== null) {
			return { ...decoded };
		}
	} catch {
		return null;
	}
	return null;
}

/** ThemeManager::setThemeCookie() for an imported ThemeDefault; this page keeps the theme it was built with. */
function applyImportedTheme(context: ControllerContext, theme: unknown): void {
	if (theme === undefined || theme === context.theme || !isInstalledTheme(theme)) {
		return;
	}
	setConfigCookie(context, themeCookieName(context.config.ThemePerServer, context.server), theme, context.config.ThemeDefault);
}

/** Returns the response for a finished import, or null when the manage page should be shown. */
async function importSettings(context: ControllerContext): Promise<Response | null> {
	const { request, response, session } = context;
	const json = await importedJson(context);
	// Hides the "import from local storage" offer in the header.
	session.data.userprefs_autoload = true;
	const configuration = decodeConfiguration(json);
	if (configuration === null) {
		return null;
	}
	const cf = pageInit(context);
	const merge = request.post.import_merge !== undefined && request.post.import_merge !== '' && request.post.import_merge !== '0';
	const outcome = importConfiguration(cf, configuration, merge, request.post.fix_errors !== undefined);
	const returnUrl = typeof request.post.return_url === 'string' ? request.post.return_url : null;
	const state = await context.templateState();
	if (!outcome.ok) {
		let formErrors = '';
		for (const page of outcome.errors) {
			formErrors += await renderErrors(page.forms, page.errors, state);
		}
		response.addHTML(await renderPreferencesHeader(context));
		response.addHTML(await renderTemplate('preferences/manage/error', {
			form_errors: formErrors,
			json,
			import_merge: request.post.import_merge ?? null,
			return_url: returnUrl,
		}, state));
		return response.response();
	}
	applyImportedTheme(context, configuration.ThemeDefault);
	const params: Record<string, unknown> = {};
	if (configuration.lang !== undefined && configuration.lang !== null && String(configuration.lang) !== context.lang) {
		params.lang = configuration.lang;
	}
	saveUserPreferences(session, cf.getConfigArray(), nowSeconds());
	let target = 'index.php?route=/preferences/manage';
	if (returnUrl !== null && returnUrl !== '' && returnUrl !== '0') {
		const split = splitReturnUrl(returnUrl);
		target = split.path;
		Object.assign(params, split.params);
	}
	reloadUserPreferences(context);
	redirectSaved(context, target, params);
	return response.response();
}

export async function manageController(context: ControllerContext): Promise<Response> {
	const { request, response, session } = context;
	const { post } = request;
	if (post.submit_export !== undefined && post.export_type === 'text_file') {
		return download(context, 'json', 'application/json', settingsAsJson(loadUserPreferences(session, nowSeconds()).config_data));
	}
	if (post.submit_export !== undefined && post.export_type === 'php_file') {
		return download(context, 'php', 'application/php', settingsAsPhp(loadUserPreferences(session, nowSeconds()).config_data));
	}
	if (post.submit_get_json !== undefined) {
		const settings = loadUserPreferences(session, nowSeconds());
		response.addJSON('prefs', settingsAsJsonString(settings.config_data));
		response.addJSON('mtime', settings.mtime);
		return response.response();
	}
	if (post.submit_import !== undefined) {
		const finished = await importSettings(context);
		if (finished !== null) {
			return finished;
		}
	} else if (post.submit_clear !== undefined) {
		saveUserPreferences(session, {}, nowSeconds());
		// Config::removeCookie('pma_lang') always sends the deletion, and URLs carry lang= once the cookie is gone.
		response.header('Set-Cookie', removeCookieHeader(phpCookieName('pma_lang', context.isHttps), context.isHttps));
		redirectSaved(context, 'index.php?route=/preferences/manage', {}, '', { ...context.urlState(), hasLangCookie: false });
		return response.response();
	}
	response.addScriptFiles(['config.js']);
	const state = await context.templateState();
	response.addHTML(await renderPreferencesHeader(context));
	response.addHTML(await renderTemplate('preferences/manage/main', {
		error: '',
		max_upload_size: MAX_UPLOAD_SIZE,
		exists_setup_and_not_exists_config: false,
	}, state));
	disableNaviSettings(context);
	return response.response();
}

export const controllers = {
	'Preferences/ManageController': manageController,
};

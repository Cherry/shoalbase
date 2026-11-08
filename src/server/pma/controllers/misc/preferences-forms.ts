// Preferences\{Features,Sql,Navigation,MainPanel,Export,Import}Controller: the user preference forms, kept in the session without pmadb.
import { type ConfigForm, itemPath, userForms } from '../../../../lib/pma/config-forms.ts';
import { userFormFields } from '../../../../lib/pma/misc/preferences-manage.ts';
import { UserConfigFile, saveForms } from '../../../../lib/pma/misc/user-config.ts';
import { applySessionPreferences, persistOption, saveUserPreferences } from '../../../../lib/pma/user-preferences.ts';
import { urlencode } from '../../../../lib/twig/php.ts';
import { getCommon, getFromRoute } from '../../../../lib/twig/url.ts';
import { renderTemplate } from '../../../twig/render.ts';
import { renderErrors, renderFormDisplay } from '../../core/page-settings.ts';

import type { FormErrors } from '../../../../lib/pma/misc/user-config.ts';
import type { PmaContext } from '../../core/context.ts';

/** TwoFactor::readConfig() for an account without two-factor authentication, as stored by TwoFactor::save(). */
export const NO_TWO_FACTOR = { backend: '', settings: [], type: 'session' };

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** new ConfigFile($config->baseSettings) and UserPreferences::pageInit(). */
export function pageInit(context: PmaContext): UserConfigFile {
	const cf = new UserConfigFile(context.baseConfig, userFormFields());
	cf.updateWithGlobalConfig(context.config);
	return cf;
}

/** The preferences/header template every preferences page starts with. */
export async function renderPreferencesHeader(context: PmaContext): Promise<string> {
	const saved = context.request.query.saved;
	return renderTemplate('preferences/header', {
		route: context.route,
		is_saved: saved !== undefined && saved !== '' && saved !== '0',
		has_config_storage: false,
	}, await context.templateState());
}

/** Config::loadUserPreferences() after a save: $cfg is rebuilt in place, as the renderer and dbi hold the same object. */
export function reloadUserPreferences(context: PmaContext): void {
	const config: Record<string, unknown> = context.config;
	for (const key of Object.keys(config)) {
		delete config[key];
	}
	Object.assign(config, structuredClone(context.baseConfig));
	applySessionPreferences(context.session, config);
}

/** UserPreferences::redirect(): back to the page with saved=1 and an optional hash. */
export function redirectSaved(context: PmaContext, fileName: string, params: Record<string, unknown>, hash = '', urlState = context.urlState()): void {
	let location = `/${fileName}${getCommon(urlState, { ...params, saved: 1 }, fileName.includes('?') ? '&' : '?')}`;
	if (hash !== '') {
		location += `#${urlencode(hash)}`;
	}
	context.response.header('Location', location);
}

/** AbstractController::redirect() as upstream does it: a Location header, while the page is still rendered. */
export function sendRedirect(context: PmaContext, route: string): void {
	context.response.header('Location', `/index.php?route=${route}${getCommon(context.urlState(), {}, '&')}`);
}

/** Header::getDisplay() leaves the navigation settings out on the preference pages. */
export function disableNaviSettings(context: PmaContext): void {
	if (context.response.isAjax) {
		context.response.addJSON('disableNaviSettings', true);
	} else {
		context.response.naviSettingsDisabled = true;
	}
}

async function preferencesForm(context: PmaContext, formName: string): Promise<Response> {
	const { request, response } = context;
	const forms = userForms(formName) as ConfigForm[];
	const cf = pageInit(context);
	if (request.post.revert !== undefined) {
		// FormDisplay::fixErrors() only changes the unsaved ConfigFile, so reverting is just the redirect.
		sendRedirect(context, context.route);
		return response.response();
	}
	let errors: FormErrors = new Map();
	if (request.post.submit_save !== undefined) {
		const saved = saveForms(cf, forms, key => request.post[key], false);
		errors = saved.errors;
		if (saved.result && errors.size === 0) {
			saveUserPreferences(context.session, cf.getConfigArray(), nowSeconds());
			// TwoFactor::save() writes the account's (empty) two-factor setting back after the forms.
			persistOption(context.session, '2fa', NO_TWO_FACTOR, null, nowSeconds());
			reloadUserPreferences(context);
			const tabHash = typeof request.post.tab_hash === 'string' ? request.post.tab_hash : '';
			redirectSaved(context, `index.php?route=${context.route}`, {}, tabHash.replace(/^#+/, ''));
			return response.response();
		}
	}
	response.addScriptFiles(['config.js']);
	const state = await context.templateState();
	response.addHTML(await renderPreferencesHeader(context));
	let errorsHtml: string | null = null;
	if (errors.size > 0) {
		errorsHtml = await renderErrors(forms, errors, state);
	}
	// FormDisplay shows what the ConfigFile holds, which includes values posted with validation errors.
	const shown = new Map<string, unknown>();
	for (const form of forms) {
		for (const item of form.fields) {
			const path = itemPath(item);
			if (path !== null) {
				shown.set(path, cf.get(path));
			}
		}
	}
	const form = await renderFormDisplay(context, {
		forms,
		groupName: formName,
		errors,
		posted: shown,
		action: getFromRoute(context.urlState(), context.route),
		hiddenFields: { server: context.server },
		showButtons: true,
	}, state);
	response.addHTML(await renderTemplate('preferences/forms/main', { error: '', has_errors: errors.size > 0, errors: errorsHtml, form }, state));
	disableNaviSettings(context);
	return response.response();
}

export const controllers = {
	'Preferences/FeaturesController': (context: PmaContext) => preferencesForm(context, 'Features'),
	'Preferences/SqlController': (context: PmaContext) => preferencesForm(context, 'Sql'),
	'Preferences/NavigationController': (context: PmaContext) => preferencesForm(context, 'Navi'),
	'Preferences/MainPanelController': (context: PmaContext) => preferencesForm(context, 'Main'),
	'Preferences/ExportController': (context: PmaContext) => preferencesForm(context, 'Export'),
	'Preferences/ImportController': (context: PmaContext) => preferencesForm(context, 'Import'),
};

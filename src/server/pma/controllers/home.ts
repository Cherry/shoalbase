// Port of Controllers\HomeController (route /): the start page with settings, appearance and phpMyAdmin links.
import { CHARSETS_QUERY, buildCharsetList, collationsQuery } from '../../../lib/pma/charsets.ts';
import { PMA_VERSION } from '../../../lib/pma/header.ts';
import { configStorageMessage, hasServerSelection, requirementErrors } from '../../../lib/pma/home.ts';
import { languageDisplayName, sortedLanguages } from '../../../lib/pma/languages.ts';
import { themesArray } from '../../../lib/pma/themes.ts';
import { getCommon, getFromRoute } from '../../../lib/twig/url.ts';
import { configuredServers } from '../../auth-runtime.ts';
import { renderTemplate } from '../../twig/render.ts';
import { createTemplateState, toGeneratorState } from '../../twig/state.ts';
import { renderServerSelect } from '../shell/navigation.ts';

import type { PmaContext } from '../core/context.ts';

// ini_get('session.gc_maxlifetime') of the official phpmyadmin image.
const SESSION_GC_MAXLIFETIME = 1440;

// Version::SERIES.
const PMA_SERIES = '5.2';

function notEmpty(value: unknown): boolean {
	return value !== undefined && value !== '' && value !== '0' && !(Array.isArray(value) && value.length === 0);
}

export async function homeController(context: PmaContext): Promise<Response> {
	const { config, dbi, response, server } = context;
	if (response.isAjax && notEmpty(context.request.params.access_time)) {
		return response.response();
	}
	response.addScriptFiles(['home.js']);

	// Upstream sends a POSTed db back so the navigation can refresh it, and the page itself is never about a table.
	const postedDb = context.request.post.db;
	context.db = typeof postedDb === 'string' ? postedDb : '';
	context.table = '';

	if (server > 0 && await dbi.isSuperUser()) {
		await dbi.selectDb('mysql');
	}
	const state = await context.templateState();
	const serverCount = configuredServers().length;

	let serverSelection = '';
	const showServerSelection = hasServerSelection(config, server, serverCount);
	if (showServerSelection) {
		serverSelection = await renderServerSelect(context, state);
	}

	let charsets: ReturnType<typeof buildCharsetList> = [];
	if (server > 0) {
		await dbi.getUserPrivileges();
		const charsetResult = await dbi.query(CHARSETS_QUERY);
		const collationResult = await dbi.query(collationsQuery(dbi.isMariaDB(), dbi.getVersion()));
		charsets = buildCharsetList(charsetResult.fetchAllAssoc(), collationResult.fetchAllAssoc(), dbi.collationConnection);
	}

	let availableLanguages: Record<string, () => unknown>[] = [];
	if (config.Lang === '') {
		availableLanguages = sortedLanguages().map((language) => {
			return {
				getCode: () => language.code,
				getName: () => languageDisplayName(language),
				isActive: () => language.code === context.lang,
			};
		});
	}

	let storageMessage = '';
	if (server > 0) {
		const notice = configStorageMessage(config, getFromRoute(context.urlState(), '/check-relations'), getCommon(context.urlState()));
		storageMessage = notice?.getDisplay(toGeneratorState(createTemplateState(state))) ?? '';
	}

	response.addHTML(await renderTemplate('home/index', {
		db: context.db,
		table: context.table,
		message: '',
		partial_logout: '',
		is_git_revision: false,
		server,
		sync_favorite_tables: '',
		has_server: server > 0 || serverCount > 1,
		is_demo: config.DBG.demo,
		has_server_selection: showServerSelection,
		server_selection: serverSelection,
		has_change_password_link: config.Server.auth_type !== 'config' && config.ShowChgPassword,
		charsets,
		available_languages: availableLanguages,
		// Production sets ShowServerInfo to false, which leaves both server cards out.
		database_server: [],
		web_server: [],
		show_php_info: config.ShowPhpInfo,
		is_version_checked: config.VersionCheck,
		phpmyadmin_version: PMA_VERSION,
		phpmyadmin_major_version: PMA_SERIES,
		config_storage_message: storageMessage,
		has_theme_manager: config.ThemeManager,
		themes: themesArray(context.theme),
		errors: requirementErrors(config, server, SESSION_GC_MAXLIFETIME),
	}, state));
	return response.response();
}

export const controllers = { HomeController: homeController };

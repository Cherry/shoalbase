// Port of the phpMyAdmin 5.2.3 page shell: Header::getDisplay(), Footer::getDisplay() and Scripts::getDisplay().
import {
	type CommonParams,
	PMA_VERSION,
	type ShellConfig,
	addDisplayScripts,
	commonParamsCode,
	defaultScripts,
	defaultShellConfig,
} from '../../lib/pma/header.ts';
import {
	type ScriptEntry,
	type ScriptFile,
	addScriptFile,
	getScriptFiles,
} from '../../lib/pma/scripts.ts';
import { htmlspecialchars } from '../../lib/twig/php.ts';
import { getCommon } from '../../lib/twig/url.ts';
import { renderTemplate } from '../twig/render.ts';
import { type TemplateStateInput, createTemplateState } from '../twig/state.ts';

export interface PageOptions {
	/** The controller output that goes inside #page_content. */
	content: string;
	/** Request globals for the Twig helpers: token, server, lang, pma_lang cookie, MySQL version. */
	state: TemplateStateInput;
	/** Header::getJsParams(), usually from buildCommonParams(). */
	jsParams: CommonParams;
	config?: ShellConfig;
	/** Header::setTitle(); upstream falls back to "phpMyAdmin" when there is no server. */
	title?: string;
	bodyId?: string;
	isLoggedIn: boolean;
	/** AJAX requests get only the content; the caller wraps it in phpMyAdmin's JSON response. */
	isAjax?: boolean;
	/** Footer::setMinimal(): no self link, footer scripts or demo notice (used by the login page). */
	isMinimal?: boolean;
	/** False after Header::disableMenuAndConsole(). */
	menuEnabled: boolean;
	/** False after Header::disableWarnings(). */
	warningsEnabled?: boolean;
	/** Pre-rendered Navigation::getDisplay(); only shown with the menu enabled and a server selected. */
	navigation?: string;
	/** Pre-rendered Menu::getDisplay(); same conditions as navigation. */
	menu?: string;
	/** Pre-rendered Console::getDisplay(); empty when the console is disabled. */
	console?: string;
	/** Header::getMessage() output. */
	messages?: string;
	/** Pre-rendered recent-tables update, which AJAX responses also carry. */
	recentTable?: string;
	/** UserPreferences::autoloadGetHeader() when settings from browser storage can be imported. */
	loadUserPreferences?: string;
	/** Footer #pma_errors content (ErrorHandler::getDispErrors()). */
	errorMessages?: string;
	/** Controller scripts (ResponseRenderer::addScriptFiles()), relative to js/dist/. */
	extraScripts?: ScriptFile[];
	/** Footer::getSelfUrl() parameters. */
	route?: string;
	db?: string;
	table?: string;
	/** Footer::getSelfUrl() as the renderer built it, which also keeps request flags such as single_table. */
	selfUrl?: string;
	/** ini_get('max_input_vars'); the official Docker image sets 10000. */
	maxInputVars?: number;
}

function pageScripts(config: ShellConfig, lang: string, extraScripts: ScriptFile[]): ScriptEntry[] {
	const list = defaultScripts(config, lang);
	for (const file of extraScripts) {
		addScriptFile(list, file);
	}
	return list;
}

/** Scripts::getFiles() for the "scripts" key of AJAX page responses, which never include the display-time scripts. */
export function getAjaxScripts(options: { config?: ShellConfig; lang: string; extraScripts?: ScriptFile[]; }): { name: string; fire: 0 | 1; }[] {
	return getScriptFiles(pageScripts(options.config ?? defaultShellConfig, options.lang, options.extraScripts ?? []));
}

async function renderScripts(files: ScriptEntry[], code: string, state: TemplateStateInput): Promise<string> {
	return renderTemplate('scripts', { base_dir: '', files, version: PMA_VERSION, code }, state);
}

async function renderHeader(options: PageOptions, config: ShellConfig): Promise<string> {
	const state = createTemplateState(options.state);
	const files = pageScripts(config, state.url.lang, options.extraScripts ?? []);
	addDisplayScripts(files, config);
	// Scripts::addCode() appends a newline after each block.
	const variables = await renderTemplate('javascript/variables', {
		first_day_of_calendar: config.FirstDayOfCalendar,
		max_input_vars: options.maxInputVars ?? 10000,
	}, options.state);
	const code = `${commonParamsCode(options.jsParams)}\n${variables}\nConsoleEnterExecutes=${config.ConsoleEnterExecutes ? 'true' : 'false'}\n`;

	const showServerPanels = options.menuEnabled && state.url.server > 0;
	return renderTemplate('header', {
		lang: state.url.lang,
		allow_third_party_framing: config.AllowThirdPartyFraming,
		base_dir: '',
		theme_path: state.themeImgPath.replace(/\/img\/$/, ''),
		version: `v=${PMA_VERSION}`,
		text_dir: 'ltr',
		server: state.url.server,
		// Header::setTitle() and setBodyId() escape once more before the template's own escaping, as upstream does.
		title: htmlspecialchars(options.title ?? 'phpMyAdmin'),
		scripts: await renderScripts(files, code, options.state),
		body_id: htmlspecialchars(options.bodyId ?? ''),
		navigation: showServerPanels ? options.navigation ?? '' : '',
		custom_header: '',
		load_user_preferences: options.loadUserPreferences ?? '',
		show_hint: config.ShowHint,
		is_warnings_enabled: options.warningsEnabled ?? true,
		is_menu_enabled: options.menuEnabled,
		is_logged_in: options.isLoggedIn,
		menu: showServerPanels ? options.menu ?? '' : '',
		console: options.console ?? '',
		messages: options.messages ?? '',
		recent_table: options.recentTable ?? '',
	}, options.state);
}

async function renderFooter(options: PageOptions): Promise<string> {
	const isAjax = options.isAjax ?? false;
	const isMinimal = options.isMinimal ?? false;
	let selfUrl: string | null = null;
	let scripts = '';
	if (!isAjax && !isMinimal) {
		const { url } = createTemplateState(options.state);
		const params: Record<string, unknown> = {};
		if (options.route !== undefined) {
			params.route = options.route;
		}
		if (options.db) {
			params.db = options.db;
		}
		if (options.table) {
			params.table = options.table;
		}
		params.server = url.server;
		selfUrl = options.selfUrl ?? `index.php${getCommon(url, params)}`;
		// Footer::getDebugMessage() is 'null' unless $cfg['DBG']['sql'] is on.
		scripts = await renderScripts([], 'var debugSQLInfo = \'null\';\n', options.state);
	}
	return renderTemplate('footer', {
		is_ajax: isAjax,
		is_minimal: isMinimal,
		self_url: selfUrl,
		error_messages: options.errorMessages ?? '',
		scripts,
		is_demo: false,
		git_revision_info: [],
		footer: '',
	}, options.state);
}

/** ResponseRenderer::getDisplay(): header, content and footer of an HTML page. */
export async function renderPage(options: PageOptions): Promise<string> {
	const config = options.config ?? defaultShellConfig;
	let header = options.recentTable ?? '';
	if (!options.isAjax) {
		header = await renderHeader(options, config);
	}
	return header + options.content + await renderFooter(options);
}

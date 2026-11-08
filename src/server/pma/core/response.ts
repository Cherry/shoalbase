// Port of PhpMyAdmin\ResponseRenderer with its Header and Footer switches: a full HTML page, or the AJAX JSON envelope.
import { sessionCookieHeaders } from './session.ts';
import { shellProviders } from './shell-providers.ts';
import { buildAjaxEnvelope, jsonHttpHeaders, statusHeader } from '../../../lib/pma/ajax-response.ts';
import { shellConfig } from '../../../lib/pma/config.ts';
import { buildCommonParams, pageHttpHeaders, pageTitle } from '../../../lib/pma/header.ts';
import { phpJsonEncode } from '../../../lib/pma/json.ts';
import { Message } from '../../../lib/pma/message.ts';
import { htmlspecialchars } from '../../../lib/twig/php.ts';
import { getCommon } from '../../../lib/twig/url.ts';
import { createTemplateState, toGeneratorState } from '../../twig/state.ts';
import { getAjaxScripts, renderPage } from '../page.ts';
import { renderHeaderMessage } from '../shell/header.ts';

import type { PmaContext } from './context.ts';
import type { ScriptFile } from '../../../lib/pma/scripts.ts';

// PHP's default Content-Type when nothing else is sent (default_charset is UTF-8).
const PHP_DEFAULT_HEADERS: [string, string][] = [['Content-Type', 'text/html; charset=UTF-8']];

// Footer::getSelfUrl() keeps these request parameters for the privileges tabs.
const VIEWING_MODES = new Set(['server', 'db', 'table']);

/** The $GLOBALS the AJAX envelope reads, which controllers may change. */
export interface ResponseGlobals {
	/** $GLOBALS['sql_query']; Common::run() starts it from the POSTed sql_query. */
	sqlQuery: string;
	/** Whether $GLOBALS['error_message'] is set. */
	errorMessage: boolean;
	focusQuerywindow: boolean;
	/** $GLOBALS['reload']: refresh the navigation tree. */
	reload: boolean;
	/** $GLOBALS['message'], which Header::getMessage() shows above the page content. */
	message?: Message | string;
	/** $GLOBALS['display_query'], $GLOBALS['disp_query'] and $GLOBALS['disp_message'], which controllers forwarding to SqlController leave for it. */
	displayQuery?: string;
	dispQuery?: string;
	dispMessage?: Message | string;
}

/** PHP's exit inside Header::getDisplay(), such as a saved navigation settings form: the headers go out without a body. */
export class ResponseExit extends Error {
	constructor() {
		super('exit');
	}
}

export class ResponseRenderer {
	private html = '';
	private readonly json: Record<string, unknown> = {};
	private isSuccess = true;
	private isDisabled = false;
	private status = 200;
	private readonly extraHeaders: [string, string][] = [];
	private location: string | null = null;
	private readonly scripts: ScriptFile[] = [];
	private title = '';
	private bodyId = '';
	private menuEnabled = true;
	private warningsEnabled = true;
	private footerMinimal = false;
	private readonly headerPftext: string;
	/** ResponseRenderer::isAjax(); controllers assign it where upstream calls setAjax(). */
	isAjax: boolean;
	/** Overrides Header::getMessage() output, the "displayMessage" of AJAX responses, when a controller sets it. */
	displayMessage = '';
	/** define('PMA_DISABLE_NAVI_SETTINGS'): the navigation panel leaves out its settings dialog. */
	naviSettingsDisabled = false;
	readonly globals: ResponseGlobals;

	constructor(private readonly context: PmaContext) {
		const ajaxFlag = context.request.params.ajax_request;
		// PHP's !empty(): any value except '' and '0', including an array.
		this.isAjax = ajaxFlag !== undefined && ajaxFlag !== '' && ajaxFlag !== '0';
		const posted = context.request.post.sql_query;
		this.globals = { sqlQuery: typeof posted === 'string' ? posted : '', errorMessage: false, focusQuerywindow: false, reload: false };
		// The Header adds its CommonParams code when it is built, so the page keeps the pftext the request started with.
		this.headerPftext = context.session.data.tmpval?.pftext ?? '';
	}

	private generatorState() {
		return toGeneratorState(createTemplateState({ config: this.context.config as unknown as Record<string, unknown> }));
	}

	/** Header::getJsParams() for the given db and table. */
	private commonParams(db: string, table: string, pftext = this.context.session.data.tmpval?.pftext ?? '') {
		const { config, isHttps, user } = this.context;
		return buildCommonParams({
			url: this.context.urlState(),
			config: shellConfig(config),
			db,
			table,
			sessionGcMaxlifetime: 1440,
			loggedIn: this.context.dbi.isConnected(),
			isHttps,
			authType: config.Server.auth_type,
			user,
			pftext,
		});
	}

	private async display(state: Awaited<ReturnType<PmaContext['templateState']>>): Promise<string> {
		const { context } = this;
		const showServerPanels = this.menuEnabled && context.server > 0;
		let recentTable = '';
		if (this.menuEnabled && context.table !== '') {
			recentTable = await shellProviders.renderRecentTable(context);
		}
		// Header::getDisplay() runs before the content is read, and the navigation may add its settings errors to it.
		let navigation = '';
		if (!this.isAjax && showServerPanels) {
			navigation = await shellProviders.renderNavigation(context);
		}
		const pageOptions = {
			content: this.html,
			state,
			// The Header adds its CommonParams code when it is built, before the controller runs.
			jsParams: this.commonParams(context.headerDb, context.headerTable, this.headerPftext),
			config: shellConfig(context.config),
			title: this.getPageTitle(),
			bodyId: this.bodyId,
			isLoggedIn: context.dbi.isConnected(),
			isAjax: this.isAjax,
			isMinimal: this.footerMinimal,
			menuEnabled: this.menuEnabled,
			warningsEnabled: this.warningsEnabled,
			recentTable,
			extraScripts: this.scripts,
			route: context.route,
			db: context.db,
			table: context.table,
			selfUrl: this.getSelfUrl(),
		};
		if (this.isAjax) {
			return renderPage(pageOptions);
		}
		return renderPage({
			...pageOptions,
			navigation,
			menu: showServerPanels ? await shellProviders.renderMenu(context) : '',
			console: this.menuEnabled ? await shellProviders.renderConsole(context) : '',
			loadUserPreferences: await shellProviders.renderLoadUserPreferences(context),
			messages: await this.headerMessage(),
		});
	}

	private async ajaxBody(state: Awaited<ReturnType<PmaContext['templateState']>>): Promise<string> {
		const { context } = this;
		const envelope = buildAjaxEnvelope({
			json: this.json,
			isSuccess: this.isSuccess,
			display: this.json.message === undefined || this.json.message === null ? await this.display(state) : '',
			title: htmlspecialchars(this.getPageTitle()),
			menu: this.isSuccess ? await shellProviders.renderMenu(context) : null,
			scripts: getAjaxScripts({ config: shellConfig(context.config), lang: context.lang, extraScripts: this.scripts }),
			selflink: this.getSelfUrl(),
			displayMessage: await this.headerMessage(),
			debug: '\'null\'',
			noDebug: Boolean(context.request.params.no_debug),
			errors: '',
			promptPhpErrors: false,
			hasErrorMessage: this.globals.errorMessage,
			db: context.db,
			table: context.table,
			sqlQuery: this.globals.sqlQuery,
			maxCharactersInDisplayedSQL: context.config.MaxCharactersInDisplayedSQL,
			focusQuerywindow: this.globals.focusQuerywindow,
			reload: this.globals.reload,
			params: this.commonParams(context.db, context.table),
		});
		return phpJsonEncode(envelope);
	}

	/** Header::getMessage(): the controller's message global, else the request's message parameter. */
	private async headerMessage(): Promise<string> {
		if (this.displayMessage !== '') {
			return this.displayMessage;
		}
		return renderHeaderMessage(this.context, this.globals.message);
	}

	// PHP turns a 200 into a 302 when a Location header is sent, and the page is still rendered.
	private effectiveStatus(): number {
		if (this.status === 200 && this.extraHeaders.some(([name]) => name.toLowerCase() === 'location')) {
			return 302;
		}
		return this.status;
	}

	/** Builds the HTTP response once the body is final, so session changes made while rendering are stored too. */
	private async finish(body: string | null, status: number, headers: [string, string][]): Promise<Response> {
		const { session, token, isHttps } = this.context;
		const cookies = await sessionCookieHeaders(session, token, isHttps);
		return new Response(body, { status, headers: [...headers, ...cookies.map((line): [string, string] => ['Set-Cookie', line])] });
	}

	addHTML(content: string): void {
		this.html += content;
	}

	/** empty($this->HTML), which decides whether response() takes the echoed output of an exit instead. */
	isHtmlEmpty(): boolean {
		return this.html === '';
	}

	/** ResponseRenderer::addJSON(); messages are rendered when added, like upstream. */
	addJSON(key: string | Record<string, unknown>, value?: unknown): void {
		if (typeof key !== 'string') {
			for (const [name, item] of Object.entries(key)) {
				this.addJSON(name, item);
			}
			return;
		}
		if (value instanceof Message) {
			this.json[key] = value.getDisplay(this.generatorState());
		} else {
			this.json[key] = value;
		}
	}

	setRequestStatus(state: boolean): void {
		this.isSuccess = state;
	}

	/** ResponseRenderer::disable(): no header or footer, and no JSON wrapping. */
	disable(): void {
		this.isDisabled = true;
	}

	/** AbstractController::addScriptFiles(), relative to js/dist/. */
	addScriptFiles(files: (string | ScriptFile)[]): void {
		for (const file of files) {
			this.scripts.push(typeof file === 'string' ? { filename: file } : file);
		}
	}

	/** Header::setTitle(). */
	setTitle(title: string): void {
		this.title = title;
	}

	/** Header::setBodyId(). */
	setBodyId(id: string): void {
		this.bodyId = id;
	}

	/** Header::disableMenuAndConsole(). */
	disableMenuAndConsole(): void {
		this.menuEnabled = false;
	}

	/** Header::disableWarnings(). */
	disableWarnings(): void {
		this.warningsEnabled = false;
	}

	/** Footer::setMinimal(). */
	setMinimal(): void {
		this.footerMinimal = true;
	}

	/** ResponseRenderer::setHttpResponseCode(), including the "status" header it also sends. */
	setHttpResponseCode(code: number): void {
		this.status = code;
		this.extraHeaders.push(statusHeader(code));
	}

	header(name: string, value: string): void {
		this.extraHeaders.push([name, value]);
	}

	/** AbstractController::redirect(); Core::sendHeaderLocation() swaps the leading ./ for the root path, which is / here. */
	redirect(route: string, params: Record<string, unknown> = {}): void {
		this.location = `/index.php?route=${route}${getCommon(this.context.urlState(), params, '&')}`;
	}

	/** Header::getPageTitle(), unescaped. */
	getPageTitle(): string {
		if (this.title !== '') {
			return this.title;
		}
		const { config, server, db, table, httpHost } = this.context;
		const { TitleTable, TitleDatabase, TitleServer, TitleDefault } = config as unknown as Record<string, string>;
		const titles = { TitleTable, TitleDatabase, TitleServer, TitleDefault };
		return pageTitle({ httpHost, server, serverHost: config.Server.host, serverVerbose: config.Server.verbose, db, table, titles });
	}

	/** Footer::getSelfUrl(). */
	getSelfUrl(): string {
		const { request, route, db, table, server } = this.context;
		const params: Record<string, unknown> = { route };
		if (db !== '') {
			params.db = db;
		}
		if (table !== '') {
			params.table = table;
		}
		params.server = server;
		const viewingMode = request.query.viewing_mode;
		if (typeof viewingMode === 'string' && VIEWING_MODES.has(viewingMode)) {
			params.viewing_mode = viewingMode;
		}
		for (const key of ['checkprivsdb', 'checkprivstable']) {
			if (request.query[key] !== undefined) {
				params[key] = request.query[key];
			}
		}
		// Upstream's loose in_array(..., [true, false]) accepts any value.
		if (request.params.single_table !== undefined) {
			params.single_table = request.params.single_table;
		}
		return `index.php${getCommon(this.context.urlState(), params)}`;
	}

	/** ResponseRenderer::response(): the HTTP response for everything the controller added. */
	async response(now: Date = new Date()): Promise<Response> {
		if (this.location !== null) {
			return this.finish(null, 302, [...this.extraHeaders, ['Location', this.location]]);
		}
		if (this.isDisabled) {
			// A controller's header('Content-Type: ...') replaces PHP's default one.
			const hasType = this.extraHeaders.some(([name]) => name.toLowerCase() === 'content-type');
			return this.finish(this.html, this.effectiveStatus(), [...(hasType ? [] : PHP_DEFAULT_HEADERS), ...this.extraHeaders]);
		}
		const state = await this.context.templateState();
		if (this.isAjax) {
			const body = await this.ajaxBody(state);
			return this.finish(body, this.effectiveStatus(), [...jsonHttpHeaders(now), ...this.extraHeaders]);
		}
		const pageHeaders = pageHttpHeaders(shellConfig(this.context.config), now);
		let body: string | null;
		try {
			body = await this.display(state);
		} catch (error) {
			if (!(error instanceof ResponseExit)) {
				throw error;
			}
			body = null;
		}
		return this.finish(body, this.effectiveStatus(), [...pageHeaders, ...this.extraHeaders]);
	}
}

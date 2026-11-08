// Port of the cookie-auth login page from AuthenticationCookie::showLoginForm() in phpMyAdmin 5.2.3.
import { type PageOptions, renderPage } from './page.ts';
import {
	type CommonParams,
	type ShellConfig,
	buildCommonParams,
	defaultShellConfig,
} from '../../lib/pma/header.ts';
import { languageDisplayName, sortedLanguages } from '../../lib/pma/languages.ts';
import { renderMessage } from '../../lib/twig/html.ts';
import { renderTemplate } from '../twig/render.ts';
import { type TemplateStateInput, createTemplateState } from '../twig/state.ts';

export interface LoginServer {
	/** The 1-based $cfg['Servers'] index. */
	index: number;
	host: string;
}

export interface LoginFormOptions {
	servers: LoginServer[];
	/** $GLOBALS['server']: the preselected server index. */
	selectedServer: number;
	/** The remembered user name (LoginCookieRecall). */
	defaultUser?: string;
	/** $conn_error: shown as a raw (unescaped) error alert above the form. */
	error?: string;
	/** ?session_expired=1 without a connection error shows the standard "session has expired" alert. */
	sessionExpiredNotice?: boolean;
	/** ErrorHandler::getDispErrors() output, shown in the #pma_errors block below the form. */
	displayErrors?: string;
	/** check_timeout/session_timedout requests render the form as a modal for the AJAX re-login dialog. */
	sessionTimedOut?: boolean;
	/** session_id() for the set_session field; the CSRF token stands in when there is none. */
	sessionId?: string;
	/** $db and $table to carry through the login. */
	db?: string;
	table?: string;
	state: TemplateStateInput;
}

/** The login form markup that showLoginForm() echoes into the page. */
export async function renderLoginForm(options: LoginFormOptions): Promise<string> {
	const state = createTemplateState(options.state);
	const sessionTimedOut = options.sessionTimedOut ?? false;
	const render = (name: string, context: Record<string, unknown>): Promise<string> => renderTemplate(name, context, options.state);

	let errorMessages = '';
	if (options.error) {
		errorMessages = renderMessage('error', options.error);
	} else if (options.sessionExpiredNotice) {
		errorMessages = renderMessage('error', state.catalog.gettext('Your session has expired. Please log in again.', null));
	}

	const formParams: Record<string, string> = {};
	if (options.db) {
		formParams.db = options.db;
	}
	if (options.table) {
		formParams.table = options.table;
	}

	let serverOptions = '';
	if (options.servers.length > 1) {
		// Select::render(false, false); the production config has no verbose names, ports or only_db.
		serverOptions = await render('server/select/index', {
			not_only_options: false,
			omit_fieldset: false,
			servers: {
				select: options.servers.map((server) => {
					return {
						value: server.index,
						selected: server.index === options.selectedServer ? 1 : 0,
						label: server.host,
					};
				}),
			},
		});
	}

	const languages = sortedLanguages().map((language) => {
		return {
			getCode: () => language.code,
			getName: () => languageDisplayName(language),
			isActive: () => language.code === state.url.lang,
		};
	});

	return render('login/form', {
		login_header: await render('login/header', { add_class: sessionTimedOut ? ' modal_form' : '', session_expired: sessionTimedOut ? 1 : 0 }),
		is_demo: false,
		error_messages: errorMessages,
		available_languages: languages,
		is_session_expired: sessionTimedOut,
		// LoginCookieRecall with a blowfish_secret set, as in production.
		has_autocomplete: true,
		session_id: options.sessionId ?? state.url.token,
		is_arbitrary_server_allowed: false,
		default_server: '',
		default_user: options.defaultUser ?? '',
		has_servers: options.servers.length > 1,
		server_options: serverOptions,
		server: options.selectedServer,
		lang: state.url.lang,
		has_captcha: false,
		use_captcha_checkbox: false,
		captcha_api: '',
		captcha_req: '',
		captcha_resp: '',
		captcha_key: '',
		form_params: formParams,
		errors: options.displayErrors ?? '',
		login_footer: await render('login/footer', { session_expired: sessionTimedOut ? 1 : 0 }),
		config_footer: '',
	});
}

export interface LoginPageOptions extends LoginFormOptions {
	config?: ShellConfig;
	/** Config::isHttps() for CommonParams.is_https. */
	isHttps?: boolean;
	/** Header::getJsParams(); defaults to the logged-out values upstream sends. */
	jsParams?: CommonParams;
}

/** The full login page, with the header settings ResponseRenderer::loginPage() applies. */
export async function renderLoginPage(options: LoginPageOptions): Promise<string> {
	const config = options.config ?? defaultShellConfig;
	// Logged out, DatabaseInterface still reports its default version (55000), which picks the 5.7 manual.
	const state: TemplateStateInput = { mysqlVersion: 55000, ...options.state };
	const jsParams = options.jsParams ?? buildCommonParams({
		url: createTemplateState(state).url,
		config,
		// session.gc_maxlifetime from the official image's php.ini.
		sessionGcMaxlifetime: 1440,
		loggedIn: false,
		isHttps: options.isHttps ?? false,
		authType: 'cookie',
		user: 'root',
	});
	const page: PageOptions = {
		content: await renderLoginForm({ ...options, state }),
		state,
		jsParams,
		config,
		title: 'phpMyAdmin',
		bodyId: 'loginform',
		isLoggedIn: false,
		isMinimal: true,
		menuEnabled: false,
		warningsEnabled: false,
	};
	return renderPage(page);
}

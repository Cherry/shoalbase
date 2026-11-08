import type { APIContext } from 'astro';
import type { LoginFormState } from '~/server/login-flow';

import { createSessionToken } from '~/lib/auth';
import { defaultShellConfig, pageHttpHeaders } from '~/lib/pma/header';
import { type PmaRequest, scalarParam } from '~/lib/pma-request';
import { htmlspecialchars } from '~/lib/twig/php';
import { renderLoginPage as renderUpstreamLoginPage } from '~/server/pma/login';

// phpMyAdmin remembers the chosen language for 30 days; the cookie also changes the shape of generated URLs.
const LANG_COOKIE = 'pma_lang';
const LANG_COOKIE_MAX_AGE = 2_592_000;

/** ErrorHandler::getDispErrors() markup for the driver error shown in #pma_errors. */
const displayError = (message: string): string => `<div class="alert alert-danger" role="alert"><img src="themes/dot.gif" title="" alt="" class="icon ic_s_error"> ${htmlspecialchars(message)}</div>`;

export const renderLoginPage = async (astro: APIContext, form: LoginFormState, request: PmaRequest): Promise<Response> => {
	const hasLangCookie = astro.cookies.has(LANG_COOKIE);
	const body = await renderUpstreamLoginPage({
		servers: form.servers.map((server, index) => { return { index: index + 1, host: server.host }; }),
		selectedServer: form.selectedServer,
		defaultUser: form.defaultUser,
		error: form.alertMessage === '' ? undefined : form.alertMessage,
		displayErrors: form.driverError === '' ? undefined : displayError(form.driverError),
		db: scalarParam(request.params, 'db'),
		table: scalarParam(request.params, 'table'),
		// There is no session before login, so this token is only a placeholder that the login POST does not check.
		state: { url: { token: createSessionToken(), server: form.selectedServer, hasLangCookie } },
		isHttps: astro.url.protocol === 'https:',
	});
	if (!hasLangCookie) {
		astro.cookies.set(LANG_COOKIE, 'en', { path: '/', httpOnly: true, sameSite: 'strict', secure: astro.url.protocol === 'https:', maxAge: LANG_COOKIE_MAX_AGE });
	}
	return new Response(body, { headers: pageHttpHeaders(defaultShellConfig, new Date()) });
};

import type { APIContext } from 'astro';

import { AUTH_COOKIE } from '~/lib/auth';
import { Message } from '~/lib/pma/message';
import {
	type PmaRequest,
	type RequestParams,
	buildPmaRequest,
	paramsFrom,
} from '~/lib/pma-request';
import { matchRoute } from '~/lib/pma-router';
import { htmlspecialchars } from '~/lib/twig/php';
import { attemptLogin, initialLoginForm } from '~/server/login-flow';
import { type PmaContext, createPmaContext } from '~/server/pma/core/context';
import { checkProfiling } from '~/server/pma/core/profiling';
import { loadPmaSession, sessionCookieNames } from '~/server/pma/core/session';
import { renderLoginPage } from '~/server/pma/login-page';
import { upstreamRoutes } from '~/server/pma/upstream-routes';

/** Common::run()'s request globals plus the Astro request; see core/context.ts for each field. */
export interface ControllerContext extends PmaContext {
	astro: APIContext;
	/** Placeholders of the matched upstream route, such as {engine}. */
	params: Record<string, string>;
	/** $_FILES: uploaded files of a multipart POST by field name. */
	files: Record<string, File>;
}

export type Controller = (context: ControllerContext) => Promise<Response>;

const NO_STORE = 'no-store, no-cache, must-revalidate';
const LOGIN_URL = './index.php?route=/';

const json = (body: Record<string, unknown>): Response => Response.json(body, { headers: { 'Cache-Control': NO_STORE } });

// Each module under controllers/ exports `controllers` keyed by upstream controller class (see upstream-routes.ts), so ports can land independently.
const controllerModules = import.meta.glob<{ controllers?: Record<string, Controller>; }>(['./controllers/**/*.ts', '!./controllers/**/*.test.ts'], { eager: true });

const controllers: Record<string, Controller> = {
	// LogoutController: only a POST carrying the session token logs out, so a cross-site link cannot sign users out.
	LogoutController: async ({ astro, request }) => {
		if (request.method === 'POST' && !request.tokenMismatch) {
			astro.cookies.delete(AUTH_COOKIE, { path: '/' });
			// Session::destroy(): the next login starts with an empty $_SESSION.
			for (const name of sessionCookieNames(cookie => astro.cookies.get(cookie)?.value)) {
				astro.cookies.delete(name, { path: '/' });
			}
		}
		return astro.redirect(LOGIN_URL, 302);
	},
};
for (const module of Object.values(controllerModules)) {
	Object.assign(controllers, module.controllers ?? {});
}

const signedOut = async (astro: APIContext, request: PmaRequest, rawPost: Record<string, unknown>): Promise<Response> => {
	if (request.isAjax) {
		// phpMyAdmin's ajax.js reloads into the login page when it sees redirect_flag.
		return json({ redirect_flag: '1', success: false, error: '' });
	}
	if (request.method === 'POST' && typeof rawPost.pma_username === 'string') {
		const attempt = await attemptLogin(astro.cookies, astro.url, {
			username: rawPost.pma_username,
			password: typeof rawPost.pma_password === 'string' ? rawPost.pma_password : '',
			server: rawPost.server,
		});
		if (attempt.status === 'signed-in') {
			return astro.redirect(`./index.php?route=${encodeURIComponent(request.route)}`, 302);
		}
		return renderLoginPage(astro, attempt.form, request);
	}
	return renderLoginPage(astro, await initialLoginForm(astro.cookies, astro.locals.sessionExpired === true), request);
};

/** phpMyAdmin's front controller: index.php?route=... */
export const dispatch = async (astro: APIContext): Promise<Response> => {
	const method = astro.request.method;
	const query = paramsFrom(astro.url.searchParams.entries());
	let rawPost: RequestParams = {};
	const files: Record<string, File> = {};
	if (method === 'POST' && (astro.request.headers.get('content-type') ?? '').includes('form')) {
		const formData = await astro.request.formData();
		rawPost = paramsFrom(formData.entries());
		for (const [name, value] of formData.entries()) {
			if (typeof value !== 'string') {
				files[name] = value;
			}
		}
	}
	const { auth, connection } = astro.locals;
	// rawPost is already parsed; parsing it again would drop the name[] lists.
	const request = buildPmaRequest(method, query, rawPost, auth?.token);
	if (!auth || !connection) { return signedOut(astro, request, rawPost); }

	const match = matchRoute(upstreamRoutes, method, request.route);
	const context = createPmaContext({
		request,
		url: astro.url,
		auth,
		connect: () => connection.get(),
		hasLangCookie: astro.cookies.has('pma_lang'),
		cookie: name => astro.cookies.get(name)?.value,
		session: await loadPmaSession(name => astro.cookies.get(name)?.value, auth.token),
	});
	// Common::run(): an AJAX POST with a bad token is refused outright rather than processed with its parameters stripped.
	if (context.response.isAjax && method === 'POST' && request.tokenMismatch) {
		context.response.setRequestStatus(false);
		context.response.addJSON('message', Message.error('Error: Token mismatch'));
		return context.response.response();
	}
	await checkProfiling(context);
	// Routing::callControllerForRoute() echoes these errors into the normal page, with the full shell around them.
	if (match.status === 'method-not-allowed') {
		context.response.setHttpResponseCode(405);
		context.response.addHTML(Message.error('Error 405! Request method not allowed.').getDisplay());
		return context.response.response();
	}
	// A route without a controller module answers like an unknown one rather than crashing.
	if (match.status === 'not-found' || !(match.route.controller in controllers)) {
		context.response.setHttpResponseCode(404);
		context.response.addHTML(Message.error(`Error 404! The page <code>${htmlspecialchars(request.route)}</code> was not found.`).getDisplay());
		return context.response.response();
	}
	// Controllers change globals such as db on the same object the renderer reads, so the context is extended rather than copied.
	return controllers[match.route.controller](Object.assign(context, { astro, params: match.params, files }));
};

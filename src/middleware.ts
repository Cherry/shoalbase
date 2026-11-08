import { defineMiddleware } from 'astro:middleware';
import { waitUntil } from 'cloudflare:workers';

import { entryPoint } from '~/lib/auth';
import { createRequestConnection } from '~/lib/connection';
import { serverKey } from '~/lib/servers';
import { withShoalbaseMark } from '~/server/branding';
import { connectFromWorker } from '~/server/mysql-connector';
import { requestParams } from '~/server/request-form';
import { beginSession, requestCookies } from '~/server/session-runtime';

// Apache's own 404 page with ServerSignature off, since the docroot has nothing but phpMyAdmin's PHP scripts and static files.
// eslint-disable-next-line unicorn/prefer-https -- Apache's doctype is quoted byte for byte.
const NOT_FOUND_BODY = `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd">
<html><head>
<title>404 Not Found</title>
</head><body>
<h1>Not Found</h1>
<p>The requested URL was not found on this server.</p>
</body></html>
`;

// Astro streams page bodies after middleware returns, so the connection can only be closed once the body has been fully sent.
const closeAfterBody = (response: Response, close: () => Promise<void>): Response => {
	if (!response.body) {
		waitUntil(close());
		return response;
	}
	const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
	waitUntil(response.body.pipeTo(writable).catch(() => {}).finally(close));
	return new Response(readable, response);
};

export const onRequest = defineMiddleware(async (context, next) => {
	const entry = entryPoint(context.url.pathname);
	if (entry === null) {
		return new Response(NOT_FOUND_BODY, { status: 404, headers: { 'Content-Type': 'text/html; charset=iso-8859-1' } });
	}
	if (entry === 'public') {
		return next();
	}

	const { locals } = context;
	const cookies = requestCookies(name => context.cookies.get(name)?.value, context.url, locals);
	const state = await beginSession(cookies, await requestParams(context.request, context.url, locals), context.request.method);
	locals.sessionId = state.id;
	if (state.status === 'signed-out') {
		// phpMyAdmin shows its login form at whatever index.php URL was requested, so the dispatcher handles signed-out requests itself.
		locals.sessionExpired = state.expiredValidity;
		return withShoalbaseMark(await next());
	}

	const { config } = state;
	locals.session = state.session;
	locals.auth = { user: state.user, host: config.host, server: serverKey(config), serverIndex: state.server, token: state.token };
	const connection = createRequestConnection({
		host: config.host,
		port: config.port,
		user: state.user,
		password: state.password,
		ssl: config.ssl,
		pin: config.pin,
	}, connectFromWorker);
	locals.connection = connection;
	let response: Response;
	try {
		response = await next();
	} catch (error) {
		await connection.close();
		throw error;
	}
	return closeAfterBody(withShoalbaseMark(response), () => connection.close());
});

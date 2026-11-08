import { defineMiddleware } from 'astro:middleware';
import { waitUntil } from 'cloudflare:workers';

import { AUTH_COOKIE, authSessionState, entryPoint } from '~/lib/auth';
import { createRequestConnection } from '~/lib/connection';
import { findServer, serverIndex, serverKey } from '~/lib/servers';
import {
	configuredServers,
	cookieCipher,
	cookieOptions,
	nowSeconds,
} from '~/server/auth-runtime';
import { withShoalbaseMark } from '~/server/branding';
import { connectFromWorker } from '~/server/mysql-connector';

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

	const cipher = await cookieCipher();
	const now = nowSeconds();
	const state = authSessionState(await cipher.open(AUTH_COOKIE, context.cookies.get(AUTH_COOKIE)?.value), now);
	const servers = configuredServers();
	const server = state.status === 'valid' ? findServer(servers, state.session.server) : undefined;
	if (state.status !== 'valid' || !server) {
		// Only clear a cookie the browser actually sent, so a fresh visitor gets no Set-Cookie that phpMyAdmin would not send.
		if (context.cookies.has(AUTH_COOKIE)) {
			context.cookies.delete(AUTH_COOKIE, { path: '/' });
		}
		// phpMyAdmin shows its login form at whatever index.php URL was requested, so the dispatcher handles signed-out requests itself.
		context.locals.sessionExpired = state.status === 'expired';
		return withShoalbaseMark(await next());
	}

	const { session } = state;
	// Sliding expiry: each request restarts phpMyAdmin's LoginCookieValidity inactivity window.
	context.cookies.set(AUTH_COOKIE, await cipher.seal(AUTH_COOKIE, { ...session, lastActivity: now }), cookieOptions(context.url));
	context.locals.auth = { user: session.user, host: server.host, server: serverKey(server), serverIndex: serverIndex(servers, serverKey(server)), token: session.token };

	const connection = createRequestConnection({
		host: server.host,
		port: server.port,
		user: session.user,
		password: session.password,
		ssl: server.ssl,
		pin: server.pin,
	}, connectFromWorker);
	context.locals.connection = connection;
	let response: Response;
	try {
		response = await next();
	} catch (error) {
		await connection.close();
		throw error;
	}
	return closeAfterBody(withShoalbaseMark(response), () => connection.close());
});

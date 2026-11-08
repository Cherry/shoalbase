// The request side of phpMyAdmin's session and cookie login: the phpMyAdmin cookie names the PmaSessionObject that holds $_SESSION, as a
// PHP session id names its session file, and pmaUser-n and pmaAuth-n carry the username and password the way AuthenticationCookie does.
import { env } from 'cloudflare:workers';

import type { PmaSessionObject } from '~/server/session-object';

import {
	type CookieCipher,
	RECALL_COOKIE_MAX_AGE_SECONDS,
	SESSION_COOKIE,
	authCookieName,
	createSessionCipher,
	createSessionId,
	isSessionId,
	sessionObjectName,
	userCookieName,
} from '~/lib/auth';
import { phpCookieName, removeCookieHeader, setCookieHeader } from '~/lib/pma/cookies';
import { MAX_SESSION_BYTES, PmaSession, sessionBytes } from '~/lib/pma/session';
import { type RequestParams, scalarParam } from '~/lib/pma-request';
import { type ServerConfig, selectServer, serverKey } from '~/lib/servers';
import {
	ENCRYPTION_KEY,
	type SessionAccess,
	TOKEN_KEY,
	newSession,
} from '~/lib/session-access';
import { configuredServers, cookieCipher, nowSeconds } from '~/server/auth-runtime';


/** The request's cookies as Config::getCookie() names them, and the Set-Cookie lines its response will carry. */
export class PhpCookies {
	constructor(private readonly read: (name: string) => string | undefined, readonly isHttps: boolean, readonly lines: Map<string, string>) {}

	get(name: string): string | undefined {
		return this.read(phpCookieName(name, this.isHttps));
	}

	/** Config::setCookie(); `validity` 0 makes a cookie that ends with the browser session, and the default lasts a month. */
	set(name: string, value: string, validity?: number): void {
		const cookie = phpCookieName(name, this.isHttps);
		this.lines.set(cookie, setCookieHeader(cookie, value, { isHttps: this.isHttps, now: new Date(), validity }));
	}

	/** Config::removeCookie(). */
	remove(name: string): void {
		const cookie = phpCookieName(name, this.isHttps);
		this.lines.set(cookie, removeCookieHeader(cookie, this.isHttps));
	}

	/** PHP's session cookie, which it sends on every request that uses the session. */
	setSession(id: string): void {
		this.set(SESSION_COOKIE, id, 0);
	}
}

/** The cookies of an index.php request, sharing the Set-Cookie lines the middleware started. */
export function requestCookies(read: (name: string) => string | undefined, url: URL, locals: App.Locals): PhpCookies {
	locals.cookieLines ??= new Map();
	return new PhpCookies(read, url.protocol === 'https:', locals.cookieLines);
}

/** Adds the request's Set-Cookie lines to its response. */
export function withCookieLines(response: Response, lines: Map<string, string> | undefined): Response {
	if (lines === undefined || lines.size === 0) {
		return response;
	}
	// Some responses, such as redirects, have immutable headers, so the lines go on a copy.
	const result = new Response(response.body, response);
	for (const line of lines.values()) {
		result.headers.append('Set-Cookie', line);
	}
	return result;
}

type SessionStub = DurableObjectStub<PmaSessionObject>;

const isRetryable = (error: unknown): boolean => {
	if (typeof error !== 'object' || error === null) {
		return false;
	}
	const flags = error as { retryable?: unknown; overloaded?: unknown; };
	return flags.retryable === true && flags.overloaded !== true;
};

// A transient failure the runtime marks retryable gets one more try on a fresh stub; an overloaded object is not retried.
async function withSession<T>(id: string, call: (stub: SessionStub) => Promise<T>): Promise<T> {
	const name = await sessionObjectName(id);
	try {
		return await call(env.PMA_SESSIONS.getByName(name));
	} catch (error) {
		if (!isRetryable(error)) {
			throw error;
		}
		return await call(env.PMA_SESSIONS.getByName(name));
	}
}

// Binds a login cookie to its name and server, so a cookie from another server number (after PMA_SERVERS changed) does not decrypt.
const cookieContext = (name: string, server: ServerConfig): string => `${name}@${serverKey(server)}`;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** AuthenticationCookie::rememberCredentials(): both login cookies are encrypted again on every signed-in request. */
async function rememberCredentials(cookies: PhpCookies, server: number, config: ServerConfig, user: string, password: string, sessionCipher: CookieCipher): Promise<void> {
	const secret = await cookieCipher();
	cookies.set(userCookieName(server), await secret.seal(cookieContext(userCookieName(server), config), user), RECALL_COOKIE_MAX_AGE_SECONDS);
	// LoginCookieStore = 0: the password cookie ends with the browser session.
	cookies.set(authCookieName(server), await sessionCipher.seal(cookieContext(authCookieName(server), config), { password }), 0);
}

export type SessionBegin = {
	status: 'signed-in';
	id: string;
	session: PmaSession;
	/** $GLOBALS['server']. */
	server: number;
	config: ServerConfig;
	user: string;
	password: string;
	token: string;
} | {
	status: 'signed-out';
	/** The id the response sends: a fresh one from Session::secure(), or the expired session's own, as showFailure() keeps it. */
	id: string;
	/** LoginCookieValidity when the session just expired from inactivity. */
	expiredValidity?: number;
};

/**
 * AuthenticationCookie::readCredentials() for an index.php request ($_REQUEST in `params`): the session must exist and have been active
 * within LoginCookieValidity, the username cookie must decrypt with PMA_COOKIE_SECRET and the password cookie with the session's key.
 */
export async function beginSession(cookies: PhpCookies, params: RequestParams, method: string): Promise<SessionBegin> {
	const servers = configuredServers();
	const server = selectServer(servers, params.server);
	const config = servers[server - 1];
	const previous = cookies.get(SESSION_COOKIE);
	const id = isSessionId(previous) ? previous : undefined;

	// Session::secure(): a signed-out request gets a fresh session id, and a session this browser was signed in with is discarded.
	const signOut = async (discard: boolean): Promise<SessionBegin> => {
		if (id !== undefined && discard) {
			await withSession(id, stub => stub.destroy());
		}
		const fresh = createSessionId();
		cookies.setSession(fresh);
		return { status: 'signed-out', id: fresh };
	};
	// Only a browser holding a password cookie can have a live session, so other signed-out requests skip the call.
	const holdsLogin = servers.some((_server, index) => cookies.get(authCookieName(index + 1)) !== undefined);
	const username = scalarParam(params, 'pma_username');
	if (id === undefined || (method === 'POST' && username !== undefined && username !== '')) {
		return signOut(holdsLogin);
	}
	const secret = await cookieCipher();
	const user = await secret.open(cookieContext(userCookieName(server), config), cookies.get(userCookieName(server)));
	if (typeof user !== 'string') {
		return signOut(holdsLogin);
	}
	const ajaxFlag = scalarParam(params, 'ajax_request');
	const started = await withSession(id, stub => stub.start({ guid: params.guid, accessTime: params.access_time, ajax: ajaxFlag === 'true' || ajaxFlag === '1' }));
	if (started.status === 'expired') {
		// showFailure('no-activity') removes the password cookie and keeps the session id, so a page reloaded after an AJAX request can still show why.
		cookies.setSession(id);
		cookies.remove(authCookieName(server));
		return { status: 'signed-out', id, expiredValidity: started.validity };
	}
	if (started.status === 'missing') {
		return signOut(false);
	}
	const sessionCipher = await createSessionCipher(started.data[ENCRYPTION_KEY]);
	const credentials = await sessionCipher?.open(cookieContext(authCookieName(server), config), cookies.get(authCookieName(server)));
	const token = started.data[TOKEN_KEY];
	if (!sessionCipher || !isRecord(credentials) || typeof credentials.password !== 'string' || typeof token !== 'string') {
		return signOut(true);
	}
	cookies.setSession(id);
	await rememberCredentials(cookies, server, config, user, credentials.password, sessionCipher);
	return { status: 'signed-in', id, session: new PmaSession(started.data), server, config, user, password: credentials.password, token };
}

/** The username LoginCookieRecall fills the login form with for a server, or '' when its cookie is missing or does not decrypt. */
export async function recalledUser(cookies: PhpCookies, server: number): Promise<string> {
	const config = configuredServers()[server - 1];
	const secret = await cookieCipher();
	const user = await secret.open(cookieContext(userCookieName(server), config), cookies.get(userCookieName(server)));
	return typeof user === 'string' ? user : '';
}

/** A successful login: Session::secure() starts a new session (the middleware already discarded the old one) and the login cookies are set. */
export async function createLoginSession(cookies: PhpCookies, server: number, user: string, password: string, access: SessionAccess): Promise<void> {
	const config = configuredServers()[server - 1];
	const id = createSessionId();
	const data = newSession(access, nowSeconds());
	const sessionCipher = await createSessionCipher(data[ENCRYPTION_KEY]);
	if (!sessionCipher) {
		throw new Error('A new session must carry a valid encryption key.');
	}
	await withSession(id, stub => stub.create(data));
	cookies.setSession(id);
	await rememberCredentials(cookies, server, config, user, password, sessionCipher);
}

/** AuthenticationCookie::handlePasswordChange(): the password cookie is encrypted again with the new password. */
export async function storePasswordCookie(cookies: PhpCookies, server: number, session: PmaSession, password: string): Promise<void> {
	const config = configuredServers()[server - 1];
	const sessionCipher = await createSessionCipher(session.data[ENCRYPTION_KEY]);
	if (config && sessionCipher) {
		cookies.set(authCookieName(server), await sessionCipher.seal(cookieContext(authCookieName(server), config), { password }), 0);
	}
}

/** Stores what a request changed in $_SESSION; a session that would outgrow MAX_SESSION_BYTES keeps its previous state. */
export async function saveSession(id: string, session: PmaSession): Promise<void> {
	const changes = session.changes();
	if (changes === null) {
		return;
	}
	if (sessionBytes(session.data) > MAX_SESSION_BYTES) {
		console.warn(`Session changes not saved: the session would exceed ${MAX_SESSION_BYTES} bytes.`);
		return;
	}
	await withSession(id, stub => stub.update(changes));
}

/** AuthenticationCookie::logOut() with LoginCookieDeleteAll: every password cookie is removed and session_destroy() deletes the session. */
export async function logOut(cookies: PhpCookies, id: string): Promise<void> {
	await withSession(id, stub => stub.destroy());
	for (let server = 1; server <= configuredServers().length; server++) {
		cookies.remove(authCookieName(server));
	}
}

/** Creates a signed-in session directly, for scripts/render-route.ts, which skips the login form; returns its id. */
export async function createScriptSession(access: SessionAccess = {}): Promise<string> {
	const id = createSessionId();
	const data = newSession(access, nowSeconds());
	await withSession(id, stub => stub.create(data));
	return id;
}

/** Loads a session for scripts/render-route.ts, which signs in without cookies. */
export async function startScriptSession(id: string): Promise<{ session: PmaSession; token: string; }> {
	const started = await withSession(id, stub => stub.start({}));
	if (started.status !== 'active') {
		throw new Error(`The script session is ${started.status}.`);
	}
	return { session: new PmaSession(started.data), token: String(started.data[TOKEN_KEY]) };
}

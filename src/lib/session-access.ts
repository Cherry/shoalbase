// AuthenticationCookie's inactivity bookkeeping in $_SESSION: the access time of each browser window, checked against LoginCookieValidity.
import { LOGIN_COOKIE_VALIDITY_SECONDS, createEncryptionKey, createSessionToken } from './auth.ts';

/** $_SESSION['browser_access_time']: guid => the time that window was last active. */
export const ACCESS_TIMES_KEY = 'browser_access_time';
/** $_SESSION[' PMA_token ']: the CSRF token every form and link carries. */
export const TOKEN_KEY = ' PMA_token ';
/** $_SESSION['encryption_key']: the per-session key of the password cookie. */
export const ENCRYPTION_KEY = 'encryption_key';
/** How long an expired session is kept before its alarm deletes it, so the next request can still say why the user was signed out. */
export const SESSION_GC_GRACE_SECONDS = 300;

export type SessionData = Record<string, unknown>;

/** The access parameters of one request: $_REQUEST['guid'] and $_REQUEST['access_time']. */
export interface SessionAccess {
	guid?: unknown;
	accessTime?: unknown;
	/** An AJAX request, whose response cannot show the inactivity notice itself. */
	ajax?: boolean;
}

export type SessionStart = { status: 'missing'; } | { status: 'expired'; validity: number; } | { status: 'active'; data: SessionData; };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// PHP's intval() of a request value: the leading number of a string, 1 for a non-empty array, else 0.
function phpIntval(value: unknown): number {
	if (typeof value !== 'string') {
		return Array.isArray(value) && value.length > 0 ? 1 : 0;
	}
	const match = /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.exec(value);
	if (!match) {
		return 0;
	}
	return Math.trunc(Number(match[0]));
}

/** Config::getLoginCookieValidityFromCache(): the user's LoginCookieValidity preference, else the default. */
export function loginCookieValidity(data: SessionData): number {
	const preferences = isRecord(data.userconfig) && isRecord(data.userconfig.db) ? data.userconfig.db : {};
	const value = Number(preferences.LoginCookieValidity);
	if (Number.isSafeInteger(value) && value > 0) {
		return value;
	}
	return LOGIN_COOKIE_VALIDITY_SECONDS;
}

function accessTimes(data: SessionData): Record<string, number> {
	const stored = data[ACCESS_TIMES_KEY];
	if (!isRecord(stored)) {
		return {};
	}
	return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, number] => typeof entry[1] === 'number'));
}

// AuthenticationPlugin::setSessionAccessTime(): access_time is how long the window has been idle, capped so it cannot extend the session.
function recordAccess(times: Record<string, number>, access: SessionAccess, now: number, validity: number): Record<string, number> {
	let guid = 'default';
	if (typeof access.guid === 'string') {
		guid = access.guid;
	} else if (Array.isArray(access.guid)) {
		// PHP's (string) cast of an array.
		guid = 'Array';
	}
	let time = now;
	if (access.accessTime !== undefined) {
		time = now - Math.min(Math.max(0, phpIntval(access.accessTime)), validity + 1);
	}
	return { ...times, [guid]: time };
}

/**
 * AuthenticationCookie::readCredentials()'s inactivity check, then setSessionAccessTime(): windows idle longer than LoginCookieValidity
 * are forgotten, the session expires once none is left, and otherwise this request's window is marked active.
 */
export function touchSession(data: SessionData, access: SessionAccess, now: number): SessionStart {
	const times = accessTimes(data);
	// A session nobody signed in to yet, as upstream's "user was never logged in since session start".
	if (Object.keys(times).length === 0) {
		return { status: 'missing' };
	}
	const validity = loginCookieValidity(data);
	const active = Object.fromEntries(Object.entries(times).filter(([, time]) => time >= now - validity));
	if (Object.keys(active).length === 0) {
		return { status: 'expired', validity };
	}
	return { status: 'active', data: { ...data, [ACCESS_TIMES_KEY]: recordAccess(active, access, now, validity) } };
}

/** When the session's alarm should run: once its most recent window has been idle past LoginCookieValidity plus the grace period, in seconds. */
export function sessionDeadline(data: SessionData): number | null {
	const times = Object.values(accessTimes(data));
	if (times.length === 0) {
		return null;
	}
	return Math.max(...times) + loginCookieValidity(data) + SESSION_GC_GRACE_SECONDS;
}

/** The $_SESSION a login starts with: Session::secure()'s fresh token, the password cookie's key and this request's access time. */
export function newSession(access: SessionAccess, now: number): SessionData {
	return {
		[TOKEN_KEY]: createSessionToken(),
		[ENCRYPTION_KEY]: createEncryptionKey(),
		[ACCESS_TIMES_KEY]: recordAccess({}, access, now, LOGIN_COOKIE_VALIDITY_SECONDS),
	};
}

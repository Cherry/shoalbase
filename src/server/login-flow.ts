import type { AstroCookies } from 'astro';

import {
	AUTH_COOKIE,
	CANNOT_LOG_IN_MESSAGE,
	RECALL_COOKIE,
	RECALL_COOKIE_MAX_AGE_SECONDS,
	connectionErrorMessage,
	createSessionToken,
	loginFailureMessage,
	recalledLogin,
} from '~/lib/auth';
import {
	type ServerConfig,
	serverByIndex,
	serverIndex,
	serverKey,
} from '~/lib/servers';
import {
	configuredServers,
	cookieCipher,
	cookieOptions,
	nowSeconds,
} from '~/server/auth-runtime';
import { connectFromWorker } from '~/server/mysql-connector';

export interface LoginFormState {
	servers: ServerConfig[];
	/** 1-based index into `servers`. */
	selectedServer: number;
	defaultUser: string;
	/** The top-of-form alert, e.g. "Cannot log in to the MySQL server". */
	alertMessage: string;
	/** The raw driver error phpMyAdmin shows in #pma_errors. */
	driverError: string;
}

export type LoginAttempt = { status: 'signed-in'; } | { status: 'failed'; form: LoginFormState; };

/** The login form as phpMyAdmin shows it before any attempt: remembered user and server, plus the inactivity notice if relevant. */
export const initialLoginForm = async (cookies: AstroCookies, sessionExpired: boolean): Promise<LoginFormState> => {
	const servers = configuredServers();
	const cipher = await cookieCipher();
	const recalled = recalledLogin(await cipher.open(RECALL_COOKIE, cookies.get(RECALL_COOKIE)?.value));
	let selectedServer = 1;
	if (recalled) {
		selectedServer = Math.max(serverIndex(servers, recalled.server), 1);
	}
	return {
		servers,
		selectedServer,
		defaultUser: recalled?.user ?? '',
		alertMessage: sessionExpired ? loginFailureMessage('no-activity') : '',
		driverError: '',
	};
};

/** Verifies credentials by connecting, then stores them in the encrypted session and recall cookies. */
export const attemptLogin = async (cookies: AstroCookies, url: URL, form: { username: string; password: string; server: unknown; }): Promise<LoginAttempt> => {
	const servers = configuredServers();
	const server = serverByIndex(servers, form.server);
	const failed = (alertMessage: string, driverError = ''): LoginAttempt => {
		const selectedServer = server ? serverIndex(servers, serverKey(server)) : 1;
		return { status: 'failed', form: { servers, selectedServer, defaultUser: form.username, alertMessage, driverError } };
	};
	if (!server) { return failed(CANNOT_LOG_IN_MESSAGE); }
	// Production sets AllowNoPassword = false for every server.
	if (form.password === '') { return failed(loginFailureMessage('empty-denied')); }
	try {
		const connection = await connectFromWorker({ host: server.host, port: server.port, user: form.username, password: form.password, ssl: server.ssl, pin: server.pin });
		await connection.end();
	} catch (error) {
		return failed(CANNOT_LOG_IN_MESSAGE, connectionErrorMessage(error));
	}
	const cipher = await cookieCipher();
	const session = { server: serverKey(server), user: form.username, password: form.password, lastActivity: nowSeconds(), token: createSessionToken() };
	cookies.set(AUTH_COOKIE, await cipher.seal(AUTH_COOKIE, session), cookieOptions(url));
	cookies.set(RECALL_COOKIE, await cipher.seal(RECALL_COOKIE, { server: serverKey(server), user: form.username }), cookieOptions(url, RECALL_COOKIE_MAX_AGE_SECONDS));
	return { status: 'signed-in' };
};

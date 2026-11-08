import type { SessionAccess } from '~/lib/session-access';

import {
	CANNOT_LOG_IN_MESSAGE,
	authCookieName,
	connectionErrorMessage,
	loginFailureMessage,
} from '~/lib/auth';
import { type ServerConfig, selectServer, serverByIndex } from '~/lib/servers';
import { configuredServers } from '~/server/auth-runtime';
import { connectFromWorker } from '~/server/mysql-connector';
import { type PhpCookies, createLoginSession, recalledUser } from '~/server/session-runtime';

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

export type LoginAttempt = { status: 'signed-in'; server: number; } | { status: 'failed'; form: LoginFormState; };

/**
 * The login form as phpMyAdmin shows it before any attempt: the requested server ($GLOBALS['server']), the username LoginCookieRecall
 * remembers for it, and the inactivity notice when the session just expired after `expiredValidity` seconds.
 */
export const initialLoginForm = async (cookies: PhpCookies, requestedServer: unknown, expiredValidity: number | undefined): Promise<LoginFormState> => {
	const servers = configuredServers();
	const selectedServer = selectServer(servers, requestedServer);
	let alertMessage = '';
	if (expiredValidity !== undefined) {
		alertMessage = loginFailureMessage('no-activity', expiredValidity);
	}
	return {
		servers,
		selectedServer,
		defaultUser: await recalledUser(cookies, selectedServer),
		alertMessage,
		driverError: '',
	};
};

/** Verifies credentials by connecting, then starts a new session and sets the login cookies. */
export const attemptLogin = async (cookies: PhpCookies, form: { username: string; password: string; server: unknown; access: SessionAccess; }): Promise<LoginAttempt> => {
	const servers = configuredServers();
	const server = serverByIndex(servers, form.server);
	const selectedServer = server ? Number(form.server) : 1;
	const failed = (alertMessage: string, driverError = ''): LoginAttempt => {
		// showFailure() drops the password cookie of the server the login was for.
		cookies.remove(authCookieName(selectedServer));
		return { status: 'failed', form: { servers, selectedServer, defaultUser: form.username, alertMessage, driverError } };
	};
	if (!server) {
		return failed(CANNOT_LOG_IN_MESSAGE);
	}
	// Production sets AllowNoPassword = false for every server.
	if (form.password === '') {
		return failed(loginFailureMessage('empty-denied'));
	}
	try {
		const connection = await connectFromWorker({ host: server.host, port: server.port, user: form.username, password: form.password, ssl: server.ssl, pin: server.pin });
		await connection.end();
	} catch (error) {
		return failed(CANNOT_LOG_IN_MESSAGE, connectionErrorMessage(error));
	}
	await createLoginSession(cookies, selectedServer, form.username, form.password, form.access);
	return { status: 'signed-in', server: selectedServer };
};

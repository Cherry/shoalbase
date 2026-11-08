import { describe, expect, it } from 'vitest';

import {
	AUTH_COOKIE,
	LOGIN_COOKIE_VALIDITY_SECONDS,
	RECALL_COOKIE,
	authSessionState,
	connectionErrorMessage,
	createCookieCipher,
	createSessionToken,
	entryPoint,
	loginFailureMessage,
	recalledLogin,
	tokensMatch,
} from '~/lib/auth';

const secret = 'a-test-secret-that-is-long-enough-1234';

describe('entry points', () => {
	it('serves index.php at the docroot like DirectoryIndex', () => {
		expect(entryPoint('/')).toBe('index');
		expect(entryPoint('/index.php')).toBe('index');
	});

	it('lets url.php and the message catalog through without a login', () => {
		expect(entryPoint('/url.php')).toBe('public');
		expect(entryPoint('/js/messages.php')).toBe('public');
	});

	it('knows no other path, including the retired legacy pages', () => {
		expect(['/login', '/logout', '/sql', '/index.php/x', '/index', '/database/structure'].map(path => entryPoint(path))).toEqual([null, null, null, null, null, null]);
	});
});

describe('cookie cipher', () => {
	it('refuses to run without a strong secret', async () => {
		await expect(createCookieCipher(undefined)).rejects.toThrow('PMA_COOKIE_SECRET');
		await expect(createCookieCipher('short')).rejects.toThrow('at least 32');
	});

	it('round-trips values without exposing them in the token', async () => {
		const cipher = await createCookieCipher(secret);
		const token = await cipher.seal(AUTH_COOKIE, { user: 'customer', password: 'hunter2' });

		expect(token).not.toContain('hunter2');
		expect(token).toMatch(/^[\w-]+$/);
		expect(await cipher.open(AUTH_COOKIE, token)).toEqual({ user: 'customer', password: 'hunter2' });
	});

	it('uses a fresh IV so equal values produce different tokens', async () => {
		const cipher = await createCookieCipher(secret);
		expect(await cipher.seal(AUTH_COOKIE, 'same')).not.toBe(await cipher.seal(AUTH_COOKIE, 'same'));
	});

	it('rejects tokens that are missing, tampered, moved between cookies, or sealed with another secret', async () => {
		const cipher = await createCookieCipher(secret);
		const token = await cipher.seal(AUTH_COOKIE, { user: 'customer' });
		const tampered = `${token.slice(0, -2)}${token.endsWith('AA') ? 'BB' : 'AA'}`;
		const otherCipher = await createCookieCipher(`${secret}-rotated`);

		expect(await cipher.open(AUTH_COOKIE, undefined)).toBeNull();
		expect(await cipher.open(AUTH_COOKIE, '')).toBeNull();
		expect(await cipher.open(AUTH_COOKIE, tampered)).toBeNull();
		expect(await cipher.open(AUTH_COOKIE, '!!not base64!!')).toBeNull();
		expect(await cipher.open(RECALL_COOKIE, token)).toBeNull();
		expect(await otherCipher.open(AUTH_COOKIE, token)).toBeNull();
	});
});

describe('auth session state', () => {
	const session = { server: 'db:3306', user: 'customer', password: 'pw', lastActivity: 1000, token: '0123456789abcdef0123456789abcdef' };

	it('accepts a session inside the inactivity window, including its boundary', () => {
		expect(authSessionState(session, 1000 + LOGIN_COOKIE_VALIDITY_SECONDS)).toEqual({ status: 'valid', session });
	});

	it('expires sessions idle longer than LoginCookieValidity', () => {
		expect(authSessionState(session, 1001 + LOGIN_COOKIE_VALIDITY_SECONDS)).toEqual({ status: 'expired' });
	});

	it('treats malformed payloads as no session', () => {
		expect(authSessionState(null, 1000)).toEqual({ status: 'missing' });
		expect(authSessionState('token', 1000)).toEqual({ status: 'missing' });
		expect(authSessionState({ ...session, password: undefined }, 1000)).toEqual({ status: 'missing' });
		expect(authSessionState({ ...session, lastActivity: '1000' }, 1000)).toEqual({ status: 'missing' });
		expect(authSessionState({ ...session, server: 1 }, 1000)).toEqual({ status: 'missing' });
		expect(authSessionState({ ...session, user: null }, 1000)).toEqual({ status: 'missing' });
		expect(authSessionState({ ...session, token: undefined }, 1000)).toEqual({ status: 'missing' });
	});

	it('recalls only well-formed username and server pairs', () => {
		expect(recalledLogin({ server: 'db:3306', user: 'customer', extra: true })).toEqual({ server: 'db:3306', user: 'customer' });
		expect(recalledLogin({ server: 'db:3306' })).toBeNull();
		expect(recalledLogin({ user: 'customer' })).toBeNull();
		expect(recalledLogin(null)).toBeNull();
	});
});

describe('login messages', () => {
	it('matches phpMyAdmin 5.2 failure text', () => {
		expect(loginFailureMessage('empty-denied')).toBe('Login without a password is forbidden by configuration (see AllowNoPassword)');
		expect(loginFailureMessage('no-activity')).toBe('You have been automatically logged out due to inactivity of 1440 seconds. Once you log in again, you should be able to resume the work where you left off.');
	});

	it('formats driver errors the way mysqli reports them', () => {
		expect(connectionErrorMessage({ errno: 1045, message: 'Access denied for user \'customer\'@\'10.0.0.1\' (using password: YES)' }))
			.toBe('mysqli::real_connect(): (HY000/1045): Access denied for user \'customer\'@\'10.0.0.1\' (using password: YES)');
		expect(connectionErrorMessage({ errno: -4078, code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' })).toBe('mysqli::real_connect(): (HY000/2002): connect ECONNREFUSED');
		expect(connectionErrorMessage({ code: 'HANDSHAKE_SSL_ERROR', message: 'certificate verify failed' })).toBe('mysqli::real_connect(): (HY000/2026): certificate verify failed');
		expect(connectionErrorMessage({ message: '' })).toBe('mysqli::real_connect(): (HY000/2002): Unknown error');
		expect(connectionErrorMessage('boom')).toBe('mysqli::real_connect(): (HY000/2002): Unknown error');
	});
});

describe('session CSRF token', () => {
	it('is 32 lowercase hex characters and unique per session', () => {
		const token = createSessionToken();
		expect(token).toMatch(/^[\da-f]{32}$/);
		expect(createSessionToken()).not.toBe(token);
	});

	it('only accepts the exact token', () => {
		const token = createSessionToken();
		expect(tokensMatch(token, token)).toBe(true);
		expect(tokensMatch(token, `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`)).toBe(false);
		expect(tokensMatch(token, token.slice(0, -1))).toBe(false);
		expect(tokensMatch(token, undefined)).toBe(false);
		expect(tokensMatch(token, ['array'])).toBe(false);
	});
});

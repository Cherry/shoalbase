import { describe, expect, it } from 'vitest';

import {
	authCookieName,
	connectionErrorMessage,
	createCookieCipher,
	createEncryptionKey,
	createSessionCipher,
	createSessionId,
	createSessionToken,
	entryPoint,
	isSessionId,
	loginFailureMessage,
	sessionObjectName,
	tokensMatch,
	userCookieName,
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
		const token = await cipher.seal(authCookieName(1), { user: 'customer', password: 'hunter2' });

		expect(token).not.toContain('hunter2');
		expect(token).toMatch(/^[\w-]+$/);
		expect(await cipher.open(authCookieName(1), token)).toEqual({ user: 'customer', password: 'hunter2' });
	});

	it('uses a fresh IV so equal values produce different tokens', async () => {
		const cipher = await createCookieCipher(secret);
		expect(await cipher.seal(authCookieName(1), 'same')).not.toBe(await cipher.seal(authCookieName(1), 'same'));
	});

	it('rejects tokens that are missing, tampered, moved between cookies, or sealed with another secret', async () => {
		const cipher = await createCookieCipher(secret);
		const token = await cipher.seal(authCookieName(1), { user: 'customer' });
		const tampered = `${token.slice(0, -2)}${token.endsWith('AA') ? 'BB' : 'AA'}`;
		const otherCipher = await createCookieCipher(`${secret}-rotated`);

		expect(await cipher.open(authCookieName(1), undefined)).toBeNull();
		expect(await cipher.open(authCookieName(1), '')).toBeNull();
		expect(await cipher.open(authCookieName(1), tampered)).toBeNull();
		expect(await cipher.open(authCookieName(1), '!!not base64!!')).toBeNull();
		expect(await cipher.open(userCookieName(1), token)).toBeNull();
		expect(await otherCipher.open(authCookieName(1), token)).toBeNull();
	});

	it('encrypts password cookies with the session key, which other sessions cannot use', async () => {
		const key = createEncryptionKey();
		const cipher = await createSessionCipher(key);
		const token = await cipher?.seal(authCookieName(1), { password: 'hunter2' }) ?? '';

		const sameKey = await createSessionCipher(key);
		const otherKey = await createSessionCipher(createEncryptionKey());
		const secretKey = await createCookieCipher(secret);

		expect(await sameKey?.open(authCookieName(1), token)).toEqual({ password: 'hunter2' });
		expect(await otherKey?.open(authCookieName(1), token)).toBeNull();
		expect(await secretKey.open(authCookieName(1), token)).toBeNull();
	});

	it('refuses session keys it could not have made', async () => {
		expect(await createSessionCipher(undefined)).toBeNull();
		expect(await createSessionCipher('short')).toBeNull();
		expect(await createSessionCipher('!'.repeat(43))).toBeNull();
	});
});

describe('login messages', () => {
	it('matches phpMyAdmin 5.2 failure text', () => {
		expect(loginFailureMessage('empty-denied')).toBe('Login without a password is forbidden by configuration (see AllowNoPassword)');
		expect(loginFailureMessage('no-activity')).toBe('You have been automatically logged out due to inactivity of 1440 seconds. Once you log in again, you should be able to resume the work where you left off.');
		expect(loginFailureMessage('no-activity', 600)).toContain('inactivity of 600 seconds.');
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

describe('session ids', () => {
	it('look like PHP session ids and only that shape is accepted', () => {
		const id = createSessionId();
		expect(isSessionId(id)).toBe(true);
		expect(createSessionId()).not.toBe(id);
		expect([id.toUpperCase(), `${id}0`, id.slice(1), '', undefined, 42].map(value => isSessionId(value))).toEqual([false, false, false, false, false, false]);
	});

	it('name their object with a hash, so the id itself is never an object name', async () => {
		const id = createSessionId();
		const name = await sessionObjectName(id);
		expect(name).toMatch(/^[\da-f]{64}$/);
		expect(name).not.toContain(id);
		expect(await sessionObjectName(id)).toBe(name);
	});
});

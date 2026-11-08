import { describe, expect, it } from 'vitest';

import { createSessionCipher, isSessionId } from './auth.ts';
import {
	ACCESS_TIMES_KEY,
	ENCRYPTION_KEY,
	SESSION_GC_GRACE_SECONDS,
	TOKEN_KEY,
	loginCookieValidity,
	newSession,
	sessionDeadline,
	touchSession,
} from './session-access.ts';

const NOW = 1_000_000;

describe('touchSession', () => {
	it('reports a session nobody signed in to as missing', () => {
		expect(touchSession({}, {}, NOW)).toEqual({ status: 'missing' });
		expect(touchSession({ [ACCESS_TIMES_KEY]: 'x', tmpval: {} }, {}, NOW)).toEqual({ status: 'missing' });
		expect(touchSession({ [ACCESS_TIMES_KEY]: { default: 'x' } }, {}, NOW)).toEqual({ status: 'missing' });
	});

	it('marks the default window active, keeping the rest of $_SESSION', () => {
		const result = touchSession({ [ACCESS_TIMES_KEY]: { default: NOW - 100 }, profiling: true }, {}, NOW);
		expect(result).toEqual({ status: 'active', data: { [ACCESS_TIMES_KEY]: { default: NOW }, profiling: true } });
	});

	it('accepts a window active exactly LoginCookieValidity ago and forgets older ones', () => {
		const data = { [ACCESS_TIMES_KEY]: { default: NOW - 1440, old: NOW - 1441 } };
		expect(touchSession(data, { guid: 'tab' }, NOW)).toEqual({ status: 'active', data: { [ACCESS_TIMES_KEY]: { default: NOW - 1440, tab: NOW } } });
	});

	it('expires once every window has been idle past LoginCookieValidity, reporting the validity for the notice', () => {
		expect(touchSession({ [ACCESS_TIMES_KEY]: { default: NOW - 1441, tab: NOW - 2000 } }, {}, NOW)).toEqual({ status: 'expired', validity: 1440 });
	});

	it('follows a LoginCookieValidity user preference', () => {
		const data = { [ACCESS_TIMES_KEY]: { default: NOW - 100 }, userconfig: { db: { LoginCookieValidity: 60 }, ts: 1 } };
		expect(touchSession(data, {}, NOW)).toEqual({ status: 'expired', validity: 60 });
		expect(loginCookieValidity({ userconfig: { db: { LoginCookieValidity: '3600' } } })).toBe(3600);
		expect([0, -5, 1.5, 'x', null].map(value => loginCookieValidity({ userconfig: { db: { LoginCookieValidity: value } } }))).toEqual([1440, 1440, 1440, 1440, 1440]);
		expect(loginCookieValidity({ userconfig: 'x' })).toBe(1440);
	});

	it('records an idle poll as the time its window was last used, never later than now and never far enough back to cheat', () => {
		const data = { [ACCESS_TIMES_KEY]: { default: NOW } };
		const accessed = (accessTime: unknown): unknown => {
			const result = touchSession(data, { guid: 'tab', accessTime }, NOW);
			return result.status === 'active' ? (result.data[ACCESS_TIMES_KEY] as Record<string, number>).tab : result.status;
		};
		expect(accessed('300')).toBe(NOW - 300);
		expect(accessed('-50')).toBe(NOW);
		expect(accessed('999999')).toBe(NOW - 1441);
		expect(accessed('12abc')).toBe(NOW - 12);
		expect(accessed(' 1e2')).toBe(NOW - 100);
		expect(accessed('abc')).toBe(NOW);
		expect(accessed(['5'])).toBe(NOW - 1);
		expect(accessed([])).toBe(NOW);
	});

	it('lets an idle poll age a window so the next request finds the session expired, as upstream does', () => {
		const aged = touchSession({ [ACCESS_TIMES_KEY]: { default: NOW } }, { guid: 'default', accessTime: '1441' }, NOW);
		expect(aged.status).toBe('active');
		expect(touchSession(aged.status === 'active' ? aged.data : {}, {}, NOW).status).toBe('expired');
	});

	it('casts an array guid the way PHP casts arrays to strings', () => {
		const result = touchSession({ [ACCESS_TIMES_KEY]: { default: NOW } }, { guid: ['a'] }, NOW);
		expect(result.status === 'active' && result.data[ACCESS_TIMES_KEY]).toEqual({ default: NOW, Array: NOW });
	});
});

describe('sessionDeadline', () => {
	it('is the newest access plus LoginCookieValidity and the grace period', () => {
		expect(sessionDeadline({ [ACCESS_TIMES_KEY]: { default: NOW - 50, tab: NOW } })).toBe(NOW + 1440 + SESSION_GC_GRACE_SECONDS);
		expect(sessionDeadline({ [ACCESS_TIMES_KEY]: { default: NOW }, userconfig: { db: { LoginCookieValidity: 60 } } })).toBe(NOW + 60 + SESSION_GC_GRACE_SECONDS);
	});

	it('is null for a session without access times, which can be deleted at once', () => {
		expect(sessionDeadline({})).toBeNull();
	});
});

describe('newSession', () => {
	it('starts with a fresh token, a usable password key and this request as the only active window', async () => {
		const data = newSession({ guid: 'tab', accessTime: '10' }, NOW);
		expect(isSessionId(data[TOKEN_KEY])).toBe(true);
		expect(await createSessionCipher(data[ENCRYPTION_KEY])).not.toBeNull();
		expect(data[ACCESS_TIMES_KEY]).toEqual({ tab: NOW - 10 });
		expect(newSession({}, NOW)[TOKEN_KEY]).not.toBe(data[TOKEN_KEY]);
	});
});

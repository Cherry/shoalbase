// The request side of sessions in workerd: cookies in, the PMA_SESSIONS object called over RPC, cookies out, as the middleware runs it.
import { listDurableObjectIds, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import type { RequestParams } from '~/lib/pma-request';

import { sessionObjectName } from '~/lib/auth';
import { PmaSession } from '~/lib/pma/session';
import {
	PhpCookies,
	beginSession,
	createLoginSession,
	logOut,
	saveSession,
	storePasswordCookie,
} from '~/server/session-runtime';


/** A browser's cookie jar: it sends its cookies with each request and keeps what the response sets. */
class Browser {
	readonly jar = new Map<string, string>();

	request(isHttps = false): { cookies: PhpCookies; } {
		return { cookies: new PhpCookies(name => this.jar.get(name), isHttps, new Map()) };
	}

	keep(cookies: PhpCookies): void {
		for (const line of cookies.lines.values()) {
			const [pair] = line.split(';', 1);
			const name = pair.slice(0, pair.indexOf('='));
			const value = pair.slice(pair.indexOf('=') + 1);
			if (/Max-Age=0/.test(line)) {
				this.jar.delete(name);
			} else {
				this.jar.set(name, value);
			}
		}
	}

	async begin(params: RequestParams = {}, method = 'GET'): Promise<Awaited<ReturnType<typeof beginSession>>> {
		const { cookies } = this.request();
		const state = await beginSession(cookies, params, method);
		this.keep(cookies);
		return state;
	}

	async status(params: RequestParams = {}, method = 'GET'): Promise<string> {
		const state = await this.begin(params, method);
		return state.status;
	}

	async login(server = 1): Promise<void> {
		const { cookies } = this.request();
		await createLoginSession(cookies, server, 'customer', 'customerpw', {});
		this.keep(cookies);
	}

	/** What the session object behind this browser's phpMyAdmin cookie holds. */
	async stored(): Promise<Record<string, unknown>> {
		const stub = env.PMA_SESSIONS.getByName(await sessionObjectName(this.jar.get('phpMyAdmin') ?? ''));
		return runInDurableObject(stub, (_instance, state) => Object.fromEntries(state.storage.kv.list()));
	}
}

const objectCount = async (): Promise<number> => {
	const ids = await listDurableObjectIds(env.PMA_SESSIONS);
	return ids.length;
};

describe('session runtime', () => {
	it('signs a browser in with its session, username and password cookies, without the password in any cookie', async () => {
		const browser = new Browser();
		await browser.login();
		expect(new Set(browser.jar.keys())).toEqual(new Set(['phpMyAdmin', 'pmaAuth-1', 'pmaUser-1']));
		expect(browser.jar.values().some(value => value.includes('customer'))).toBe(false);
		expect(JSON.stringify(await browser.stored())).not.toContain('customerpw');

		const state = await browser.begin();
		expect(state).toMatchObject({ status: 'signed-in', server: 1, user: 'customer', password: 'customerpw', id: browser.jar.get('phpMyAdmin') });
	});

	it('keeps what a request stored in $_SESSION for the next one', async () => {
		const browser = new Browser();
		await browser.login();
		const first = await browser.begin();
		if (first.status !== 'signed-in') {
			throw new Error('not signed in');
		}
		first.session.tmpval.pos = 30;
		await saveSession(first.id, first.session);
		const second = await browser.begin();
		expect(second.status === 'signed-in' && second.session.data.tmpval).toEqual({ pos: 30 });
	});

	it('gives a signed-out request a fresh phpMyAdmin cookie without creating a session object', async () => {
		const before = await objectCount();
		const browser = new Browser();
		const state = await browser.begin();
		expect(state.status).toBe('signed-out');
		expect(browser.jar.get('phpMyAdmin')).toMatch(/^[\da-f]{32}$/);
		expect(browser.jar.get('phpMyAdmin')).toBe(state.id);
		expect(await objectCount()).toBe(before);

		// Logging in is what creates one.
		await browser.login();
		expect(await objectCount()).toBe(before + 1);
	});

	it('never looks up a session for a cookie that is not a session id', async () => {
		const before = await objectCount();
		const browser = new Browser();
		browser.jar.set('phpMyAdmin', '../../etc/passwd');
		browser.jar.set('pmaUser-1', 'x');
		browser.jar.set('pmaAuth-1', 'x');
		const state = await browser.begin();
		expect(state.status).toBe('signed-out');
		expect(browser.jar.get('phpMyAdmin')).toBe(state.id);
		expect(await objectCount()).toBe(before);
	});

	it('makes a copied cookie pair useless after logout, and leaves the session object empty', async () => {
		const browser = new Browser();
		await browser.login();
		const copied = new Browser();
		for (const [name, value] of browser.jar) {
			copied.jar.set(name, value);
		}
		const { cookies } = browser.request();
		await logOut(cookies, browser.jar.get('phpMyAdmin') ?? '');
		browser.keep(cookies);
		expect(browser.jar.has('pmaAuth-1')).toBe(false);
		expect(browser.jar.has('pmaUser-1')).toBe(true);
		expect(await browser.stored()).toEqual({});

		const replayed = await copied.begin();
		expect(replayed.status).toBe('signed-out');
		expect(replayed.id).not.toBe(browser.jar.get('phpMyAdmin'));
	});

	it('signs out with the inactivity notice once every window has been idle past LoginCookieValidity', async () => {
		const browser = new Browser();
		await browser.login();
		const id = browser.jar.get('phpMyAdmin');
		// phpMyAdmin's idle poll reports how long the window has been idle, which ages the session as time passing would.
		expect(await browser.status({ guid: 'default', access_time: '1441', check_timeout: '1' })).toBe('signed-in');
		const expired = await browser.begin();
		expect(expired).toEqual({ status: 'signed-out', id, expiredValidity: 1440 });
		expect(browser.jar.has('pmaAuth-1')).toBe(false);
		expect(await browser.status()).toBe('signed-out');
	});

	it('shows the inactivity notice on the page an expired AJAX request reloads', async () => {
		const browser = new Browser();
		await browser.login();
		const id = browser.jar.get('phpMyAdmin');
		await browser.begin({ guid: 'default', access_time: '1441' });
		expect(await browser.begin({ ajax_request: 'true' })).toEqual({ status: 'signed-out', id, expiredValidity: 1440 });
		expect(browser.jar.has('pmaAuth-1')).toBe(false);
		// The reload has no password cookie any more, yet the session object still remembers why it signed out.
		expect(await browser.begin()).toEqual({ status: 'signed-out', id, expiredValidity: 1440 });
		expect(await browser.stored()).toEqual({});
	});

	it('discards the session when its password cookie was tampered with', async () => {
		const browser = new Browser();
		await browser.login();
		const id = browser.jar.get('phpMyAdmin');
		const password = browser.jar.get('pmaAuth-1') ?? '';
		browser.jar.set('pmaAuth-1', `${password.slice(0, -4)}AAAA`);
		expect(await browser.status()).toBe('signed-out');
		browser.jar.set('phpMyAdmin', id ?? '');
		browser.jar.set('pmaAuth-1', password);
		expect(await browser.status()).toBe('signed-out');
	});

	it('does not accept login cookies under another server number, as after a change of PMA_SERVERS', async () => {
		const browser = new Browser();
		await browser.login(1);
		browser.jar.set('pmaUser-2', browser.jar.get('pmaUser-1') ?? '');
		browser.jar.set('pmaAuth-2', browser.jar.get('pmaAuth-1') ?? '');
		expect(await browser.status({ server: '2' })).toBe('signed-out');
	});

	it('discards the session when the browser switches to a server it is not signed in to, as Session::secure() does', async () => {
		const browser = new Browser();
		await browser.login(1);
		const id = browser.jar.get('phpMyAdmin') ?? '';
		expect(await browser.status({ server: '2' })).toBe('signed-out');
		browser.jar.set('phpMyAdmin', id);
		expect(await browser.status()).toBe('signed-out');
	});

	it('treats a POSTed login as a new sign-in even with a live session', async () => {
		const browser = new Browser();
		await browser.login();
		expect(await browser.status({ pma_username: 'customer' }, 'POST')).toBe('signed-out');
	});

	it('names the cookies the HTTPS way phpMyAdmin does', async () => {
		const browser = new Browser();
		const { cookies } = browser.request(true);
		await createLoginSession(cookies, 1, 'customer', 'customerpw', {});
		expect(cookies.lines.keys().toArray()).toEqual(['__Secure-phpMyAdmin_https', '__Secure-pmaUser-1_https', '__Secure-pmaAuth-1_https']);
		expect(cookies.lines.get('__Secure-pmaAuth-1_https')).toMatch(/; path=\/; secure; HttpOnly; SameSite=Strict$/);
	});

	it('re-encrypts the password cookie after a password change', async () => {
		const browser = new Browser();
		await browser.login();
		const state = await browser.begin();
		if (state.status !== 'signed-in') {
			throw new Error('not signed in');
		}
		const { cookies } = browser.request();
		await storePasswordCookie(cookies, 1, state.session, 'newpw');
		browser.keep(cookies);
		expect(await browser.begin()).toMatchObject({ status: 'signed-in', password: 'newpw' });
		await storePasswordCookie(cookies, 1, new PmaSession(), 'ignored');
		expect(cookies.lines.size).toBe(1);
	});
});

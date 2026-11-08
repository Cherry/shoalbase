// PmaSessionObject in workerd: SQLite-backed storage, its synchronous KV API and alarms, called over RPC as session-runtime does.
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';

import {
	ACCESS_TIMES_KEY,
	ENCRYPTION_KEY,
	SESSION_GC_GRACE_SECONDS,
	TOKEN_KEY,
	newSession,
} from '~/lib/session-access';

// Far enough ahead of the real clock that the runtime never fires an alarm on its own; each test runs them with runDurableObjectAlarm().
const T0 = Date.UTC(2100, 0, 1, 12, 0, 0);
const T0_SECONDS = T0 / 1000;
const VALIDITY_MS = 1_440_000;
const GRACE_MS = SESSION_GC_GRACE_SECONDS * 1000;

type SessionStub = DurableObjectStub<import('~/server/session-object').PmaSessionObject>;

// Storage is isolated per test file, not per test, so every test gets an object of its own.
let objects = 0;
const freshSession = (): SessionStub => {
	objects += 1;
	return env.PMA_SESSIONS.getByName(`session-object-test-${objects}`);
};

/** A session created by a login at T0, as createLoginSession() stores it. */
async function loggedIn(): Promise<SessionStub> {
	const stub = freshSession();
	await stub.create(newSession({}, T0_SECONDS));
	return stub;
}

const stored = (stub: SessionStub): Promise<Record<string, unknown>> => runInDurableObject(stub, (_instance, state) => Object.fromEntries(state.storage.kv.list()));
const alarmOf = (stub: SessionStub): Promise<number | null> => runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());

const at = (ms: number): void => {
	vi.setSystemTime(ms);
};

describe('PmaSessionObject', () => {
	beforeEach(() => {
		// Only Date is faked: the runtime's own timers keep real time.
		vi.useFakeTimers({ toFake: ['Date'] });
		at(T0);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('reports an unknown session as missing without storing anything', async () => {
		const stub = freshSession();
		expect(await stub.start({})).toEqual({ status: 'missing' });
		expect(await stored(stub)).toEqual({});
		expect(await alarmOf(stub)).toBeNull();
	});

	it('round-trips a login: create() stores $_SESSION, start() returns it and records the window as active', async () => {
		const data = newSession({}, T0_SECONDS);
		const stub = freshSession();
		await stub.create(data);
		expect(await alarmOf(stub)).toBe(T0 + VALIDITY_MS + GRACE_MS);

		at(T0 + 600000);
		const started = await stub.start({ guid: 'tab' });
		const times = { default: T0_SECONDS, tab: T0_SECONDS + 600 };
		expect(started).toEqual({ status: 'active', data: { ...data, [ACCESS_TIMES_KEY]: times } });
		expect(await stored(stub)).toEqual({ ...data, [ACCESS_TIMES_KEY]: times });
		// The pending alarm moves itself forward when it runs, so requests do not reschedule it.
		expect(await alarmOf(stub)).toBe(T0 + VALIDITY_MS + GRACE_MS);
	});

	it('stores only what update() changed and keeps it for the next request', async () => {
		const stub = freshSession();
		const data = { ...newSession({}, T0_SECONDS), profiling: true };
		await stub.create(data);
		expect(await stub.update({ set: { tmpval: { pos: 30 } }, unset: ['profiling'] })).toBe(true);

		const started = await stub.start({});
		expect(started.status === 'active' && started.data.tmpval).toEqual({ pos: 30 });
		expect(new Set(Object.keys(await stored(stub)))).toEqual(new Set([ACCESS_TIMES_KEY, ENCRYPTION_KEY, TOKEN_KEY, 'tmpval']));
	});

	it('empties the object on logout and never brings the session back', async () => {
		const stub = await loggedIn();
		await stub.destroy();
		expect(await stored(stub)).toEqual({});
		// On our compatibility date deleteAll() removes the alarm too, so a logged-out session never wakes up again.
		expect(await alarmOf(stub)).toBeNull();
		expect(await runDurableObjectAlarm(stub)).toBe(false);

		expect(await stub.update({ set: { tmpval: { pos: 60 } }, unset: [] })).toBe(false);
		expect(await stored(stub)).toEqual({});
		expect(await stub.start({})).toEqual({ status: 'missing' });
	});

	it('deletes a session idle past LoginCookieValidity on its next request', async () => {
		const stub = await loggedIn();
		at(T0 + VALIDITY_MS);
		expect(await stub.start({})).toMatchObject({ status: 'active' });

		at(T0 + VALIDITY_MS + VALIDITY_MS + 1000);
		expect(await stub.start({})).toEqual({ status: 'expired', validity: 1440 });
		expect(await stored(stub)).toEqual({});
		expect(await alarmOf(stub)).toBeNull();
		expect(await stub.start({})).toEqual({ status: 'missing' });
	});

	it('expires per window: a window idle too long is forgotten while another keeps the session alive', async () => {
		const stub = await loggedIn();
		at(T0 + 1_000_000);
		await stub.start({ guid: 'tab' });
		at(T0 + VALIDITY_MS + 1000);
		const started = await stub.start({ guid: 'tab' });
		expect(started.status === 'active' && started.data[ACCESS_TIMES_KEY]).toEqual({ tab: T0_SECONDS + VALIDITY_MS / 1000 + 1 });
	});

	it('honours a shorter LoginCookieValidity preference, both for expiry and for its cleanup', async () => {
		const stub = await loggedIn();
		await stub.update({ set: { userconfig: { db: { LoginCookieValidity: 60 }, ts: 1 } }, unset: [] });
		at(T0 + 30000);
		await stub.start({});
		expect(await alarmOf(stub)).toBe(T0 + 30000 + 60000 + GRACE_MS);

		at(T0 + 30000 + 61000);
		expect(await stub.start({})).toEqual({ status: 'expired', validity: 60 });
	});

	it('keeps the inactivity notice for the page an expired AJAX request reloads, then forgets it', async () => {
		const stub = await loggedIn();
		const expiredAt = T0 + VALIDITY_MS + 1000;
		at(expiredAt);
		expect(await stub.start({ ajax: true })).toEqual({ status: 'expired', validity: 1440 });
		expect(Object.keys(await stored(stub))).toEqual(['expired_notice']);
		expect(await alarmOf(stub)).toBe(expiredAt + GRACE_MS);
		// The tombstone is not a session: changes from a request still in flight are not stored.
		expect(await stub.update({ set: { tmpval: {} }, unset: [] })).toBe(false);

		expect(await stub.start({})).toEqual({ status: 'expired', validity: 1440 });
		expect(await stored(stub)).toEqual({});
		expect(await stub.start({})).toEqual({ status: 'missing' });
	});

	it('lets the alarm delete an inactivity notice nobody came back for', async () => {
		const stub = await loggedIn();
		at(T0 + VALIDITY_MS + 1000);
		await stub.start({ ajax: true });
		at(T0 + VALIDITY_MS + 1000 + GRACE_MS);
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect(await stored(stub)).toEqual({});
		expect(await alarmOf(stub)).toBeNull();
	});

	describe('alarm', () => {
		it('deletes all storage of an idle session', async () => {
			const stub = await loggedIn();
			at(T0 + VALIDITY_MS + GRACE_MS);
			expect(await runDurableObjectAlarm(stub)).toBe(true);
			expect(await stored(stub)).toEqual({});
			expect(await alarmOf(stub)).toBeNull();
		});

		it('moves its deadline instead while the session is still in use', async () => {
			const stub = await loggedIn();
			at(T0 + 1_000_000);
			await stub.start({});
			at(T0 + VALIDITY_MS + GRACE_MS);
			expect(await runDurableObjectAlarm(stub)).toBe(true);
			expect(Object.keys(await stored(stub))).toContain(TOKEN_KEY);
			expect(await alarmOf(stub)).toBe(T0 + 1_000_000 + VALIDITY_MS + GRACE_MS);

			// The session is still usable until that new deadline.
			at(T0 + 1_000_000 + VALIDITY_MS);
			expect(await stub.start({})).toMatchObject({ status: 'active' });
		});

		it('can run twice, as the runtime may deliver an alarm again, without reviving or rescheduling anything', async () => {
			const stub = await loggedIn();
			at(T0 + VALIDITY_MS + GRACE_MS);
			await runInDurableObject(stub, async (instance) => {
				await instance.alarm();
				await instance.alarm();
			});
			expect(await stored(stub)).toEqual({});
			expect(await alarmOf(stub)).toBeNull();
			expect(await runDurableObjectAlarm(stub)).toBe(false);
		});

		it('retries a minute later instead of throwing when cleanup fails', async () => {
			const stub = await loggedIn();
			const due = T0 + VALIDITY_MS + GRACE_MS;
			at(due);
			const error = vi.spyOn(console, 'error').mockImplementation(() => {});
			await runInDurableObject(stub, async (instance, state) => {
				vi.spyOn(state.storage, 'deleteAll').mockRejectedValueOnce(new Error('storage unavailable'));
				await instance.alarm();
			});
			expect(error).toHaveBeenCalled();
			expect(await alarmOf(stub)).toBe(due + 60000);
			expect(Object.keys(await stored(stub))).toContain(TOKEN_KEY);

			at(due + 60000);
			expect(await runDurableObjectAlarm(stub)).toBe(true);
			expect(await stored(stub)).toEqual({});
		});
	});
});

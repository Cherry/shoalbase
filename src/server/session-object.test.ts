import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';

import { PmaSessionObject } from './session-object.ts';
import { MemoryStorage } from '../../scripts/stubs/durable-objects.ts';
import { ACCESS_TIMES_KEY, SESSION_GC_GRACE_SECONDS, newSession } from '../lib/session-access.ts';

const T0 = Date.UTC(2026, 10, 8, 12, 0, 0);
const seconds = (ms: number): number => Math.floor(ms / 1000);

function session(): { object: PmaSessionObject; storage: MemoryStorage; } {
	const storage = new MemoryStorage();
	return { object: new PmaSessionObject({ storage }, {} as Env), storage };
}

const at = (ms: number): void => {
	vi.setSystemTime(ms);
};

describe('PmaSessionObject', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		at(T0);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('reports an unknown session as missing without storing anything', async () => {
		const { object, storage } = session();
		expect(await object.start({})).toEqual({ status: 'missing' });
		expect(storage.size).toBe(0);
		expect(storage.alarm).toBeNull();
	});

	it('records each request as activity and schedules its cleanup once', async () => {
		const { object, storage } = session();
		await object.create(newSession({}, seconds(T0)));
		const deadline = (seconds(T0) + 1440 + SESSION_GC_GRACE_SECONDS) * 1000;
		expect(storage.alarm).toBe(deadline);

		at(T0 + 600000);
		const started = await object.start({ guid: 'tab' });
		expect(started.status === 'active' && started.data[ACCESS_TIMES_KEY]).toEqual({ default: seconds(T0), tab: seconds(T0) + 600 });
		expect(storage.kv.get(ACCESS_TIMES_KEY)).toEqual({ default: seconds(T0), tab: seconds(T0) + 600 });
		// The pending alarm moves itself forward when it runs, so requests do not reschedule it.
		expect(storage.alarm).toBe(deadline);
	});

	it('stores only the keys a request changed, and never brings a deleted session back', async () => {
		const { object, storage } = session();
		await object.create({ ...newSession({}, seconds(T0)), profiling: true });
		expect(object.update({ set: { tmpval: { pos: 30 } }, unset: ['profiling'] })).toBe(true);
		expect(storage.kv.get('tmpval')).toEqual({ pos: 30 });
		expect(storage.kv.get('profiling')).toBeUndefined();

		await object.destroy();
		expect(object.update({ set: { tmpval: { pos: 60 } }, unset: [] })).toBe(false);
		expect(storage.size).toBe(0);
		expect(storage.alarm).toBeNull();
	});

	it('deletes a session idle past LoginCookieValidity on its next request', async () => {
		const { object, storage } = session();
		await object.create(newSession({}, seconds(T0)));
		at(T0 + 1_441_000);
		expect(await object.start({})).toEqual({ status: 'expired', validity: 1440 });
		expect(storage.size).toBe(0);
		expect(storage.alarm).toBeNull();
		expect(await object.start({})).toEqual({ status: 'missing' });
	});

	it('keeps the inactivity notice for the page an expired AJAX request reloads, then forgets it', async () => {
		const { object, storage } = session();
		await object.create(newSession({}, seconds(T0)));
		at(T0 + 1_441_000);
		expect(await object.start({ ajax: true })).toEqual({ status: 'expired', validity: 1440 });
		expect(storage.alarm).toBe(T0 + 1_441_000 + SESSION_GC_GRACE_SECONDS * 1000);
		expect(object.update({ set: { tmpval: {} }, unset: [] })).toBe(false);
		expect(await object.start({})).toEqual({ status: 'expired', validity: 1440 });
		expect(await object.start({})).toEqual({ status: 'missing' });
		expect(storage.size).toBe(0);
	});

	it('cleans up sooner once a shorter LoginCookieValidity preference is saved', async () => {
		const { object, storage } = session();
		await object.create(newSession({}, seconds(T0)));
		object.update({ set: { userconfig: { db: { LoginCookieValidity: 60 }, ts: 1 } }, unset: [] });
		await object.start({});
		expect(storage.alarm).toBe((seconds(T0) + 60 + SESSION_GC_GRACE_SECONDS) * 1000);
	});

	describe('alarm', () => {
		it('waits for the new deadline while the session is still in use', async () => {
			const { object, storage } = session();
			await object.create(newSession({}, seconds(T0)));
			at(T0 + 1_000_000);
			await object.start({});
			at(storage.alarm ?? 0);
			await object.alarm();
			expect(storage.size).toBeGreaterThan(0);
			expect(storage.alarm).toBe((seconds(T0) + 1000 + 1440 + SESSION_GC_GRACE_SECONDS) * 1000);
		});

		it('deletes all storage of an idle session, and can run again harmlessly', async () => {
			const { object, storage } = session();
			await object.create(newSession({}, seconds(T0)));
			at(storage.alarm ?? 0);
			await object.alarm();
			expect(storage.size).toBe(0);
			expect(storage.alarm).toBeNull();
			await object.alarm();
			expect(storage.size).toBe(0);
			expect(storage.alarm).toBeNull();
		});

		it('retries a minute later instead of throwing when cleanup fails', async () => {
			const { object, storage } = session();
			await object.create(newSession({}, seconds(T0)));
			at(storage.alarm ?? 0);
			const error = vi.spyOn(console, 'error').mockImplementation(() => {});
			vi.spyOn(storage, 'deleteAll').mockRejectedValueOnce(new Error('storage unavailable'));
			await object.alarm();
			expect(error).toHaveBeenCalled();
			expect(storage.alarm).toBe(Date.now() + 60000);
			expect(storage.size).toBeGreaterThan(0);
		});
	});
});

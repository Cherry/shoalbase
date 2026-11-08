// One phpMyAdmin session ($_SESSION), standing in for PHP's session file; src/server/session-runtime.ts is the request side.
import { DurableObject } from 'cloudflare:workers';

import type { SessionChanges } from '~/lib/pma/session';

import {
	ACCESS_TIMES_KEY,
	SESSION_GC_GRACE_SECONDS,
	type SessionAccess,
	type SessionData,
	type SessionStart,
	sessionDeadline,
	touchSession,
} from '~/lib/session-access';

// Marks a session that expired during an AJAX request, whose response cannot show why, so the page it reloads to still can.
const EXPIRED_KEY = 'expired_notice';
// A failed alarm retries this much later instead of using up the runtime's six retries.
const ALARM_RETRY_MS = 60000;

export class PmaSessionObject extends DurableObject<Env> {
	private load(): SessionData {
		return Object.fromEntries(this.ctx.storage.kv.list());
	}

	// One pending alarm per session is enough: it moves itself forward while the session is in use, so requests rarely touch it.
	private async scheduleCleanup(data: SessionData, current: number | null): Promise<void> {
		const deadline = sessionDeadline(data);
		if (deadline !== null && (current === null || current > deadline * 1000)) {
			await this.ctx.storage.setAlarm(deadline * 1000);
		}
	}

	/** Loads $_SESSION for a request and records its access time, or reports why it cannot be used; an expired session is deleted. */
	async start(access: SessionAccess): Promise<SessionStart> {
		const data = this.load();
		const notice = data[EXPIRED_KEY];
		if (typeof notice === 'number') {
			await this.ctx.storage.deleteAll();
			return { status: 'expired', validity: notice };
		}
		const result = touchSession(data, access, Math.floor(Date.now() / 1000));
		if (result.status === 'missing') {
			return result;
		}
		if (result.status === 'expired') {
			// On our compatibility date deleteAll() also removes the alarm, so the notice gets one of its own.
			await this.ctx.storage.deleteAll();
			if (access.ajax === true) {
				this.ctx.storage.kv.put(EXPIRED_KEY, result.validity);
				await this.ctx.storage.setAlarm(Date.now() + SESSION_GC_GRACE_SECONDS * 1000);
			}
			return result;
		}
		const alarm = await this.ctx.storage.getAlarm();
		this.ctx.storage.kv.put(ACCESS_TIMES_KEY, result.data[ACCESS_TIMES_KEY]);
		await this.scheduleCleanup(result.data, alarm);
		return result;
	}

	/** Stores a new session after a login (Session::secure() gives every login a fresh id, so this object is empty). */
	async create(data: SessionData): Promise<void> {
		for (const [key, value] of Object.entries(data)) {
			this.ctx.storage.kv.put(key, value);
		}
		await this.scheduleCleanup(data, null);
	}

	/** Stores what a request changed; false when the session is gone (logged out or expired meanwhile), which is not brought back. */
	update(changes: SessionChanges): boolean {
		if (this.ctx.storage.kv.get(ACCESS_TIMES_KEY) === undefined) {
			return false;
		}
		for (const [key, value] of Object.entries(changes.set)) {
			this.ctx.storage.kv.put(key, value);
		}
		for (const key of changes.unset) {
			this.ctx.storage.kv.delete(key);
		}
		return true;
	}

	/** session_destroy(): logout and Session::secure() discard the whole session. */
	async destroy(): Promise<void> {
		await this.ctx.storage.deleteAll();
	}

	/** PHP's session garbage collection: deletes the session once it has been idle long enough, else waits for the new deadline. */
	async alarm(): Promise<void> {
		try {
			const deadline = sessionDeadline(this.load());
			// An alarm can run more than once, so an empty or already expired object simply ends up deleted again.
			if (deadline === null || Date.now() >= deadline * 1000) {
				await this.ctx.storage.deleteAll();
				return;
			}
			await this.ctx.storage.setAlarm(deadline * 1000);
		} catch (error) {
			console.error('Session cleanup failed; retrying later.', error);
			await this.ctx.storage.setAlarm(Date.now() + ALARM_RETRY_MS);
		}
	}
}

// Node stand-in for cloudflare:workers used by vitest and scripts/render-route.ts; servers mirror the oracle's two-server config.
import process from 'node:process';

import { memoryNamespace } from './durable-objects.ts';

/** Durable Object base class: the runtime hands each object its state and env. */
export class DurableObject<E = unknown> {
	constructor(protected readonly ctx: DurableObjectState, protected readonly env: E) {}
}

export const env: Env = {
	// A throwaway per-process key: render-route never reads cookies sealed by a real deployment.
	PMA_COOKIE_SECRET: `${crypto.randomUUID()}${crypto.randomUUID()}`,
	PMA_SERVERS: process.env.PMA_RENDER_SERVERS ?? JSON.stringify([{ host: 'dbadmin-mysql' }, { host: 'dbadmin-mysql-b' }]),
	// Sessions live in this process, so they last as long as one render-route or vitest run.
	PMA_SESSIONS: memoryNamespace(async () => {
		const module = await import('../../src/server/session-object.ts');
		return module.PmaSessionObject;
	}, () => env),
};

const pending: Promise<unknown>[] = [];

export function waitUntil(promise: Promise<unknown>): void {
	pending.push(promise.catch(() => {}));
}

/** Lets the script finish background work (connection closes) before exiting. */
export async function drainWaitUntil(): Promise<void> {
	await Promise.all(pending);
}

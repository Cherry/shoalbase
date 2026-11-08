// Node stand-in for cloudflare:workers used by scripts/render-route.ts; servers mirror the oracle's two-server config.
import process from 'node:process';

export const env: Env = {
	// A throwaway per-process key: render-route never reads cookies sealed by a real deployment.
	PMA_COOKIE_SECRET: `${crypto.randomUUID()}${crypto.randomUUID()}`,
	PMA_SERVERS: process.env.PMA_RENDER_SERVERS ?? JSON.stringify([{ host: 'dbadmin-mysql' }, { host: 'dbadmin-mysql-b' }]),
};

const pending: Promise<unknown>[] = [];

export function waitUntil(promise: Promise<unknown>): void {
	pending.push(promise.catch(() => {}));
}

/** Lets the script finish background work (connection closes) before exiting. */
export async function drainWaitUntil(): Promise<void> {
	await Promise.all(pending);
}

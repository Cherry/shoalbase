// The part of @cloudflare/vitest-plugin's cloudflare:test module these tests use, typed with src/env.d.ts's Workers subset, since the plugin's own types need @cloudflare/workers-types.
declare module 'cloudflare:test' {
	/** Runs `callback` inside the object `stub` points to, with its instance and state. */
	export function runInDurableObject<O, R>(stub: DurableObjectStub<O>, callback: (instance: O, state: DurableObjectState) => R | Promise<R>): Promise<R>;
	/** Runs and removes the object's scheduled alarm; false when none was scheduled. */
	export function runDurableObjectAlarm(stub: DurableObjectStub<unknown>): Promise<boolean>;
	/** The ids of every object created in `namespace` by this test file. */
	export function listDurableObjectIds(namespace: DurableObjectNamespace<unknown>): Promise<unknown[]>;
}

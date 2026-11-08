// Node stand-in for SQLite-backed Durable Objects: an in-memory storage with the synchronous KV API and one alarm, and a namespace whose stubs copy arguments and results like RPC.

/** Values are copied in and out, as Durable Object storage serializes them. */
export class MemoryStorage implements DurableObjectStorage {
	private readonly entries = new Map<string, unknown>();
	alarm: number | null = null;

	readonly kv = {
		get: (key: string): unknown => structuredClone(this.entries.get(key)),
		put: (key: string, value: unknown): void => {
			this.entries.set(key, structuredClone(value));
		},
		delete: (key: string): boolean => this.entries.delete(key),
		list: (): Iterable<[string, unknown]> => [...this.entries].toSorted(([left], [right]) => (left < right ? -1 : 1)).map(([key, value]) => [key, structuredClone(value)]),
	};

	get size(): number {
		return this.entries.size;
	}

	async getAlarm(): Promise<number | null> {
		return this.alarm;
	}

	async setAlarm(scheduledTime: number): Promise<void> {
		this.alarm = scheduledTime;
	}

	// On compatibility dates from 2026-02-24, deleteAll() removes the alarm too.
	async deleteAll(): Promise<void> {
		this.entries.clear();
		this.alarm = null;
	}
}

type ObjectClass<T> = new (ctx: DurableObjectState, env: Env) => T;

/**
 * A namespace of objects living in this process, created on first call like the real ones.
 * The class is loaded lazily, because it imports cloudflare:workers, which is the module that creates this namespace.
 */
export function memoryNamespace<T extends object>(load: () => Promise<ObjectClass<T>>, env: () => Env): DurableObjectNamespace<T> & { storage(name: string): MemoryStorage | undefined; } {
	const objects = new Map<string, { instance: T; storage: MemoryStorage; }>();
	const instance = async (name: string): Promise<T> => {
		let entry = objects.get(name);
		if (!entry) {
			const storage = new MemoryStorage();
			entry = { instance: new (await load())({ storage }, env()), storage };
			objects.set(name, entry);
		}
		return entry.instance;
	};
	return {
		getByName(name) {
			return new Proxy({}, {
				get: (_target, method) => async (...args: unknown[]) => {
					const object = await instance(name) as Record<PropertyKey, (...parameters: unknown[]) => unknown>;
					return structuredClone(await object[method](...structuredClone(args)));
				},
			}) as DurableObjectStub<T>;
		},
		storage: name => objects.get(name)?.storage,
	};
}

/// <reference types="astro/client" />

interface Env {
	/** Encrypts the login cookies, like phpMyAdmin's blowfish_secret. At least 32 characters. */
	PMA_COOKIE_SECRET?: string;
	/** JSON array of { host, port?, ssl?, pin? }: the servers users can sign in to. */
	PMA_SERVERS?: string;
	/** One Durable Object per phpMyAdmin session, holding $_SESSION (src/server/session-object.ts). */
	PMA_SESSIONS: DurableObjectNamespace<import('~/server/session-object').PmaSessionObject>;
}

/** The part of workerd's HTMLRewriter that src/server/branding.ts uses; it does not exist in Node. */
declare class HTMLRewriter {
	on(selector: string, handlers: { element(element: { append(content: string, options: { html: boolean; }): void; after(content: string, options: { html: boolean; }): void; }): void; }): HTMLRewriter;
	transform(response: Response): Response;
}

/** The parts of the Durable Objects API the session object uses (SQLite-backed storage with the synchronous KV API). */
interface DurableObjectStorage {
	readonly kv: {
		get(key: string): unknown;
		put(key: string, value: unknown): void;
		delete(key: string): boolean;
		list(): Iterable<[string, unknown]>;
	};
	getAlarm(): Promise<number | null>;
	setAlarm(scheduledTime: number): Promise<void>;
	deleteAll(): Promise<void>;
}

interface DurableObjectState {
	readonly storage: DurableObjectStorage;
}

/** An RPC stub: every public method of the object, returning a promise. */
type DurableObjectStub<T> = {
	[K in keyof T as T[K] extends (...args: never[]) => unknown ? K : never]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
};

interface DurableObjectNamespace<T> {
	getByName(name: string): DurableObjectStub<T>;
}

interface ExecutionContext {
	waitUntil(promise: Promise<unknown>): void;
	passThroughOnException(): void;
}

declare module 'cloudflare:workers' {
	const env: Env;
	function waitUntil(promise: Promise<unknown>): void;
	abstract class DurableObject<E = unknown> {
		protected readonly ctx: DurableObjectState;
		protected readonly env: E;
		constructor(ctx: DurableObjectState, env: E);
	}
	export { DurableObject, env, waitUntil };
}

declare module 'cloudflare:sockets' {
	interface SocketAddress {
		hostname: string;
		port: number;
	}

	interface SocketOptions {
		secureTransport?: 'off' | 'on' | 'starttls';
		allowHalfOpen?: boolean;
	}

	interface Socket {
		readonly readable: ReadableStream<Uint8Array<ArrayBuffer>>;
		readonly writable: WritableStream<Uint8Array<ArrayBuffer>>;
		readonly opened: Promise<unknown>;
		readonly closed: Promise<void>;
		close(): Promise<void>;
		startTls(): Socket;
	}

	function connect(address: SocketAddress, options?: SocketOptions): Socket;
	export { type Socket, connect };
}

declare namespace App {
	interface Locals {
		/** The LoginCookieValidity of a session that lapsed on this signed-out request, so the login form can explain why. */
		sessionExpired?: number;
		/** The session id the response's phpMyAdmin cookie carries: the signed-in session, or a fresh one when signed out. */
		sessionId?: string;
		/** $_SESSION of the signed-in session, stored again after the response when it changed. */
		session?: import('~/lib/pma/session').PmaSession;
		/** Set-Cookie lines for the response by cookie name, so a later line for a cookie replaces an earlier one. */
		cookieLines?: Map<string, string>;
		/** The parsed form body of a POST, read once and shared by the middleware and the dispatcher; null when there is none. */
		form?: FormData | null;
		/** The signed-in account's lazily opened MySQL link, set together with `auth`. */
		connection?: import('~/lib/connection').RequestConnection;
		/** The signed-in MySQL account; absent when signed out and on url.php and js/messages.php. */
		auth?: {
			user: string;
			host: string;
			/** serverKey() of the signed-in server. */
			server: string;
			serverIndex: number;
			/** CSRF token phpMyAdmin pages embed and check on POST. */
			token: string;
		};
	}
}

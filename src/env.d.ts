/// <reference types="astro/client" />

interface Env {
	/** Encrypts the login cookies, like phpMyAdmin's blowfish_secret. At least 32 characters. */
	PMA_COOKIE_SECRET?: string;
	/** JSON array of { host, port?, ssl?, pin? }: the servers users can sign in to. */
	PMA_SERVERS?: string;
}

/** The part of workerd's HTMLRewriter that src/server/branding.ts uses; it does not exist in Node. */
declare class HTMLRewriter {
	on(selector: string, handlers: { element(element: { append(content: string, options: { html: boolean; }): void; after(content: string, options: { html: boolean; }): void; }): void; }): HTMLRewriter;
	transform(response: Response): Response;
}

declare module 'cloudflare:workers' {
	const env: Env;
	function waitUntil(promise: Promise<unknown>): void;
	export { env, waitUntil };
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
		/** Set on signed-out index.php requests whose session lapsed, so the login form can explain why. */
		sessionExpired?: boolean;
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

import { Duplex } from 'node:stream';

import { type Socket, connect } from 'cloudflare:sockets';
import { createConnection } from 'mysql2';
import { createConnection as createPromiseConnection } from 'mysql2/promise';

import type { Connection } from 'mysql2/promise';
import type { ConnectionSettings, MysqlConnector } from '~/lib/connection';
import type { Bytes } from '~/lib/tls/bytes';

import {
	type ServerGreeting,
	authSwitchScramble,
	expectedMariaDbProof,
	isErrorPacket,
	isOkPacket,
	okPacketProof,
	parseGreeting,
	spkiPin,
	splitPackets,
} from '~/lib/server-identity';
import { type TlsConnection, type TlsPeer, connectTls } from '~/lib/tls/client';

const CONNECT_TIMEOUT_MS = 10000;

// mysqli sends neither IGNORE_SPACE (it would show up in the session sql_mode) nor FOUND_ROWS (UPDATE reports changed rows, not matched ones).
const MYSQLI_FLAGS = ['-IGNORE_SPACE', '-FOUND_ROWS'];

type TlsCallback = (error?: Error) => void;

const identityError = (message: string): Error => Object.assign(new Error(message), { code: 'HANDSHAKE_SSL_ERROR' });

interface AuthScreen {
	scramble: Bytes;
	certificate: Bytes;
	buffer: Bytes;
}

/**
 * Exposes a Workers TCP socket as the Node stream mysql2 expects, and runs TLS in-process instead of with startTls():
 * production servers present self-signed certificates that the runtime's TLS would reject, so trust comes from pins and MariaDB's proof.
 */
class WorkerSocketStream extends Duplex {
	private readonly socket: Socket;
	private readonly reader: ReadableStreamDefaultReader<Bytes>;
	private readonly writer: WritableStreamDefaultWriter<Bytes>;
	private tls: TlsConnection | undefined;
	private pendingWrite: Promise<void> = Promise.resolve();
	private awaitingTls: boolean;
	private upgradeRequested = false;
	private readLoop: Promise<void>;
	private plaintextBuffer = new Uint8Array(0);
	private greeting: ServerGreeting | null = null;
	private authScreen: AuthScreen | undefined;

	constructor(private readonly settings: ConnectionSettings) {
		super();
		this.awaitingTls = settings.ssl;
		this.socket = connect({ hostname: settings.host, port: settings.port }, { secureTransport: 'off', allowHalfOpen: false });
		this.reader = this.socket.readable.getReader();
		this.writer = this.socket.writable.getWriter();
		this.socket.opened
			.then(() => this.emit('connect'))
			.catch((error: unknown) => this.destroy(error as Error));
		this.readLoop = this.guard(this.pumpPlaintext());
	}

	private guard(loop: Promise<void>): Promise<void> {
		return loop.catch((error: unknown) => {
			this.destroy(error as Error);
		});
	}

	private async pumpPlaintext(): Promise<void> {
		for (;;) {
			const { done, value } = await this.reader.read();
			if (done) {
				this.push(null);
				return;
			}
			if (this.awaitingTls && !this.greeting) {
				this.captureGreeting(value);
			}
			this.push(Buffer.from(value));
			if (this.awaitingTls) {
				// Stop reading once mysql2 has asked for TLS, so no plaintext read is left pending under the handshake.
				await new Promise((resolve) => {
					setTimeout(resolve, 0);
				});
				if (this.upgradeRequested) { return; }
			}
		}
	}

	private captureGreeting(chunk: Bytes): void {
		const combined = new Uint8Array(this.plaintextBuffer.length + chunk.length);
		combined.set(this.plaintextBuffer);
		combined.set(chunk, this.plaintextBuffer.length);
		const [packet] = splitPackets(combined).packets;
		this.plaintextBuffer = packet ? new Uint8Array(0) : combined;
		if (packet) {
			this.greeting = parseGreeting(packet);
		}
	}

	private async pumpTls(tls: TlsConnection): Promise<void> {
		for (;;) {
			const data = await tls.read();
			if (data === null) {
				this.push(null);
				return;
			}
			if (this.authScreen) {
				await this.screenAuthentication(this.authScreen, data);
			} else {
				this.push(Buffer.from(data));
			}
		}
	}

	/** Passes authentication packets through, holding back the OK packet until MariaDB's certificate proof checks out. */
	private async screenAuthentication(screen: AuthScreen, data: Bytes): Promise<void> {
		const combined = new Uint8Array(screen.buffer.length + data.length);
		combined.set(screen.buffer);
		combined.set(data, screen.buffer.length);
		const { packets, rest } = splitPackets(combined);
		screen.buffer = Uint8Array.from(rest);
		for (const [index, packet] of packets.entries()) {
			if (isOkPacket(packet)) {
				const proof = okPacketProof(packet);
				const expected = await expectedMariaDbProof(this.settings.password, screen.scramble, screen.certificate);
				if (proof !== expected) { throw identityError('The MariaDB server could not prove its TLS certificate for this account.'); }
			}
			screen.scramble = authSwitchScramble(packet) ?? screen.scramble;
			this.push(Buffer.from(packet));
			if (isOkPacket(packet) || isErrorPacket(packet)) {
				this.authScreen = undefined;
				for (const remaining of [...packets.slice(index + 1), screen.buffer]) {
					if (remaining.length > 0) {
						this.push(Buffer.from(remaining));
					}
				}
				return;
			}
		}
	}

	private async verifyPeer(peer: TlsPeer): Promise<void> {
		if (this.settings.pin) {
			if (await spkiPin(peer.spki) !== this.settings.pin) { throw identityError('The server TLS certificate does not match the pinned key for this server.'); }
			return;
		}
		if (this.greeting?.isMariaDb) {
			this.authScreen = { scramble: this.greeting.scramble, certificate: peer.certificate, buffer: new Uint8Array(0) };
			return;
		}
		throw identityError('The server TLS certificate cannot be verified: this server has no pinned key.');
	}

	override _read(): void {
		// Data is pushed by the read loops as it arrives.
	}

	override _write(chunk: Uint8Array, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		// mysql2 hands over pooled Node Buffers; a copy gives WebCrypto and the socket an ArrayBuffer-backed view.
		const data = new Uint8Array(chunk);
		if (this.tls) {
			this.pendingWrite = this.tls.write(data);
		} else {
			this.pendingWrite = this.writer.write(data);
		}
		this.pendingWrite.then(() => callback()).catch(callback);
	}

	override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
		const closing = this.tls ? this.tls.close() : Promise.resolve();
		closing
			.then(() => this.socket.close())
			.catch(() => {})
			.finally(() => callback(error));
	}

	async upgradeToTls(): Promise<void> {
		this.upgradeRequested = true;
		await this.readLoop;
		// The SSLRequest packet must reach the server before the TLS ClientHello.
		while (this.writableLength > 0) {
			await this.pendingWrite;
			await Promise.resolve();
		}
		this.awaitingTls = false;
		const tls = await connectTls({
			read: async () => {
				const { done, value } = await this.reader.read();
				return done ? null : value;
			},
			write: data => this.writer.write(data),
		}, { serverName: this.settings.host, verifyPeer: peer => this.verifyPeer(peer) });
		this.tls = tls;
		this.readLoop = this.guard(this.pumpTls(tls));
	}
}

export const connectFromWorker: MysqlConnector = (settings: ConnectionSettings) => new Promise<Connection>((resolve, reject) => {
	const stream = new WorkerSocketStream(settings);
	const connection = createConnection({
		host: settings.host,
		port: settings.port,
		user: settings.user,
		password: settings.password,
		ssl: settings.ssl ? {} : undefined,
		stream,
		connectTimeout: CONNECT_TIMEOUT_MS,
		disableEval: true,
		flags: MYSQLI_FLAGS,
	});
	(connection as unknown as { startTLS: (onSecure: TlsCallback) => void; }).startTLS = async (onSecure) => {
		try {
			await stream.upgradeToTls();
		} catch (error) {
			onSecure(error as Error);
			return;
		}
		onSecure();
	};
	const onError = (error: Error) => {
		stream.destroy();
		reject(error);
	};
	connection.once('error', onError);
	connection.once('connect', () => {
		connection.removeListener('error', onError);
		// Errors on an idle connection would otherwise be unhandled; the next query reports them instead.
		connection.on('error', () => {});
		resolve(connection.promise());
	});
});

/** mysql2's own TCP client, for Node scripts such as scripts/render-route.ts that have no Workers sockets. */
export const connectWithMysql2: MysqlConnector = settings => createPromiseConnection({
	host: settings.host,
	port: settings.port,
	user: settings.user,
	password: settings.password,
	ssl: settings.ssl ? {} : undefined,
	disableEval: true,
	flags: MYSQLI_FLAGS,
});

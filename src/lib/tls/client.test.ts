// @vitest-environment node
import {
	X509Certificate,
	createCipheriv,
	createDecipheriv,
	createHmac,
	createPrivateKey,
	generateKeyPairSync,
	sign,
} from 'node:crypto';
import { once } from 'node:events';
import net from 'node:net';
import tls from 'node:tls';

import {
	afterEach,
	describe,
	expect,
	it,
} from 'vitest';

import type { Bytes } from '~/lib/tls/bytes';

import {
	type TlsConnection,
	type TlsTransport,
	alertError,
	assertFinished,
	connectTls,
	parseTls13Inner,
	tls13PostHandshakeAction,
} from '~/lib/tls/client';
import {
	ec256Certificate,
	ec256Key,
	ec384Certificate,
	ec384Key,
	rsaCertificate,
	rsaKey,
	weakDhParams,
} from '~/lib/tls/test-fixtures';

const cleanups: Array<() => void> = [];
afterEach(() => {
	const pending = [...cleanups];
	cleanups.length = 0;
	for (const cleanup of pending) {
		cleanup();
	}
});

const bytes = (...values: number[]): Bytes => new Uint8Array(values);
const join = (...parts: Uint8Array[]): Bytes => new Uint8Array(Buffer.concat(parts));
const u16 = (value: number): Bytes => bytes(value >> 8, value & 0xFF);
const u24 = (value: number): Bytes => bytes(value >> 16, (value >> 8) & 0xFF, value & 0xFF);
const record = (type: number, payload: Bytes): Bytes => join(bytes(type, 3, 3), u16(payload.length), payload);
const handshake = (type: number, body: Bytes): Bytes => join(bytes(type), u24(body.length), body);
const text = (value: string): Bytes => new TextEncoder().encode(value);

const socketTransport = (socket: net.Socket): TlsTransport => {
	const queue: Bytes[] = [];
	const waiters: Array<(chunk: Bytes | null) => void> = [];
	let ended = false;
	socket.on('data', (chunk) => {
		const waiter = waiters.shift();
		if (waiter) {
			waiter(new Uint8Array(chunk));
		} else {
			queue.push(new Uint8Array(chunk));
		}
	});
	const finish = (): void => {
		ended = true;
		const pending = [...waiters];
		waiters.length = 0;
		for (const waiter of pending) {
			waiter(null);
		}
	};
	socket.on('end', finish);
	socket.on('close', finish);
	socket.on('error', finish);
	return {
		read: () => new Promise((resolve) => {
			const chunk = queue.shift();
			if (chunk) {
				resolve(chunk);
			} else if (ended) {
				resolve(null);
			} else {
				waiters.push(resolve);
			}
		}),
		write: data => new Promise((resolve, reject) => {
			socket.write(data, error => (error ? reject(error) : resolve()));
		}),
	};
};

const connectTo = async (port: number, verifyPeer: () => Promise<void> = async () => {}): Promise<TlsConnection> => {
	const socket = net.connect(port, '127.0.0.1');
	cleanups.push(() => socket.destroy());
	await once(socket, 'connect');
	return connectTls(socketTransport(socket), { serverName: 'localhost', verifyPeer });
};

const listen = async (server: net.Server): Promise<number> => {
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	cleanups.push(() => server.close());
	return (server.address() as net.AddressInfo).port;
};

const echoServer = (options: tls.TlsOptions, onConnection?: (socket: tls.TLSSocket) => void): { server: tls.Server; port: Promise<number>; } => {
	const server = tls.createServer({ key: rsaKey, cert: rsaCertificate, ...options }, (socket) => {
		socket.on('error', () => {});
		if (onConnection) {
			onConnection(socket);
		} else {
			socket.pipe(socket);
		}
	});
	server.on('tlsClientError', () => {});
	return { server, port: listen(server) };
};

const readBytes = async (connection: TlsConnection, length: number): Promise<Bytes> => {
	let received = new Uint8Array(0);
	while (received.length < length) {
		const chunk = await connection.read();
		if (!chunk) { break; }
		received = join(received, chunk);
	}
	return received;
};

const passThrough = (data: Bytes): Bytes => data;

/** Forwards whole TLS records between client and server, letting a test rewrite or inject records. */
const recordProxy = async (targetPort: number, mapToServer: (record: Bytes) => Bytes = passThrough, mapToClient: (record: Bytes) => Bytes = passThrough) => {
	let clientSide: net.Socket | undefined;
	let serverRandom: Bytes | undefined;
	const reassemble = (map: (record: Bytes) => Bytes, sink: (data: Bytes) => void) => {
		let buffer = new Uint8Array(0);
		return (chunk: Buffer) => {
			buffer = join(buffer, chunk);
			while (buffer.length >= 5 && buffer.length >= 5 + ((buffer[3] as number) << 8 | (buffer[4] as number))) {
				const length = 5 + ((buffer[3] as number) << 8 | (buffer[4] as number));
				sink(map(buffer.slice(0, length)));
				buffer = buffer.slice(length);
			}
		};
	};
	const server = net.createServer((client) => {
		clientSide = client;
		const upstream = net.connect(targetPort, '127.0.0.1');
		cleanups.push(() => upstream.destroy(), () => client.destroy());
		client.on('error', () => {});
		upstream.on('error', () => {});
		client.on('data', reassemble(mapToServer, data => upstream.write(data)));
		upstream.on('data', reassemble((serverRecord) => {
			if (!serverRandom && serverRecord[5] === 2) {
				serverRandom = serverRecord.slice(11, 43);
			}
			return mapToClient(serverRecord);
		}, data => client.write(data)));
	});
	const port = await listen(server);
	return {
		port,
		inject: (data: Bytes) => clientSide?.write(data),
		endClient: () => clientSide?.end(),
		serverRandom: () => serverRandom as Bytes,
	};
};

const hmac = (hash: 'sha256' | 'sha384', key: Bytes, data: Bytes): Bytes => new Uint8Array(createHmac(hash, key).update(data).digest());

/** Test oracle for TLS 1.2 key expansion (RFC 5246 PRF), used only to forge records as the server would. */
const prf12 = (secret: Bytes, label: string, seed: Bytes, length: number): Bytes => {
	const labelSeed = join(text(label), seed);
	let output = new Uint8Array(0);
	for (let chained = labelSeed; output.length < length;) {
		chained = hmac('sha256', secret, chained);
		output = join(output, hmac('sha256', secret, join(chained, labelSeed)));
	}
	return output.slice(0, length);
};

const expandLabel13 = (secret: Bytes, label: string, length: number): Bytes => {
	const info = join(u16(length), bytes(6 + label.length), text(`tls13 ${label}`), bytes(0));
	return hmac('sha256', secret, join(info, bytes(1))).slice(0, length);
};

const gcmSeal = (key: Bytes, nonce: Bytes, aad: Bytes, plaintext: Bytes): Bytes => {
	const cipher = createCipheriv(key.length === 16 ? 'aes-128-gcm' : 'aes-256-gcm', key, nonce);
	cipher.setAAD(aad);
	return join(cipher.update(plaintext), cipher.final(), cipher.getAuthTag());
};

const sequence = (value: number): Bytes => {
	const out = new Uint8Array(8);
	new DataView(out.buffer).setBigUint64(0, BigInt(value));
	return out;
};

/** Forges server records for an established TLS 1.2 ECDHE-RSA-AES128-GCM-SHA256 session from the server's keylog. */
const tls12Forger = (keylog: string, serverRandom: Bytes) => {
	const [, clientRandomHex, masterHex] = keylog.trim().split(' ', 3);
	const keyBlock = prf12(Buffer.from(masterHex as string, 'hex'), 'key expansion', join(serverRandom, Buffer.from(clientRandomHex as string, 'hex')), 40);
	const key = keyBlock.slice(16, 32);
	const salt = keyBlock.slice(36, 40);
	// The server's Finished used sequence 0.
	let next = 1;
	return (type: number, payload: Bytes): Bytes => {
		const explicit = sequence(next);
		const aad = join(explicit, bytes(type, 3, 3), u16(payload.length));
		next += 1;
		return record(type, join(explicit, gcmSeal(key, join(salt, explicit), aad, payload)));
	};
};

describe('TLS handshakes against OpenSSL', () => {
	it('negotiates TLS 1.3 with AES-256-GCM and exchanges multi-record payloads both ways', async () => {
		const { port } = echoServer({ minVersion: 'TLSv1.3', ciphers: 'TLS_AES_256_GCM_SHA384' });
		const connection = await connectTo(await port, async () => {});
		const seenPeer = connection.peer.spki;
		expect(connection.version).toBe('TLSv1.3');
		expect(connection.cipherSuite).toBe('TLS_AES_256_GCM_SHA384');
		expect(seenPeer).toEqual(new Uint8Array(new X509Certificate(rsaCertificate).publicKey.export({ type: 'spki', format: 'der' })));
		const payload = crypto.getRandomValues(new Uint8Array(40000));
		await connection.write(payload);
		await connection.write(new Uint8Array(0));
		expect(await readBytes(connection, payload.length)).toEqual(payload);
		await connection.close();
		await connection.close();
	});

	it('negotiates TLS 1.3 with ECDSA certificates and answers a client certificate request', async () => {
		for (const [key, cert, suite] of [[ec256Key, ec256Certificate, 'TLS_AES_128_GCM_SHA256'], [ec384Key, ec384Certificate, 'TLS_AES_256_GCM_SHA384']] as const) {
			const { port } = echoServer({ key, cert, minVersion: 'TLSv1.3', ciphers: suite, requestCert: true, rejectUnauthorized: false });
			const connection = await connectTo(await port);
			expect(connection.cipherSuite).toBe(suite);
			await connection.write(text('ping'));
			expect(await readBytes(connection, 4)).toEqual(text('ping'));
		}
	});

	it('negotiates TLS 1.2 DHE-RSA like MySQL 5.7 servers', async () => {
		for (const suite of ['DHE-RSA-AES256-GCM-SHA384', 'DHE-RSA-AES128-GCM-SHA256']) {
			const { port } = echoServer({ maxVersion: 'TLSv1.2', ciphers: suite, dhparam: 'auto' });
			const connection = await connectTo(await port);
			expect([connection.version, connection.cipherSuite]).toEqual(['TLSv1.2', suite]);
			const payload = crypto.getRandomValues(new Uint8Array(20000));
			await connection.write(payload);
			expect(await readBytes(connection, payload.length)).toEqual(payload);
		}
	});

	it('negotiates TLS 1.2 ECDHE with RSA and ECDSA certificates, with and without extended master secret', async () => {
		const cases: Array<[tls.TlsOptions, string]> = [
			[{ ciphers: 'ECDHE-RSA-AES256-GCM-SHA384' }, 'ECDHE-RSA-AES256-GCM-SHA384'],
			[{ key: ec256Key, cert: ec256Certificate, ciphers: 'ECDHE-ECDSA-AES128-GCM-SHA256', requestCert: true, rejectUnauthorized: false }, 'ECDHE-ECDSA-AES128-GCM-SHA256'],
			[{ key: ec256Key, cert: ec256Certificate, ciphers: 'ECDHE-ECDSA-AES256-GCM-SHA384', ecdhCurve: 'P-384' }, 'ECDHE-ECDSA-AES256-GCM-SHA384'],
			// SSL_OP_NO_EXTENDED_MASTER_SECRET (OpenSSL 3) forces the RFC 5246 master secret derivation.
			[{ ciphers: 'ECDHE-RSA-AES128-GCM-SHA256', secureOptions: 0x1 }, 'ECDHE-RSA-AES128-GCM-SHA256'],
		];
		for (const [options, suite] of cases) {
			const { port } = echoServer({ maxVersion: 'TLSv1.2', ...options });
			const connection = await connectTo(await port);
			expect(connection.cipherSuite).toBe(suite);
			await connection.write(text('ping'));
			expect(await readBytes(connection, 4)).toEqual(text('ping'));
		}
	});

	it('treats a TCP close without close_notify as end of stream, as MySQL servers often close that way', async () => {
		const { port } = echoServer({}, (socket) => {
			setTimeout(() => socket.destroy(), 20);
		});
		const connection = await connectTo(await port);
		expect(await connection.read()).toBeNull();
	});

	it('reads data up to an orderly server close, then reports end of stream', async () => {
		const { port } = echoServer({}, socket => socket.end('bye'));
		const connection = await connectTo(await port);
		expect(await readBytes(connection, 3)).toEqual(text('bye'));
		expect(await connection.read()).toBeNull();
		expect(await connection.read()).toBeNull();
	});
});

describe('TLS handshake failures', () => {
	it('aborts when the caller does not trust the server key', async () => {
		const { port } = echoServer({});
		await expect(connectTo(await port, async () => { throw new Error('pin mismatch'); })).rejects.toThrow('pin mismatch');
	});

	it('reports the server alert when no cipher suite is shared', async () => {
		const { port } = echoServer({ maxVersion: 'TLSv1.2', ciphers: 'AES128-SHA' });
		await expect(connectTo(await port)).rejects.toThrow('The server sent TLS alert 40.');
	});

	it('refuses Diffie-Hellman groups below 2048 bits', async () => {
		const { port } = echoServer({ maxVersion: 'TLSv1.2', ciphers: 'DHE-RSA-AES128-GCM-SHA256:@SECLEVEL=0', dhparam: weakDhParams });
		await expect(connectTo(await port)).rejects.toThrow('Server Diffie-Hellman group is too weak.');
	});

	it('fails rather than retrying when the server demands a key share it was not sent', async () => {
		const { port } = echoServer({ minVersion: 'TLSv1.3', ecdhCurve: 'P-384' });
		await expect(connectTo(await port)).rejects.toThrow('requested a key share this client does not offer');
	});

	it('detects a man-in-the-middle forcing TLS 1.2 on a TLS 1.3 server', async () => {
		const { port } = echoServer({});
		const supportedVersions = Buffer.from([0x00, 0x2B, 0x00, 0x05, 0x04, 0x03, 0x04, 0x03, 0x03]);
		const proxy = await recordProxy(await port, (clientRecord) => {
			const index = Buffer.from(clientRecord).indexOf(supportedVersions);
			if (index !== -1) {
				clientRecord[index + 6] = 3;
			}
			return clientRecord;
		});
		await expect(connectTo(proxy.port)).rejects.toThrow('TLS downgrade detected.');
	});

	it('rejects a TLS 1.2 key exchange whose signature was tampered with', async () => {
		const { port } = echoServer({ maxVersion: 'TLSv1.2', ciphers: 'ECDHE-RSA-AES128-GCM-SHA256' });
		const proxy = await recordProxy(await port, passThrough, (serverRecord) => {
			for (let offset = 5; serverRecord[0] === 22 && offset + 4 <= serverRecord.length;) {
				const length = (serverRecord[offset + 1] as number) << 16 | (serverRecord[offset + 2] as number) << 8 | (serverRecord[offset + 3] as number);
				if (serverRecord[offset] === 12) {
					serverRecord[offset + 3 + length] = (serverRecord[offset + 3 + length] as number) ^ 1;
				}
				offset += 4 + length;
			}
			return serverRecord;
		});
		await expect(connectTo(proxy.port)).rejects.toThrow('Server handshake signature is invalid.');
	});

	it('rejects tampered encrypted handshake records', async () => {
		const { port } = echoServer({ minVersion: 'TLSv1.3' });
		let tampered = false;
		const proxy = await recordProxy(await port, passThrough, (serverRecord) => {
			if (!tampered && serverRecord[0] === 23) {
				tampered = true;
				serverRecord[serverRecord.length - 1] = (serverRecord.at(-1) as number) ^ 1;
			}
			return serverRecord;
		});
		await expect(connectTo(proxy.port)).rejects.toThrow('TLS record authentication failed.');
	});

	it('still reports the original error when the alert cannot be sent', async () => {
		const transport: TlsTransport = { read: async () => null, write: async () => { throw new Error('socket closed'); } };
		await expect(connectTls(transport, { verifyPeer: async () => {} })).rejects.toThrow('socket closed');
		const closedTransport: TlsTransport = { read: async () => null, write: async () => {} };
		await expect(connectTls(closedTransport, { serverName: '10.0.0.1', verifyPeer: async () => {} })).rejects.toThrow('closed the connection during the TLS handshake');
	});
});

describe('established sessions', () => {
	const tls12Session = async () => {
		let keylog = '';
		const { server, port } = echoServer({ maxVersion: 'TLSv1.2', ciphers: 'ECDHE-RSA-AES128-GCM-SHA256' }, () => {});
		server.on('keylog', (line) => {
			keylog = line.toString();
		});
		const proxy = await recordProxy(await port);
		const connection = await connectTo(proxy.port);
		return { connection, proxy, forge: tls12Forger(keylog, proxy.serverRandom()) };
	};

	it('skips empty records, ignores renegotiation requests, and treats close_notify as end of stream', async () => {
		const { connection, proxy, forge } = await tls12Session();
		proxy.inject(join(
			forge(23, new Uint8Array(0)),
			forge(23, text('ok')),
			forge(22, handshake(0, new Uint8Array(0))),
			forge(23, text('after')),
			forge(21, bytes(1, 0)),
		));
		expect(await connection.read()).toEqual(text('ok'));
		expect(await connection.read()).toEqual(text('after'));
		expect(await connection.read()).toBeNull();
	});

	it('rejects unexpected post-handshake messages, unknown record types, and fatal alerts', async () => {
		for (const [type, payload, message] of [
			[22, handshake(1, new Uint8Array(0)), 'Unexpected post-handshake message.'],
			[99, text('?'), 'Unexpected TLS record type.'],
			[21, bytes(2, 40), 'The server sent TLS alert 40.'],
		] as const) {
			const { connection, proxy, forge } = await tls12Session();
			proxy.inject(forge(type, payload));
			await expect(connection.read()).rejects.toThrow(message);
		}
	});

	it('rejects malformed, oversized, and truncated records', async () => {
		const { connection: tls12, proxy: proxy12 } = await tls12Session();
		proxy12.inject(record(23, bytes(1, 2, 3, 4)));
		await expect(tls12.read()).rejects.toThrow('TLS record is too short.');

		const { port } = echoServer({ minVersion: 'TLSv1.3' }, () => {});
		for (const [injected, message] of [
			[record(22, bytes(0, 0, 0, 0)), 'Unexpected unencrypted TLS record.'],
			[join(bytes(23, 3, 3), u16(20000)), 'TLS record is too large.'],
			[join(bytes(23, 3, 3), u16(100), bytes(1, 2)), 'Connection closed in the middle of a TLS record.'],
		] as const) {
			const proxy = await recordProxy(await port);
			const connection = await connectTo(proxy.port);
			proxy.inject(injected);
			proxy.endClient();
			await expect(connection.read()).rejects.toThrow(message);
		}
	});

	it('follows TLS 1.3 key updates from the server and answers update requests', async () => {
		let trafficSecret = new Uint8Array(0);
		const received: Bytes[] = [];
		const { server, port } = echoServer({ minVersion: 'TLSv1.3', ciphers: 'TLS_AES_128_GCM_SHA256' }, (socket) => {
			socket.on('data', (chunk) => {
				received.push(new Uint8Array(chunk));
			});
		});
		server.on('keylog', (line) => {
			const [label, , secret] = line.toString().trim().split(' ', 3);
			if (label === 'SERVER_TRAFFIC_SECRET_0') {
				trafficSecret = new Uint8Array(Buffer.from(secret as string, 'hex'));
			}
		});
		// Count the server's application-key records (session tickets) by trial decryption, so forged records continue its sequence.
		let applicationRecords = 0;
		const proxy = await recordProxy(await port, passThrough, (serverRecord) => {
			if (serverRecord[0] === 23 && trafficSecret.length > 0) {
				const nonce = expandLabel13(trafficSecret, 'iv', 12).map((byte, position) => byte ^ (position >= 4 ? (sequence(applicationRecords)[position - 4] as number) : 0));
				const decipher = createDecipheriv('aes-128-gcm', expandLabel13(trafficSecret, 'key', 16), nonce);
				decipher.setAAD(serverRecord.subarray(0, 5));
				decipher.setAuthTag(serverRecord.subarray(-16));
				try {
					decipher.update(serverRecord.subarray(5, -16));
					decipher.final();
					applicationRecords += 1;
				} catch {
					// Handshake-key records do not decrypt with the application key.
				}
			}
			return serverRecord;
		});
		const connection = await connectTo(proxy.port);
		const forge = (secret: Bytes, index: number, type: number, payload: Bytes): Bytes => {
			const key = expandLabel13(secret, 'key', 16);
			const iv = expandLabel13(secret, 'iv', 12);
			const nonce = iv.map((byte, position) => byte ^ (position >= 4 ? (sequence(index)[position - 4] as number) : 0));
			const inner = join(payload, bytes(type), new Uint8Array(3));
			const header = join(bytes(23, 3, 3), u16(inner.length + 16));
			return join(header, gcmSeal(key, nonce, header, inner));
		};
		// Wait for session tickets to arrive; their records were counted as they passed.
		await new Promise((resolve) => {
			setTimeout(resolve, 200);
		});
		const ticketRecords = applicationRecords;
		expect(ticketRecords).toBeGreaterThan(0);
		const updated = expandLabel13(trafficSecret, 'traffic upd', 32);
		proxy.inject(join(
			forge(trafficSecret, ticketRecords, 22, handshake(24, bytes(1))),
			forge(updated, 0, 23, text('fresh keys')),
		));
		expect(await connection.read()).toEqual(text('fresh keys'));
		// The client answered with its own KeyUpdate; OpenSSL only decrypts this if the client switched keys correctly.
		await connection.write(text('after update'));
		await new Promise((resolve) => {
			setTimeout(resolve, 200);
		});
		expect(Buffer.concat(received).toString()).toContain('after update');
	}, 10000);
});

describe('malformed server handshakes', () => {
	interface ClientHello {
		sessionId: Bytes;
		random: Bytes;
	}

	/** A scripted server that answers the first ClientHello with whatever bytes the test supplies, then closes once the client replies (or at once). */
	const scriptedServer = async (respond: (hello: ClientHello) => Bytes | Promise<Bytes>, waitForReply: boolean): Promise<number> => {
		const server = net.createServer((socket) => {
			socket.on('error', () => {});
			socket.once('data', async (chunk) => {
				const sessionLength = chunk[43] as number;
				socket.write(await respond({ random: new Uint8Array(chunk.subarray(11, 43)), sessionId: new Uint8Array(chunk.subarray(44, 44 + sessionLength)) }));
				if (waitForReply) {
					// The client's reply spans several writes; close once it goes quiet so none of them fail.
					let timer: ReturnType<typeof setTimeout> | undefined;
					socket.on('data', () => {
						clearTimeout(timer);
						timer = setTimeout(() => socket.end(), 50);
					});
				} else {
					socket.end();
				}
			});
		});
		return listen(server);
	};

	const extension = (type: number, data: Bytes): Bytes => join(u16(type), u16(data.length), data);
	const serverHello = (options: { version?: number; random?: Bytes; sessionId?: Bytes; suite: number; compression?: number; extensions?: Bytes[]; trailing?: Bytes; }): Bytes => {
		const extensions = options.extensions ? (() => {
			const list = join(...options.extensions as Bytes[]);
			return join(u16(list.length), list);
		})() : new Uint8Array(0);
		const sessionId = options.sessionId ?? new Uint8Array(0);
		const body = join(u16(options.version ?? 0x03_03), options.random ?? new Uint8Array(32).fill(7), bytes(sessionId.length), sessionId, u16(options.suite), bytes(options.compression ?? 0), extensions, options.trailing ?? new Uint8Array(0));
		return record(22, handshake(2, body));
	};
	const tls13Version = extension(43, u16(0x03_04));
	const x25519Share = (): Bytes => {
		const raw = Buffer.from(generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' }).x as string, 'base64url');
		return extension(51, join(u16(0x00_1D), u16(raw.length), raw));
	};
	const helloRetryRandom = Buffer.from('cf21ad74e59a6111be1d8c021e65b891c2a211167abb8c5e079e09e2c8a8339c', 'hex');

	const expectFailure = async (respond: (hello: ClientHello) => Bytes | Promise<Bytes>, message: string, waitForReply = false): Promise<void> => {
		await expect(connectTo(await scriptedServer(respond, waitForReply))).rejects.toThrow(message);
	};

	it('rejects ServerHello parameters the client never offered', async () => {
		await expectFailure(() => serverHello({ suite: 0x13_01, random: helloRetryRandom, extensions: [tls13Version] }), 'requested a key share');
		await expectFailure(() => serverHello({ suite: 0x00_35 }), 'did not offer');
		await expectFailure(() => serverHello({ suite: 0xC0_2F, compression: 1 }), 'did not offer');
		await expectFailure(() => serverHello({ suite: 0xC0_2F, version: 0x03_02 }), 'did not offer');
		await expectFailure(() => serverHello({ suite: 0xC0_2F, extensions: [tls13Version] }), 'did not offer');
		await expectFailure(() => serverHello({ suite: 0xC0_2F, extensions: [extension(43, u16(0x03_03))] }), 'unsupported TLS version');
		await expectFailure(() => serverHello({ suite: 0xC0_2F, extensions: [extension(23, new Uint8Array(0)), extension(23, new Uint8Array(0))] }), 'Duplicate TLS extension.');
		await expectFailure(() => serverHello({ suite: 0xC0_2F, extensions: [], trailing: bytes(1) }), 'trailing bytes');
		await expectFailure(() => record(22, handshake(2, bytes(3, 3))), 'Malformed TLS message.');
	});

	it('reassembles handshake messages split across records', async () => {
		await expectFailure(() => {
			const message = serverHello({ suite: 0x00_35 }).subarray(5);
			return join(record(22, message.subarray(0, 10)), record(22, message.subarray(10)));
		}, 'did not offer');
	});

	it('rejects TLS 1.3 ServerHellos with a wrong session echo or unusable key share', async () => {
		await expectFailure(() => serverHello({ suite: 0x13_01, extensions: [tls13Version, x25519Share()] }), 'did not echo the session ID');
		await expectFailure(({ sessionId }) => serverHello({ suite: 0x13_01, sessionId, extensions: [tls13Version] }), 'Malformed TLS message.');
		await expectFailure(({ sessionId }) => serverHello({ suite: 0x13_01, sessionId, extensions: [tls13Version, extension(51, join(u16(0x00_18), u16(1), bytes(4)))] }), 'key share this client did not offer');
		await expectFailure(({ sessionId }) => serverHello({ suite: 0x13_01, sessionId, extensions: [tls13Version, extension(51, join(u16(0x00_1D), u16(32), new Uint8Array(32)))] }), 'Invalid server key share.');
		// A valid ServerHello followed by part of the next message in the same record would be decrypted with the wrong keys.
		await expectFailure(({ sessionId }) => {
			const hello = serverHello({ suite: 0x13_01, sessionId, extensions: [tls13Version, x25519Share()] });
			const payload = join(hello.subarray(5), bytes(8, 0));
			return record(22, payload);
		}, 'Handshake message crosses a key change.');
	});

	it('rejects unexpected records and alerts during the handshake', async () => {
		await expectFailure(() => record(22, handshake(11, new Uint8Array(0))), 'Unexpected TLS handshake message 11.');
		await expectFailure(() => record(23, bytes(1)), 'Unexpected TLS record during the handshake.');
		// In TLS 1.2 a ChangeCipherSpec before the handshake is done would skip the server's key change, so it is fatal.
		await expectFailure(() => record(20, bytes(1)), 'Unexpected TLS record during the handshake.');
		await expectFailure(() => record(21, bytes(2, 70)), 'The server sent TLS alert 70.');
		await expectFailure(() => record(21, bytes(1, 0)), 'The server closed the TLS handshake.');
	});

	describe('TLS 1.2 server flights', () => {
		const rsaPrivate = createPrivateKey(rsaKey);
		const certificateMessage = (pem: string): Bytes => {
			const certificate = new X509Certificate(pem).raw;
			return handshake(11, join(u24(certificate.length + 3), u24(certificate.length), certificate));
		};
		const serverRandom = new Uint8Array(32).fill(9);

		/** A genuinely signed ECDHE-RSA key exchange, followed by whatever the test appends. */
		const flight = (hello: ClientHello, tail: Bytes, params?: Bytes): Bytes => {
			const raw = Buffer.from(generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' }).x as string, 'base64url');
			const keyParams = params ?? join(bytes(3), u16(0x00_1D), bytes(raw.length), raw);
			const signature = sign('sha256', join(hello.random, serverRandom, keyParams), rsaPrivate);
			const keyExchange = handshake(12, join(keyParams, u16(0x04_01), u16(signature.length), signature));
			return join(
				serverHello({ suite: 0xC0_2F, random: serverRandom, extensions: [] }),
				record(22, join(certificateMessage(rsaCertificate), keyExchange)),
				tail,
			);
		};

		it('checks the certificate type, ECDHE group, and ServerHelloDone', async () => {
			await expectFailure(() => join(serverHello({ suite: 0xC0_2F, extensions: [] }), record(22, certificateMessage(ec256Certificate))), 'Certificate key does not match the cipher suite.');
			await expectFailure(hello => flight(hello, new Uint8Array(0), join(bytes(1), u16(0x00_1D), bytes(1, 4))), 'unsupported ECDHE group');
			await expectFailure(hello => flight(hello, new Uint8Array(0), join(bytes(3), u16(0x00_1E), bytes(1, 4))), 'unsupported ECDHE group');
			await expectFailure(hello => flight(hello, record(22, handshake(14, bytes(1)))), 'Malformed ServerHelloDone.');
			await expectFailure(hello => flight(hello, record(22, join(bytes(13, 0, 0, 0), handshake(14, new Uint8Array(0)), bytes(0)))), 'Handshake message crosses a key change.');
		});

		it('requires ChangeCipherSpec after the client Finished', async () => {
			const done = record(22, handshake(14, new Uint8Array(0)));
			await expectFailure(hello => flight(hello, join(done, record(22, handshake(20, new Uint8Array(12))))), 'Expected ChangeCipherSpec.', true);
			await expectFailure(hello => flight(hello, join(done, record(21, bytes(2, 51)))), 'The server sent TLS alert 51.', true);
			await expectFailure(hello => flight(hello, join(done, record(21, bytes(1, 0)))), 'The server closed the TLS handshake.', true);
			await expectFailure(hello => flight(hello, done), 'Expected ChangeCipherSpec.', true);
		});
	});
});

describe('record and message helpers', () => {
	it('decodes alerts, padding, and post-handshake actions', () => {
		expect(alertError(bytes(1, 0))).toBeNull();
		expect(alertError(bytes(2, 20))?.alert).toBe(20);
		expect(alertError(bytes(2))?.message).toBe('The server sent TLS alert unknown.');
		expect(parseTls13Inner(bytes(7, 8, 23, 0, 0))).toEqual({ type: 23, data: bytes(7, 8) });
		expect(() => parseTls13Inner(bytes(0, 0))).toThrow('TLS record has no content type.');
		expect(tls13PostHandshakeAction(4, bytes(1, 2))).toBe('ignore');
		expect(tls13PostHandshakeAction(24, bytes(0))).toBe('update');
		expect(tls13PostHandshakeAction(24, bytes(1))).toBe('update-and-reply');
		expect(() => tls13PostHandshakeAction(24, bytes(2))).toThrow('Unexpected post-handshake message.');
		expect(() => tls13PostHandshakeAction(24, bytes(0, 0))).toThrow('Unexpected post-handshake message.');
		expect(() => tls13PostHandshakeAction(5, bytes(0))).toThrow('Unexpected post-handshake message.');
		expect(() => assertFinished(bytes(1), bytes(2))).toThrow('Server Finished verification failed.');
		expect(() => assertFinished(bytes(1), bytes(1))).not.toThrow();
	});
});

import {
	ByteReader,
	type Bytes,
	TlsError,
	ascii,
	concat,
	equalBytes,
	uint,
	vector,
} from '~/lib/tls/bytes';
import {
	type EcdhGroup,
	type EcdhShare,
	type HashName,
	NAMED_GROUPS,
	SIGNATURE_SCHEMES,
	aesGcmDecrypt,
	aesGcmEncrypt,
	dheAgree,
	digest,
	ecdhSharedSecret,
	expandLabel,
	generateEcdhShare,
	hashLength,
	hkdfExtract,
	hmac,
	importAesKey,
	prf,
	verifySignature,
} from '~/lib/tls/crypto';
import { certificateSpki, spkiKeyType } from '~/lib/tls/der';

export interface TlsTransport {
	/** Resolves with the next chunk from the network, or null once the peer has closed. */
	read(): Promise<Bytes | null>;
	write(data: Bytes): Promise<void>;
}

export interface TlsPeer {
	/** DER leaf certificate. */
	certificate: Bytes;
	/** DER SubjectPublicKeyInfo of the leaf certificate. */
	spki: Bytes;
}

export interface TlsOptions {
	serverName?: string;
	/** Decides whether the server's key is trusted; throw to abort. Runs after the handshake signature has been verified with that key. */
	verifyPeer(peer: TlsPeer): Promise<void>;
}

export interface TlsConnection {
	readonly version: 'TLSv1.2' | 'TLSv1.3';
	readonly cipherSuite: string;
	readonly peer: TlsPeer;
	read(): Promise<Bytes | null>;
	write(data: Bytes): Promise<void>;
	close(): Promise<void>;
}

const CONTENT_CHANGE_CIPHER_SPEC = 20;
const CONTENT_ALERT = 21;
const CONTENT_HANDSHAKE = 22;
const CONTENT_APPLICATION_DATA = 23;

const HS_HELLO_REQUEST = 0;
const HS_SERVER_HELLO = 2;
const HS_NEW_SESSION_TICKET = 4;
const HS_ENCRYPTED_EXTENSIONS = 8;
const HS_CERTIFICATE = 11;
const HS_SERVER_KEY_EXCHANGE = 12;
const HS_CERTIFICATE_REQUEST = 13;
const HS_SERVER_HELLO_DONE = 14;
const HS_CERTIFICATE_VERIFY = 15;
const HS_CLIENT_KEY_EXCHANGE = 16;
const HS_FINISHED = 20;
const HS_KEY_UPDATE = 24;

const EXT_SERVER_NAME = 0;
const EXT_SUPPORTED_GROUPS = 10;
const EXT_EC_POINT_FORMATS = 11;
const EXT_SIGNATURE_ALGORITHMS = 13;
const EXT_EXTENDED_MASTER_SECRET = 23;
const EXT_SUPPORTED_VERSIONS = 43;
const EXT_KEY_SHARE = 51;
const EXT_RENEGOTIATION_INFO = 0xFF_01;

const TLS12 = 0x03_03;
const TLS13 = 0x03_04;
const MAX_PLAINTEXT = 16384;
const MAX_CIPHERTEXT = MAX_PLAINTEXT + 256;
const RECORD_HEADER = 5;
const GCM_TAG = 16;
const TLS12_EXPLICIT_NONCE = 8;

// SHA-256("HelloRetryRequest"), RFC 8446 section 4.1.3.
const HELLO_RETRY_RANDOM = new Uint8Array([0xCF, 0x21, 0xAD, 0x74, 0xE5, 0x9A, 0x61, 0x11, 0xBE, 0x1D, 0x8C, 0x02, 0x1E, 0x65, 0xB8, 0x91, 0xC2, 0xA2, 0x11, 0x16, 0x7A, 0xBB, 0x8C, 0x5E, 0x07, 0x9E, 0x09, 0xE2, 0xC8, 0xA8, 0x33, 0x9C]);
// "DOWNGRD\x01": a TLS 1.3-capable server negotiating 1.2 sets this, so seeing it means an attacker forced the downgrade.
const DOWNGRADE_SENTINEL = new Uint8Array([0x44, 0x4F, 0x57, 0x4E, 0x47, 0x52, 0x44, 0x01]);

interface CipherSuite {
	id: number;
	name: string;
	tls13: boolean;
	keyLength: 16 | 32;
	hash: HashName;
	keyExchange?: 'dhe' | 'ecdhe';
	authentication?: 'rsa' | 'ec';
}

// Only AEAD suites; DHE is included because MySQL 5.7 servers offer nothing else.
const CIPHER_SUITES: CipherSuite[] = [
	{ id: 0x13_02, name: 'TLS_AES_256_GCM_SHA384', tls13: true, keyLength: 32, hash: 'SHA-384' },
	{ id: 0x13_01, name: 'TLS_AES_128_GCM_SHA256', tls13: true, keyLength: 16, hash: 'SHA-256' },
	{ id: 0xC0_30, name: 'ECDHE-RSA-AES256-GCM-SHA384', tls13: false, keyLength: 32, hash: 'SHA-384', keyExchange: 'ecdhe', authentication: 'rsa' },
	{ id: 0xC0_2F, name: 'ECDHE-RSA-AES128-GCM-SHA256', tls13: false, keyLength: 16, hash: 'SHA-256', keyExchange: 'ecdhe', authentication: 'rsa' },
	{ id: 0xC0_2C, name: 'ECDHE-ECDSA-AES256-GCM-SHA384', tls13: false, keyLength: 32, hash: 'SHA-384', keyExchange: 'ecdhe', authentication: 'ec' },
	{ id: 0xC0_2B, name: 'ECDHE-ECDSA-AES128-GCM-SHA256', tls13: false, keyLength: 16, hash: 'SHA-256', keyExchange: 'ecdhe', authentication: 'ec' },
	{ id: 0x00_9F, name: 'DHE-RSA-AES256-GCM-SHA384', tls13: false, keyLength: 32, hash: 'SHA-384', keyExchange: 'dhe', authentication: 'rsa' },
	{ id: 0x00_9E, name: 'DHE-RSA-AES128-GCM-SHA256', tls13: false, keyLength: 16, hash: 'SHA-256', keyExchange: 'dhe', authentication: 'rsa' },
];

const KEY_SHARE_GROUPS: EcdhGroup[] = ['X25519', 'P-256'];

interface CipherState {
	tls13: boolean;
	key: CryptoKey;
	iv: Bytes;
	sequence: bigint;
}

/** Strips TLS 1.3 record padding (RFC 8446 section 5.4): the content type is the last non-zero byte. */
export const parseTls13Inner = (plaintext: Bytes): { type: number; data: Bytes; } => {
	let end = plaintext.length - 1;
	while (end >= 0 && plaintext[end] === 0) {
		end -= 1;
	}
	if (end < 0) {
		throw new TlsError('TLS record has no content type.', 10);
	}
	return { type: plaintext[end] as number, data: plaintext.subarray(0, end) };
};

/** What a TLS 1.3 post-handshake message requires; tickets are ignored because sessions are never resumed. */
export const tls13PostHandshakeAction = (type: number, body: Bytes): 'ignore' | 'update' | 'update-and-reply' => {
	if (type === HS_NEW_SESSION_TICKET) {
		return 'ignore';
	}
	if (type !== HS_KEY_UPDATE || body.length !== 1 || (body[0] as number) > 1) {
		throw new TlsError('Unexpected post-handshake message.', 10);
	}
	return body[0] === 1 ? 'update-and-reply' : 'update';
};

const sequenceBytes = (sequence: bigint): Bytes => {
	const bytes = new Uint8Array(8);
	new DataView(bytes.buffer).setBigUint64(0, sequence);
	return bytes;
};

const tls13Nonce = (iv: Bytes, sequence: bigint): Bytes => {
	const nonce = Uint8Array.from(iv);
	const counter = sequenceBytes(sequence);
	for (let index = 0; index < 8; index += 1) {
		nonce[nonce.length - 8 + index] ^= counter[index] as number;
	}
	return nonce;
};

const recordHeader = (type: number, length: number): Bytes => concat(new Uint8Array([type]), uint(TLS12, 2), uint(length, 2));

const handshakeMessage = (type: number, body: Bytes): Bytes => concat(new Uint8Array([type]), uint(body.length, 3), body);

const extension = (type: number, data: Bytes): Bytes => concat(uint(type, 2), vector(data, 2));

const isIpAddress = (host: string): boolean => /^[\d.]+$/.test(host) || host.includes(':');

/** Moves bytes between the transport and decrypted records, keeping sequence numbers and key changes in order. */
class RecordLayer {
	private pending = new Uint8Array(0);
	private readState: CipherState | undefined;
	private writeState: CipherState | undefined;
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(private readonly transport: TlsTransport) {}

	private enqueue(task: () => Promise<void>): Promise<void> {
		const run = this.writeQueue.then(task);
		// A failed write must not wedge the queue for the alert that reports it.
		this.writeQueue = run.catch(() => {});
		return run;
	}

	private async seal(type: number, data: Bytes): Promise<Bytes> {
		const state = this.writeState;
		if (!state) {
			return concat(recordHeader(type, data.length), data);
		}
		const sequence = state.sequence;
		state.sequence += 1n;
		if (state.tls13) {
			const inner = concat(data, new Uint8Array([type]));
			const header = recordHeader(CONTENT_APPLICATION_DATA, inner.length + GCM_TAG);
			return concat(header, await aesGcmEncrypt(state.key, tls13Nonce(state.iv, sequence), header, inner));
		}
		const explicitNonce = sequenceBytes(sequence);
		const aad = concat(explicitNonce, new Uint8Array([type]), uint(TLS12, 2), uint(data.length, 2));
		const sealed = await aesGcmEncrypt(state.key, concat(state.iv, explicitNonce), aad, data);
		return concat(recordHeader(type, TLS12_EXPLICIT_NONCE + sealed.length), explicitNonce, sealed);
	}

	private async nextRecord(): Promise<Bytes | null> {
		for (;;) {
			if (this.pending.length >= RECORD_HEADER) {
				const length = ((this.pending[3] as number) << 8) | (this.pending[4] as number);
				if (length > MAX_CIPHERTEXT) {
					throw new TlsError('TLS record is too large.', 22);
				}
				if (this.pending.length >= RECORD_HEADER + length) {
					const record = this.pending.slice(0, RECORD_HEADER + length);
					this.pending = this.pending.slice(RECORD_HEADER + length);
					return record;
				}
			}
			const chunk = await this.transport.read();
			if (!chunk) {
				if (this.pending.length === 0) {
					return null;
				}
				throw new TlsError('Connection closed in the middle of a TLS record.');
			}
			this.pending = concat(this.pending, chunk);
		}
	}

	setReadState(state: CipherState): void {
		this.readState = state;
	}

	/** Queued behind pending writes so earlier records keep the keys they were meant for. */
	setWriteState(state: CipherState): Promise<void> {
		return this.enqueue(async () => {
			this.writeState = state;
		});
	}

	write(type: number, data: Bytes): Promise<void> {
		return this.enqueue(async () => {
			for (let offset = 0; offset === 0 || offset < data.length; offset += MAX_PLAINTEXT) {
				await this.transport.write(await this.seal(type, data.subarray(offset, offset + MAX_PLAINTEXT)));
			}
		});
	}

	async read(): Promise<{ type: number; data: Bytes; } | null> {
		const record = await this.nextRecord();
		if (!record) {
			return null;
		}
		const header = record.subarray(0, RECORD_HEADER);
		const type = header[0] as number;
		const body = record.subarray(RECORD_HEADER);
		const state = this.readState;
		// TLS 1.3 servers may send a plaintext dummy ChangeCipherSpec for middlebox compatibility.
		if (!state || (state.tls13 && type === CONTENT_CHANGE_CIPHER_SPEC)) {
			return { type, data: body };
		}
		if (state.tls13) {
			if (type !== CONTENT_APPLICATION_DATA) {
				throw new TlsError('Unexpected unencrypted TLS record.', 10);
			}
			const plaintext = await aesGcmDecrypt(state.key, tls13Nonce(state.iv, state.sequence), header, body);
			state.sequence += 1n;
			return parseTls13Inner(plaintext);
		}
		if (body.length < TLS12_EXPLICIT_NONCE + GCM_TAG) {
			throw new TlsError('TLS record is too short.', 50);
		}
		const nonce = concat(state.iv, body.subarray(0, TLS12_EXPLICIT_NONCE));
		const aad = concat(sequenceBytes(state.sequence), new Uint8Array([type]), uint(TLS12, 2), uint(body.length - TLS12_EXPLICIT_NONCE - GCM_TAG, 2));
		const data = await aesGcmDecrypt(state.key, nonce, aad, body.subarray(TLS12_EXPLICIT_NONCE));
		state.sequence += 1n;
		return { type, data };
	}
}

interface HandshakeMessage {
	type: number;
	body: Bytes;
	raw: Bytes;
}

/** Maps an alert record to an error; close_notify (0) is an orderly end of stream and maps to null. */
export const alertError = (data: Bytes): TlsError | null => {
	const description = data[1];
	if (description === 0) {
		return null;
	}
	return new TlsError(`The server sent TLS alert ${description ?? 'unknown'}.`, description);
};

const parseExtensions = (reader: ByteReader): Map<number, Bytes> => {
	const extensions = new Map<number, Bytes>();
	if (reader.remaining === 0) {
		return extensions;
	}
	const list = new ByteReader(reader.vector(2));
	while (list.remaining > 0) {
		const type = list.uint(2);
		if (extensions.has(type)) {
			throw new TlsError('Duplicate TLS extension.', 47);
		}
		extensions.set(type, list.vector(2));
	}
	return extensions;
};

const requireType = (message: HandshakeMessage, type: number): void => {
	if (message.type !== type) {
		throw new TlsError(`Unexpected TLS handshake message ${message.type}.`, 10);
	}
};

/** Finished proves both sides saw the same handshake; only a server holding the session keys can produce it. */
export const assertFinished = (received: Bytes, expected: Bytes): void => {
	if (!equalBytes(received, expected)) {
		throw new TlsError('Server Finished verification failed.', 51);
	}
};

interface ServerHello {
	random: Bytes;
	sessionId: Bytes;
	suite: CipherSuite;
	tls13: boolean;
	extensions: Map<number, Bytes>;
}

class Handshake {
	private handshakeBuffer = new Uint8Array(0);
	private readonly transcript: Bytes[] = [];
	private readonly clientRandom = crypto.getRandomValues(new Uint8Array(32));
	private readonly sessionId = crypto.getRandomValues(new Uint8Array(32));
	// Only TLS 1.3 servers send dummy ChangeCipherSpec records; in TLS 1.2 an unexpected one is fatal.
	private ignoreChangeCipherSpec = false;

	constructor(private readonly records: RecordLayer, private readonly options: TlsOptions) {}

	private clientHello(shares: EcdhShare[]): Bytes {
		const extensions = [
			extension(EXT_SUPPORTED_VERSIONS, vector(concat(uint(TLS13, 2), uint(TLS12, 2)), 1)),
			extension(EXT_SUPPORTED_GROUPS, vector(concat(...(['X25519', 'P-256', 'P-384'] as const).map(group => uint(NAMED_GROUPS[group], 2))), 2)),
			extension(EXT_KEY_SHARE, vector(concat(...shares.map(share => concat(uint(NAMED_GROUPS[share.group], 2), vector(share.publicKey, 2)))), 2)),
			extension(EXT_SIGNATURE_ALGORITHMS, vector(concat(...Object.values(SIGNATURE_SCHEMES).map(scheme => uint(scheme, 2))), 2)),
			extension(EXT_EC_POINT_FORMATS, vector(new Uint8Array([0]), 1)),
			extension(EXT_EXTENDED_MASTER_SECRET, new Uint8Array(0)),
			extension(EXT_RENEGOTIATION_INFO, new Uint8Array([0])),
		];
		const serverName = this.options.serverName;
		if (serverName && !isIpAddress(serverName)) {
			extensions.unshift(extension(EXT_SERVER_NAME, vector(concat(new Uint8Array([0]), vector(ascii(serverName), 2)), 2)));
		}
		const body = concat(
			uint(TLS12, 2),
			this.clientRandom,
			vector(this.sessionId, 1),
			vector(concat(...CIPHER_SUITES.map(suite => uint(suite.id, 2))), 2),
			vector(new Uint8Array([0]), 1),
			vector(concat(...extensions), 2),
		);
		return handshakeMessage(1, body);
	}

	private parseServerHello(message: HandshakeMessage): ServerHello {
		const reader = new ByteReader(message.body);
		const legacyVersion = reader.uint(2);
		const random = reader.read(32);
		const sessionId = reader.vector(1);
		const suiteId = reader.uint(2);
		const compression = reader.uint(1);
		const extensions = parseExtensions(reader);
		reader.end();
		if (equalBytes(random, HELLO_RETRY_RANDOM)) {
			throw new TlsError('The server requested a key share this client does not offer.', 40);
		}
		const suite = CIPHER_SUITES.find(candidate => candidate.id === suiteId);
		const versionExtension = extensions.get(EXT_SUPPORTED_VERSIONS);
		const tls13 = versionExtension !== undefined && new ByteReader(versionExtension).uint(2) === TLS13;
		if (!suite || compression !== 0 || legacyVersion !== TLS12 || suite.tls13 !== tls13) {
			throw new TlsError('The server chose TLS parameters this client did not offer.', 47);
		}
		if (versionExtension !== undefined && !tls13) {
			throw new TlsError('The server chose an unsupported TLS version.', 70);
		}
		return { random, sessionId, suite, tls13, extensions };
	}

	private async runTls13(hello: ServerHello, shares: EcdhShare[]): Promise<TlsConnection> {
		const { suite } = hello;
		if (!equalBytes(hello.sessionId, this.sessionId)) {
			throw new TlsError('The server did not echo the session ID.', 47);
		}
		const hash = suite.hash;
		const length = hashLength(hash);
		this.ignoreChangeCipherSpec = true;
		const keyShare = new ByteReader(hello.extensions.get(EXT_KEY_SHARE) ?? new Uint8Array(0));
		const groupId = keyShare.uint(2);
		const serverPublic = keyShare.vector(2);
		keyShare.end();
		const share = shares.find(candidate => NAMED_GROUPS[candidate.group] === groupId);
		if (!share) {
			throw new TlsError('The server chose a key share this client did not offer.', 47);
		}
		const sharedSecret = await ecdhSharedSecret(share, serverPublic);

		const zeros = new Uint8Array(length);
		const emptyHash = await digest(hash, new Uint8Array(0));
		const earlySecret = await hkdfExtract(hash, new Uint8Array(0), zeros);
		const handshakeSecret = await hkdfExtract(hash, await expandLabel(hash, earlySecret, 'derived', emptyHash, length), sharedSecret);
		const helloHash = await this.transcriptHash(hash);
		const clientHandshakeSecret = await expandLabel(hash, handshakeSecret, 'c hs traffic', helloHash, length);
		const serverHandshakeSecret = await expandLabel(hash, handshakeSecret, 's hs traffic', helloHash, length);
		this.assertMessageBoundary();
		this.records.setReadState(await this.tls13State(suite, serverHandshakeSecret));

		await this.expect(HS_ENCRYPTED_EXTENSIONS);
		let certificateMessage = await this.next();
		let certificateRequestContext: Bytes | undefined;
		if (certificateMessage.type === HS_CERTIFICATE_REQUEST) {
			certificateRequestContext = new ByteReader(certificateMessage.body).vector(1);
			certificateMessage = await this.next();
		}
		requireType(certificateMessage, HS_CERTIFICATE);
		const certificates = new ByteReader(certificateMessage.body);
		certificates.vector(1);
		const leaf = new ByteReader(certificates.vector(3)).vector(3);
		const peer = { certificate: leaf, spki: certificateSpki(leaf) };

		const contentHash = await this.transcriptHash(hash);
		const certificateVerify = await this.expect(HS_CERTIFICATE_VERIFY);
		const verify = new ByteReader(certificateVerify.body);
		const scheme = verify.uint(2);
		const signature = verify.vector(2);
		verify.end();
		const signedContent = concat(new Uint8Array(64).fill(0x20), ascii('TLS 1.3, server CertificateVerify'), new Uint8Array([0]), contentHash);
		await verifySignature(peer.spki, scheme, signature, signedContent, false);
		await this.options.verifyPeer(peer);

		const finishedHash = await this.transcriptHash(hash);
		const serverFinished = await this.expect(HS_FINISHED);
		const expectedFinished = await hmac(hash, await expandLabel(hash, serverHandshakeSecret, 'finished', new Uint8Array(0), length), finishedHash);
		assertFinished(serverFinished.body, expectedFinished);
		this.assertMessageBoundary();

		const masterSecret = await hkdfExtract(hash, await expandLabel(hash, handshakeSecret, 'derived', emptyHash, length), zeros);
		const applicationHash = await this.transcriptHash(hash);
		let clientApplicationSecret = await expandLabel(hash, masterSecret, 'c ap traffic', applicationHash, length);
		let serverApplicationSecret = await expandLabel(hash, masterSecret, 's ap traffic', applicationHash, length);
		this.records.setReadState(await this.tls13State(suite, serverApplicationSecret));

		await this.records.write(CONTENT_CHANGE_CIPHER_SPEC, new Uint8Array([1]));
		await this.records.setWriteState(await this.tls13State(suite, clientHandshakeSecret));
		if (certificateRequestContext) {
			// No client certificate: an empty list lets servers that only request one continue.
			await this.send(handshakeMessage(HS_CERTIFICATE, concat(vector(certificateRequestContext, 1), uint(0, 3))));
		}
		const clientFinished = await hmac(hash, await expandLabel(hash, clientHandshakeSecret, 'finished', new Uint8Array(0), length), await this.transcriptHash(hash));
		await this.send(handshakeMessage(HS_FINISHED, clientFinished));
		await this.records.setWriteState(await this.tls13State(suite, clientApplicationSecret));

		// Only the single read loop calls this, so the secret cannot change underneath it.
		const updateReadKeys = async (): Promise<void> => {
			const nextSecret = await expandLabel(hash, serverApplicationSecret, 'traffic upd', new Uint8Array(0), length);
			// eslint-disable-next-line require-atomic-updates -- reads are sequential; see above.
			serverApplicationSecret = nextSecret;
			this.records.setReadState(await this.tls13State(suite, nextSecret));
		};
		const updateWriteKeys = async (): Promise<void> => {
			const nextSecret = await expandLabel(hash, clientApplicationSecret, 'traffic upd', new Uint8Array(0), length);
			const nextState = await this.tls13State(suite, nextSecret);
			// eslint-disable-next-line require-atomic-updates -- updates only run from the sequential read loop.
			clientApplicationSecret = nextSecret;
			// Queued together so no application write can slip between KeyUpdate and the switch to the new key.
			const sent = this.records.write(CONTENT_HANDSHAKE, handshakeMessage(HS_KEY_UPDATE, new Uint8Array([0])));
			const switched = this.records.setWriteState(nextState);
			await Promise.all([sent, switched]);
		};
		return this.connection('TLSv1.3', suite, peer, async (message) => {
			const action = tls13PostHandshakeAction(message.type, message.body);
			if (action === 'ignore') {
				return;
			}
			this.assertMessageBoundary();
			await updateReadKeys();
			if (action === 'update-and-reply') {
				await updateWriteKeys();
			}
		});
	}

	private async runTls12(hello: ServerHello): Promise<TlsConnection> {
		if (equalBytes(hello.random.subarray(24), DOWNGRADE_SENTINEL)) {
			throw new TlsError('TLS downgrade detected.', 47);
		}
		const { suite } = hello;
		const hash = suite.hash;
		const extendedMasterSecret = hello.extensions.has(EXT_EXTENDED_MASTER_SECRET);

		const certificateMessage = await this.expect(HS_CERTIFICATE);
		const certificates = new ByteReader(certificateMessage.body);
		const leaf = new ByteReader(certificates.vector(3)).vector(3);
		const peer = { certificate: leaf, spki: certificateSpki(leaf) };
		if (spkiKeyType(peer.spki).kind !== suite.authentication) {
			throw new TlsError('Certificate key does not match the cipher suite.', 42);
		}

		const keyExchange = await this.expect(HS_SERVER_KEY_EXCHANGE);
		const params = new ByteReader(keyExchange.body);
		let clientKeyExchange: Bytes;
		let premasterSecret: Bytes;
		let signedParams: Bytes;
		if (suite.keyExchange === 'dhe') {
			const prime = params.vector(2);
			const generator = params.vector(2);
			const serverPublic = params.vector(2);
			signedParams = keyExchange.body.subarray(0, keyExchange.body.length - params.remaining);
			const agreement = dheAgree(prime, generator, serverPublic);
			clientKeyExchange = vector(agreement.publicKey, 2);
			premasterSecret = agreement.sharedSecret;
		} else {
			const curveType = params.uint(1);
			const groupId = params.uint(2);
			const serverPublic = params.vector(1);
			signedParams = keyExchange.body.subarray(0, keyExchange.body.length - params.remaining);
			const group = (Object.keys(NAMED_GROUPS) as EcdhGroup[]).find(candidate => NAMED_GROUPS[candidate] === groupId);
			if (curveType !== 3 || !group) {
				throw new TlsError('The server chose an unsupported ECDHE group.', 47);
			}
			const share = await generateEcdhShare(group);
			premasterSecret = await ecdhSharedSecret(share, serverPublic);
			clientKeyExchange = vector(share.publicKey, 1);
		}
		const scheme = params.uint(2);
		const signature = params.vector(2);
		params.end();
		await verifySignature(peer.spki, scheme, signature, concat(this.clientRandom, hello.random, signedParams), true);
		await this.options.verifyPeer(peer);

		let doneOrRequest = await this.next();
		const certificateRequested = doneOrRequest.type === HS_CERTIFICATE_REQUEST;
		if (certificateRequested) {
			doneOrRequest = await this.next();
		}
		requireType(doneOrRequest, HS_SERVER_HELLO_DONE);
		if (doneOrRequest.body.length > 0) {
			throw new TlsError('Malformed ServerHelloDone.', 50);
		}
		this.assertMessageBoundary();

		if (certificateRequested) {
			await this.send(handshakeMessage(HS_CERTIFICATE, uint(0, 3)));
		}
		await this.send(handshakeMessage(HS_CLIENT_KEY_EXCHANGE, clientKeyExchange));
		const masterSecret = extendedMasterSecret
			? await prf(hash, premasterSecret, 'extended master secret', await this.transcriptHash(hash), 48)
			: await prf(hash, premasterSecret, 'master secret', concat(this.clientRandom, hello.random), 48);
		const keyBlock = await prf(hash, masterSecret, 'key expansion', concat(hello.random, this.clientRandom), (suite.keyLength * 2) + 8);
		const clientKey = keyBlock.subarray(0, suite.keyLength);
		const serverKey = keyBlock.subarray(suite.keyLength, suite.keyLength * 2);
		const clientIv = keyBlock.subarray(suite.keyLength * 2, (suite.keyLength * 2) + 4);
		const serverIv = keyBlock.subarray((suite.keyLength * 2) + 4);

		await this.records.write(CONTENT_CHANGE_CIPHER_SPEC, new Uint8Array([1]));
		await this.records.setWriteState({ tls13: false, key: await importAesKey(clientKey), iv: clientIv, sequence: 0n });
		await this.send(handshakeMessage(HS_FINISHED, await prf(hash, masterSecret, 'client finished', await this.transcriptHash(hash), 12)));

		const changeCipherSpec = await this.records.read();
		if (changeCipherSpec?.type === CONTENT_ALERT) {
			throw alertError(changeCipherSpec.data) ?? new TlsError('The server closed the TLS handshake.');
		}
		if (changeCipherSpec?.type !== CONTENT_CHANGE_CIPHER_SPEC || !equalBytes(changeCipherSpec.data, new Uint8Array([1]))) {
			throw new TlsError('Expected ChangeCipherSpec.', 10);
		}
		this.records.setReadState({ tls13: false, key: await importAesKey(serverKey), iv: serverIv, sequence: 0n });
		const expectedFinished = await prf(hash, masterSecret, 'server finished', await this.transcriptHash(hash), 12);
		const serverFinished = await this.expect(HS_FINISHED);
		assertFinished(serverFinished.body, expectedFinished);

		return this.connection('TLSv1.2', suite, peer, async (message) => {
			// Renegotiation is not supported; HelloRequest may be ignored per RFC 5246 section 7.4.1.1.
			if (message.type !== HS_HELLO_REQUEST) {
				throw new TlsError('Unexpected post-handshake message.', 10);
			}
		});
	}

	private connection(version: TlsConnection['version'], suite: CipherSuite, peer: TlsPeer, onHandshake: (message: HandshakeMessage) => Promise<void>): TlsConnection {
		const { records } = this;
		let closed = false;
		const nextApplicationData = async (): Promise<Bytes | null> => {
			for (;;) {
				const record = await records.read();
				if (!record) {
					return null;
				}
				if (record.type === CONTENT_APPLICATION_DATA) {
					if (record.data.length > 0) {
						return record.data;
					}
				} else if (record.type === CONTENT_ALERT) {
					const error = alertError(record.data);
					if (error) {
						throw error;
					}
					return null;
				} else if (record.type === CONTENT_HANDSHAKE) {
					this.handshakeBuffer = concat(this.handshakeBuffer, record.data);
					for (let message = this.bufferedMessage(); message; message = this.bufferedMessage()) {
						await onHandshake(message);
					}
				} else {
					throw new TlsError('Unexpected TLS record type.', 10);
				}
			}
		};
		return {
			version,
			cipherSuite: suite.name,
			peer,
			read: async () => {
				if (closed) {
					return null;
				}
				const data = await nextApplicationData();
				if (data === null) {
					// eslint-disable-next-line require-atomic-updates -- there is a single reader; a concurrent close() also only sets true.
					closed = true;
				}
				return data;
			},
			write: data => records.write(CONTENT_APPLICATION_DATA, data),
			close: async () => {
				if (closed) {
					return;
				}
				closed = true;
				await records.write(CONTENT_ALERT, new Uint8Array([1, 0])).catch(() => {});
			},
		};
	}

	private async tls13State(suite: CipherSuite, secret: Bytes): Promise<CipherState> {
		const key = await expandLabel(suite.hash, secret, 'key', new Uint8Array(0), suite.keyLength);
		const iv = await expandLabel(suite.hash, secret, 'iv', new Uint8Array(0), 12);
		return { tls13: true, key: await importAesKey(key), iv, sequence: 0n };
	}

	private async send(message: Bytes): Promise<void> {
		this.transcript.push(message);
		await this.records.write(CONTENT_HANDSHAKE, message);
	}

	private transcriptHash(hash: HashName): Promise<Bytes> {
		return digest(hash, concat(...this.transcript));
	}

	/** Key changes must fall on record boundaries; leftover handshake bytes would be read under the wrong key. */
	private assertMessageBoundary(): void {
		if (this.handshakeBuffer.length > 0) {
			throw new TlsError('Handshake message crosses a key change.', 10);
		}
	}

	private bufferedMessage(): HandshakeMessage | null {
		if (this.handshakeBuffer.length < 4) {
			return null;
		}
		const length = new ByteReader(this.handshakeBuffer.subarray(1, 4)).uint(3);
		if (this.handshakeBuffer.length < 4 + length) {
			return null;
		}
		const raw = this.handshakeBuffer.slice(0, 4 + length);
		this.handshakeBuffer = this.handshakeBuffer.slice(4 + length);
		return { type: raw[0] as number, body: raw.subarray(4), raw };
	}

	private async next(): Promise<HandshakeMessage> {
		for (;;) {
			const message = this.bufferedMessage();
			if (message) {
				this.transcript.push(message.raw);
				return message;
			}
			const record = await this.records.read();
			if (!record) {
				throw new TlsError('The server closed the connection during the TLS handshake.');
			}
			if (record.type === CONTENT_ALERT) {
				throw alertError(record.data) ?? new TlsError('The server closed the TLS handshake.');
			}
			if (this.ignoreChangeCipherSpec && record.type === CONTENT_CHANGE_CIPHER_SPEC && equalBytes(record.data, new Uint8Array([1]))) {
				continue;
			}
			if (record.type !== CONTENT_HANDSHAKE) {
				throw new TlsError('Unexpected TLS record during the handshake.', 10);
			}
			this.handshakeBuffer = concat(this.handshakeBuffer, record.data);
		}
	}

	private async expect(type: number): Promise<HandshakeMessage> {
		const message = await this.next();
		requireType(message, type);
		return message;
	}

	async run(): Promise<TlsConnection> {
		const shares = await Promise.all(KEY_SHARE_GROUPS.map(group => generateEcdhShare(group)));
		await this.send(this.clientHello(shares));
		const serverHello = this.parseServerHello(await this.expect(HS_SERVER_HELLO));
		if (serverHello.tls13) {
			return this.runTls13(serverHello, shares);
		}
		return this.runTls12(serverHello);
	}
}

/** Runs a TLS 1.3 or 1.2 client handshake over an already-connected transport. */
export const connectTls = async (transport: TlsTransport, options: TlsOptions): Promise<TlsConnection> => {
	const records = new RecordLayer(transport);
	try {
		return await new Handshake(records, options).run();
	} catch (error) {
		const alert = error instanceof TlsError ? error.alert : 80;
		// Best effort: tell the server why before giving up; the original error is what callers need.
		await records.write(CONTENT_ALERT, new Uint8Array([2, alert])).catch(() => {});
		throw error;
	}
};

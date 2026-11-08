import {
	type Bytes,
	TlsError,
	ascii,
	concat,
	uint,
	vector,
} from '~/lib/tls/bytes';
import { ecdsaSignatureToRaw, spkiKeyType } from '~/lib/tls/der';

export type HashName = 'SHA-256' | 'SHA-384';

export const hashLength = (hash: HashName): number => (hash === 'SHA-256' ? 32 : 48);

export const digest = async (hash: HashName | 'SHA-512', data: Bytes): Promise<Bytes> => new Uint8Array(await crypto.subtle.digest(hash, data));

export const hmac = async (hash: HashName, key: Bytes, data: Bytes): Promise<Bytes> => {
	const imported = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash }, false, ['sign']);
	return new Uint8Array(await crypto.subtle.sign('HMAC', imported, data));
};

export const hkdfExtract = (hash: HashName, salt: Bytes, ikm: Bytes): Promise<Bytes> => hmac(hash, salt.length > 0 ? salt : new Uint8Array(hashLength(hash)), ikm);

export const hkdfExpand = async (hash: HashName, prk: Bytes, info: Bytes, length: number): Promise<Bytes> => {
	const blocks: Bytes[] = [];
	let previous = new Uint8Array(0);
	for (let counter = 1; blocks.length * hashLength(hash) < length; counter += 1) {
		previous = await hmac(hash, prk, concat(previous, info, new Uint8Array([counter])));
		blocks.push(previous);
	}
	return concat(...blocks).subarray(0, length);
};

/** RFC 8446 section 7.1 HKDF-Expand-Label. */
export const expandLabel = (hash: HashName, secret: Bytes, label: string, context: Bytes, length: number): Promise<Bytes> => {
	const info = concat(uint(length, 2), vector(ascii(`tls13 ${label}`), 1), vector(context, 1));
	return hkdfExpand(hash, secret, info, length);
};

/** RFC 5246 section 5 PRF with P_SHA256 or P_SHA384. */
export const prf = async (hash: HashName, secret: Bytes, label: string, seed: Bytes, length: number): Promise<Bytes> => {
	const labelSeed = concat(ascii(label), seed);
	const blocks: Bytes[] = [];
	// A(i) in RFC 5246's P_hash definition.
	let chain = labelSeed;
	while (blocks.length * hashLength(hash) < length) {
		chain = await hmac(hash, secret, chain);
		blocks.push(await hmac(hash, secret, concat(chain, labelSeed)));
	}
	return concat(...blocks).subarray(0, length);
};

export const importAesKey = (key: Bytes): Promise<CryptoKey> => crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt', 'decrypt']);

export const aesGcmEncrypt = async (key: CryptoKey, iv: Bytes, aad: Bytes, plaintext: Bytes): Promise<Bytes> => new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, plaintext));

export const aesGcmDecrypt = async (key: CryptoKey, iv: Bytes, aad: Bytes, ciphertext: Bytes): Promise<Bytes> => {
	try {
		return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, ciphertext));
	} catch {
		throw new TlsError('TLS record authentication failed.', 20);
	}
};

// TLS SignatureScheme code points (RFC 8446 section 4.2.3) this client accepts.
export const SIGNATURE_SCHEMES = {
	rsaPssSha256: 0x08_04,
	rsaPssSha384: 0x08_05,
	rsaPssSha512: 0x08_06,
	ecdsaP256Sha256: 0x04_03,
	ecdsaP384Sha384: 0x05_03,
	rsaPkcs1Sha256: 0x04_01,
	rsaPkcs1Sha384: 0x05_01,
	rsaPkcs1Sha512: 0x06_01,
} as const;

interface SchemeDetails {
	family: 'rsa-pss' | 'rsa-pkcs1' | 'ecdsa';
	hash: 'SHA-256' | 'SHA-384' | 'SHA-512';
}

const schemeDetails = new Map<number, SchemeDetails>([
	[SIGNATURE_SCHEMES.rsaPssSha256, { family: 'rsa-pss', hash: 'SHA-256' }],
	[SIGNATURE_SCHEMES.rsaPssSha384, { family: 'rsa-pss', hash: 'SHA-384' }],
	[SIGNATURE_SCHEMES.rsaPssSha512, { family: 'rsa-pss', hash: 'SHA-512' }],
	[SIGNATURE_SCHEMES.ecdsaP256Sha256, { family: 'ecdsa', hash: 'SHA-256' }],
	[SIGNATURE_SCHEMES.ecdsaP384Sha384, { family: 'ecdsa', hash: 'SHA-384' }],
	[SIGNATURE_SCHEMES.rsaPkcs1Sha256, { family: 'rsa-pkcs1', hash: 'SHA-256' }],
	[SIGNATURE_SCHEMES.rsaPkcs1Sha384, { family: 'rsa-pkcs1', hash: 'SHA-384' }],
	[SIGNATURE_SCHEMES.rsaPkcs1Sha512, { family: 'rsa-pkcs1', hash: 'SHA-512' }],
]);

const hashOutputLength = { 'SHA-256': 32, 'SHA-384': 48, 'SHA-512': 64 } as const;

/**
 * Verifies a handshake signature with the certificate's key.
 * This is what binds the certificate (pinned or proof-checked) to this connection, so a replayed certificate without its key fails here.
 */
export const verifySignature = async (spki: Bytes, scheme: number, signature: Bytes, data: Bytes, allowPkcs1: boolean): Promise<void> => {
	const details = schemeDetails.get(scheme);
	if (!details || (details.family === 'rsa-pkcs1' && !allowPkcs1)) { throw new TlsError('Unsupported signature scheme.', 47); }
	const keyType = spkiKeyType(spki);
	let valid: boolean;
	if (details.family === 'ecdsa') {
		const expectedCurve = details.hash === 'SHA-256' ? 'P-256' : 'P-384';
		if (keyType.kind !== 'ec' || keyType.curve !== expectedCurve) { throw new TlsError('Signature scheme does not match the certificate key.', 47); }
		const key = await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: keyType.curve }, false, ['verify']);
		valid = await crypto.subtle.verify({ name: 'ECDSA', hash: details.hash }, key, ecdsaSignatureToRaw(signature, keyType.size), data);
	} else {
		if (keyType.kind !== 'rsa') { throw new TlsError('Signature scheme does not match the certificate key.', 47); }
		const name = details.family === 'rsa-pss' ? 'RSA-PSS' : 'RSASSA-PKCS1-v1_5';
		const key = await crypto.subtle.importKey('spki', spki, { name, hash: details.hash }, false, ['verify']);
		valid = await crypto.subtle.verify({ name, saltLength: hashOutputLength[details.hash] }, key, signature, data);
	}
	if (!valid) { throw new TlsError('Server handshake signature is invalid.', 51); }
};

export type EcdhGroup = 'X25519' | 'P-256' | 'P-384';

export const NAMED_GROUPS: Record<EcdhGroup, number> = { 'X25519': 0x00_1D, 'P-256': 0x00_17, 'P-384': 0x00_18 };

export interface EcdhShare {
	group: EcdhGroup;
	publicKey: Bytes;
	privateKey: CryptoKey;
}

const ecdhAlgorithm = (group: EcdhGroup): EcKeyImportParams | Algorithm => (group === 'X25519' ? { name: 'X25519' } : { name: 'ECDH', namedCurve: group });

export const generateEcdhShare = async (group: EcdhGroup): Promise<EcdhShare> => {
	const pair = await crypto.subtle.generateKey(ecdhAlgorithm(group), false, ['deriveBits']) as CryptoKeyPair;
	return { group, privateKey: pair.privateKey, publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)) };
};

export const ecdhSharedSecret = async (share: EcdhShare, peerPublicKey: Bytes): Promise<Bytes> => {
	let peer: CryptoKey;
	try {
		peer = await crypto.subtle.importKey('raw', peerPublicKey, ecdhAlgorithm(share.group), false, []);
	} catch {
		throw new TlsError('Invalid server key share.', 47);
	}
	const bits = { 'X25519': 256, 'P-256': 256, 'P-384': 384 }[share.group];
	try {
		return new Uint8Array(await crypto.subtle.deriveBits({ name: share.group === 'X25519' ? 'X25519' : 'ECDH', public: peer }, share.privateKey, bits));
	} catch {
		// X25519 rejects low-order points with an all-zero result.
		throw new TlsError('Invalid server key share.', 47);
	}
};

const bytesToBigInt = (bytes: Bytes): bigint => bytes.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);

const bigIntToBytes = (value: bigint): Bytes => {
	const bytes: number[] = [];
	for (let remaining = value; remaining > 0n; remaining >>= 8n) {
		bytes.unshift(Number(remaining & 0xFFn));
	}
	return new Uint8Array(bytes);
};

const modPow = (base: bigint, exponent: bigint, modulus: bigint): bigint => {
	let result = 1n;
	let factor = base % modulus;
	for (let remaining = exponent; remaining > 0n; remaining >>= 1n) {
		if (remaining & 1n) {
			result = (result * factor) % modulus;
		}
		factor = (factor * factor) % modulus;
	}
	return result;
};

// Below 2048 bits finite-field DH is breakable (Logjam), so smaller groups are refused outright.
const MIN_DH_PRIME_BITS = 2048;
// A 384-bit exponent exceeds the 2x security-level guidance for 2048-4096-bit groups while keeping BigInt exponentiation fast.
const DH_EXPONENT_BYTES = 48;

export interface DheResult {
	publicKey: Bytes;
	sharedSecret: Bytes;
}

/** TLS 1.2 finite-field Diffie-Hellman with server-supplied parameters (MySQL 5.7 offers only DHE). */
export const dheAgree = (prime: Bytes, generator: Bytes, serverPublic: Bytes): DheResult => {
	const modulus = bytesToBigInt(prime);
	if (modulus.toString(2).length < MIN_DH_PRIME_BITS || (modulus & 1n) === 0n) { throw new TlsError('Server Diffie-Hellman group is too weak.', 71); }
	const base = bytesToBigInt(generator);
	const serverValue = bytesToBigInt(serverPublic);
	if (base <= 1n || base >= modulus - 1n || serverValue <= 1n || serverValue >= modulus - 1n) { throw new TlsError('Invalid server Diffie-Hellman parameters.', 47); }
	const exponent = bytesToBigInt(crypto.getRandomValues(new Uint8Array(DH_EXPONENT_BYTES))) | (1n << BigInt((DH_EXPONENT_BYTES * 8) - 1));
	// RFC 5246 8.1.2: the premaster secret is Z with leading zero bytes stripped, which bigIntToBytes already does.
	return { publicKey: bigIntToBytes(modPow(base, exponent, modulus)), sharedSecret: bigIntToBytes(modPow(serverValue, exponent, modulus)) };
};

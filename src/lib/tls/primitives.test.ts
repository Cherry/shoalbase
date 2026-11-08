// @vitest-environment node
import {
	type KeyObject,
	X509Certificate,
	createDiffieHellman,
	createPrivateKey,
	createPublicKey,
	diffieHellman,
	generateKeyPairSync,
	getDiffieHellman,
	sign,
} from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { Bytes } from '~/lib/tls/bytes';

import {
	ByteReader,
	TlsError,
	concat,
	equalBytes,
	uint,
	vector,
} from '~/lib/tls/bytes';
import {
	type EcdhGroup,
	SIGNATURE_SCHEMES,
	aesGcmDecrypt,
	aesGcmEncrypt,
	dheAgree,
	ecdhSharedSecret,
	expandLabel,
	generateEcdhShare,
	hkdfExpand,
	hkdfExtract,
	importAesKey,
	verifySignature,
} from '~/lib/tls/crypto';
import { certificateSpki, ecdsaSignatureToRaw, spkiKeyType } from '~/lib/tls/der';
import {
	ec256Certificate,
	ec256Key,
	ec384Certificate,
	ec384Key,
	rsaCertificate,
	rsaKey,
} from '~/lib/tls/test-fixtures';

const fromHex = (hex: string): Bytes => new Uint8Array((hex.match(/../g) ?? []).map(byte => Number.parseInt(byte, 16)));
const toHex = (bytes: Bytes): string => Buffer.from(bytes).toString('hex');
const spkiOf = (pem: string): Bytes => new Uint8Array(new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' }));
const derOf = (pem: string): Bytes => new Uint8Array(new X509Certificate(pem).raw);
const der = (tag: number, ...content: Bytes[]): Bytes => {
	const body = concat(...content);
	return concat(new Uint8Array([tag, body.length]), body);
};

describe('byte helpers', () => {
	it('encodes integers and length-prefixed vectors big-endian', () => {
		expect(uint(0x01_02_03, 3)).toEqual(new Uint8Array([1, 2, 3]));
		expect(vector(new Uint8Array([9, 9]), 2)).toEqual(new Uint8Array([0, 2, 9, 9]));
		expect(equalBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
		expect(equalBytes(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
		expect(equalBytes(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
	});

	it('treats any overrun or trailing byte as a decode error', () => {
		const reader = new ByteReader(new Uint8Array([0, 2, 7, 8, 5]));
		expect(reader.vector(2)).toEqual(new Uint8Array([7, 8]));
		expect(() => reader.end()).toThrow(TlsError);
		expect(() => reader.read(2)).toThrow('Malformed TLS message.');
		expect(reader.uint(1)).toBe(5);
		expect(() => reader.end()).not.toThrow();
	});
});

describe('DER certificate parsing', () => {
	it('extracts the SubjectPublicKeyInfo from v3 certificates', () => {
		for (const pem of [rsaCertificate, ec256Certificate, ec384Certificate]) {
			expect(certificateSpki(derOf(pem))).toEqual(spkiOf(pem));
		}
	});

	it('handles v1 certificates, which have no version field', () => {
		const spki = spkiOf(ec256Certificate);
		const empty = der(0x30);
		const tbs = concat(der(0x02, new Uint8Array([1])), empty, empty, empty, empty, spki);
		const certificate = der(0x30, der(0x30, tbs), empty, der(0x03, new Uint8Array([0])));
		expect(certificateSpki(certificate)).toEqual(spki);
	});

	it('rejects malformed structures', () => {
		const empty = der(0x30);
		for (const bytes of [
			new Uint8Array(0),
			new Uint8Array([0x30]),
			new Uint8Array([0x30, 0x80]),
			new Uint8Array([0x30, 0x85, 1, 1, 1, 1, 1]),
			new Uint8Array([0x30, 0x82, 0x01]),
			new Uint8Array([0x30, 0x05, 0x02]),
			der(0x31, empty),
			der(0x30, der(0x02, new Uint8Array([1]))),
			der(0x30, der(0x30, der(0x02, new Uint8Array([1])), empty, empty, empty, empty, der(0x02, new Uint8Array([1])))),
		]) {
			expect(() => certificateSpki(bytes)).toThrow('Malformed certificate.');
		}
	});

	it('identifies RSA and NIST EC keys and refuses others', () => {
		expect(spkiKeyType(spkiOf(rsaCertificate))).toEqual({ kind: 'rsa' });
		expect(spkiKeyType(spkiOf(ec256Certificate))).toEqual({ kind: 'ec', curve: 'P-256', size: 32 });
		expect(spkiKeyType(spkiOf(ec384Certificate))).toEqual({ kind: 'ec', curve: 'P-384', size: 48 });
		const ed25519 = new Uint8Array(generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }));
		const secp256k1 = new Uint8Array(generateKeyPairSync('ec', { namedCurve: 'secp256k1' }).publicKey.export({ type: 'spki', format: 'der' }));
		expect(() => spkiKeyType(ed25519)).toThrow('Unsupported server certificate key type.');
		expect(() => spkiKeyType(secp256k1)).toThrow('Unsupported server certificate key type.');
		expect(() => spkiKeyType(der(0x30))).toThrow('Unsupported server certificate key type.');
	});

	it('converts DER ECDSA signatures to fixed-width r||s', () => {
		const integer = (...bytes: number[]): Bytes => der(0x02, new Uint8Array(bytes));
		expect(ecdsaSignatureToRaw(der(0x30, integer(0, 0x80), integer(1)), 2)).toEqual(new Uint8Array([0, 0x80, 0, 1]));
		expect(ecdsaSignatureToRaw(der(0x30, integer(0), integer(5)), 2)).toEqual(new Uint8Array([0, 0, 0, 5]));
		expect(() => ecdsaSignatureToRaw(der(0x30, integer(1, 2, 3), integer(1)), 2)).toThrow('Malformed ECDSA signature.');
		expect(() => ecdsaSignatureToRaw(der(0x30, der(0x04, new Uint8Array([1])), integer(1)), 2)).toThrow('Malformed ECDSA signature.');
		expect(() => ecdsaSignatureToRaw(der(0x31, integer(1), integer(1)), 2)).toThrow('Malformed ECDSA signature.');
		expect(() => ecdsaSignatureToRaw(der(0x30, integer(1)), 2)).toThrow('Malformed ECDSA signature.');
	});
});

describe('key derivation', () => {
	it('matches RFC 5869 test case 1', async () => {
		const prk = await hkdfExtract('SHA-256', fromHex('000102030405060708090a0b0c'), fromHex('0b'.repeat(22)));
		expect(toHex(prk)).toBe('077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5');
		expect(toHex(await hkdfExpand('SHA-256', prk, fromHex('f0f1f2f3f4f5f6f7f8f9'), 42))).toBe('3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865');
	});

	it('matches the RFC 8448 TLS 1.3 early and derived secrets', async () => {
		const early = await hkdfExtract('SHA-256', new Uint8Array(0), new Uint8Array(32));
		expect(toHex(early)).toBe('33ad0a1c607ec03b09e6cd9893680ce210adf300aa1f2660e1b22e10f170f92a');
		const emptyHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(0)));
		expect(toHex(await expandLabel('SHA-256', early, 'derived', emptyHash, 32))).toBe('6f2615a108c702c5678f54fc9dbab69716c076189c48250cebeac3576c3611ba');
	});

	it('reports tampered records as authentication failures', async () => {
		const key = await importAesKey(new Uint8Array(16));
		const iv = new Uint8Array(12);
		const sealed = await aesGcmEncrypt(key, iv, new Uint8Array([1]), new Uint8Array([42]));
		expect(await aesGcmDecrypt(key, iv, new Uint8Array([1]), sealed)).toEqual(new Uint8Array([42]));
		await expect(aesGcmDecrypt(key, iv, new Uint8Array([2]), sealed)).rejects.toThrow('TLS record authentication failed.');
	});
});

describe('handshake signatures', () => {
	const data = new TextEncoder().encode('signed handshake content');
	const rsaSpki = spkiOf(rsaCertificate);
	const rsaPrivate = createPrivateKey(rsaKey);

	it('accepts genuine RSA-PSS, RSA PKCS#1, and ECDSA signatures', async () => {
		const pss = new Uint8Array(sign('sha256', data, { key: rsaPrivate, padding: 6, saltLength: 32 }));
		await expect(verifySignature(rsaSpki, SIGNATURE_SCHEMES.rsaPssSha256, pss, data, false)).resolves.toBeUndefined();
		const pkcs1 = new Uint8Array(sign('sha384', data, rsaPrivate));
		await expect(verifySignature(rsaSpki, SIGNATURE_SCHEMES.rsaPkcs1Sha384, pkcs1, data, true)).resolves.toBeUndefined();
		const p256 = new Uint8Array(sign('sha256', data, createPrivateKey(ec256Key)));
		await expect(verifySignature(spkiOf(ec256Certificate), SIGNATURE_SCHEMES.ecdsaP256Sha256, p256, data, false)).resolves.toBeUndefined();
		const p384 = new Uint8Array(sign('sha384', data, createPrivateKey(ec384Key)));
		await expect(verifySignature(spkiOf(ec384Certificate), SIGNATURE_SCHEMES.ecdsaP384Sha384, p384, data, false)).resolves.toBeUndefined();
	});

	it('rejects forged signatures, unsupported schemes, and scheme/key mismatches', async () => {
		const pkcs1 = new Uint8Array(sign('sha256', data, rsaPrivate));
		await expect(verifySignature(rsaSpki, SIGNATURE_SCHEMES.rsaPkcs1Sha256, pkcs1, new TextEncoder().encode('other'), true)).rejects.toThrow('Server handshake signature is invalid.');
		// TLS 1.3 forbids PKCS#1 v1.5 in CertificateVerify.
		await expect(verifySignature(rsaSpki, SIGNATURE_SCHEMES.rsaPkcs1Sha256, pkcs1, data, false)).rejects.toThrow('Unsupported signature scheme.');
		await expect(verifySignature(rsaSpki, 0x02_01, pkcs1, data, true)).rejects.toThrow('Unsupported signature scheme.');
		await expect(verifySignature(rsaSpki, SIGNATURE_SCHEMES.ecdsaP256Sha256, pkcs1, data, true)).rejects.toThrow('does not match the certificate key');
		await expect(verifySignature(spkiOf(ec256Certificate), SIGNATURE_SCHEMES.ecdsaP384Sha384, pkcs1, data, true)).rejects.toThrow('does not match the certificate key');
		await expect(verifySignature(spkiOf(ec256Certificate), SIGNATURE_SCHEMES.rsaPssSha512, pkcs1, data, true)).rejects.toThrow('does not match the certificate key');
	});
});

describe('key agreement', () => {
	it('agrees on ECDHE secrets with an independent implementation', async () => {
		const toRaw = async (key: KeyObject, group: EcdhGroup): Promise<Bytes> => {
			if (group === 'X25519') { return new Uint8Array(Buffer.from(key.export({ format: 'jwk' }).x as string, 'base64url')); }
			const imported = await crypto.subtle.importKey('spki', key.export({ type: 'spki', format: 'der' }), { name: 'ECDH', namedCurve: group }, true, []);
			return new Uint8Array(await crypto.subtle.exportKey('raw', imported));
		};
		const fromRaw = async (raw: Uint8Array<ArrayBuffer>, group: EcdhGroup): Promise<KeyObject> => {
			if (group === 'X25519') { return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: Buffer.from(raw).toString('base64url') }, format: 'jwk' }); }
			const imported = await crypto.subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: group }, true, []);
			return createPublicKey({ key: Buffer.from(await crypto.subtle.exportKey('spki', imported)), format: 'der', type: 'spki' });
		};
		for (const [group, curve] of [['X25519', ''], ['P-256', 'prime256v1'], ['P-384', 'secp384r1']] as const) {
			const share = await generateEcdhShare(group);
			const peer = group === 'X25519' ? generateKeyPairSync('x25519') : generateKeyPairSync('ec', { namedCurve: curve });
			const ours = await ecdhSharedSecret(share, await toRaw(peer.publicKey, group));
			const theirs = diffieHellman({ privateKey: peer.privateKey, publicKey: await fromRaw(share.publicKey, group) });
			expect(ours).toEqual(new Uint8Array(theirs));
		}
	});

	it('rejects invalid and low-order server key shares', async () => {
		await expect(ecdhSharedSecret(await generateEcdhShare('P-256'), new Uint8Array([4, 1, 2, 3]))).rejects.toThrow('Invalid server key share.');
		await expect(ecdhSharedSecret(await generateEcdhShare('X25519'), new Uint8Array(32))).rejects.toThrow('Invalid server key share.');
	});

	it('agrees on finite-field DHE secrets with an independent implementation', () => {
		const group = getDiffieHellman('modp14');
		group.generateKeys();
		const ours = dheAgree(new Uint8Array(group.getPrime()), new Uint8Array(group.getGenerator()), new Uint8Array(group.getPublicKey()));
		const theirs = new Uint8Array(group.computeSecret(Buffer.from(ours.publicKey)));
		expect(ours.sharedSecret).toEqual(theirs.subarray(theirs.findIndex(byte => byte !== 0)));
	});

	it('refuses Logjam-sized groups and degenerate parameters', () => {
		const weak = createDiffieHellman(getDiffieHellman('modp2').getPrime());
		weak.generateKeys();
		expect(() => dheAgree(new Uint8Array(weak.getPrime()), new Uint8Array([2]), new Uint8Array(weak.getPublicKey()))).toThrow('too weak');
		const strong = getDiffieHellman('modp14');
		const prime = new Uint8Array(strong.getPrime());
		const evenPrime = new Uint8Array(prime);
		evenPrime[evenPrime.length - 1] = (evenPrime.at(-1) as number) & 0xFE;
		const primeMinusOne = new Uint8Array(prime);
		primeMinusOne[primeMinusOne.length - 1] = (primeMinusOne.at(-1) as number) - 1;
		expect(() => dheAgree(evenPrime, new Uint8Array([2]), new Uint8Array([5]))).toThrow('too weak');
		expect(() => dheAgree(prime, new Uint8Array([1]), new Uint8Array([5]))).toThrow('Invalid server Diffie-Hellman parameters.');
		expect(() => dheAgree(prime, new Uint8Array([2]), new Uint8Array([1]))).toThrow('Invalid server Diffie-Hellman parameters.');
		expect(() => dheAgree(prime, new Uint8Array([2]), primeMinusOne)).toThrow('Invalid server Diffie-Hellman parameters.');
		expect(() => dheAgree(prime, primeMinusOne, new Uint8Array([5]))).toThrow('Invalid server Diffie-Hellman parameters.');
	});
});

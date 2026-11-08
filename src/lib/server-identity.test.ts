import { X509Certificate, createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { Bytes } from '~/lib/tls/bytes';

import {
	authSwitchScramble,
	expectedMariaDbProof,
	isErrorPacket,
	isOkPacket,
	okPacketProof,
	parseGreeting,
	spkiPin,
	splitPackets,
} from '~/lib/server-identity';
import { rsaCertificate } from '~/lib/tls/test-fixtures';

const packet = (sequence: number, payload: number[] | Bytes): Bytes => {
	const body = new Uint8Array(payload);
	return new Uint8Array([body.length & 0xFF, (body.length >> 8) & 0xFF, body.length >> 16, sequence, ...body]);
};

const ascii = (text: string): number[] => [...new TextEncoder().encode(text)];

const greetingPayload = (version: string, scramble: number[]): number[] => [
	10,
	...ascii(version),
	0,
	1,
	0,
	0,
	0,
	...scramble.slice(0, 8),
	0,
	0xFF,
	0xF7,
	45,
	2,
	0,
	0xFF,
	0x81,
	21,
	...Array.from({ length: 10 }, () => 0),
	...scramble.slice(8),
	0,
];

describe('certificate pins', () => {
	it('matches the base64 SHA-256 of the SubjectPublicKeyInfo, as the pin collection script prints it', async () => {
		const spki = new X509Certificate(rsaCertificate).publicKey.export({ type: 'spki', format: 'der' });
		expect(await spkiPin(new Uint8Array(spki))).toBe(createHash('sha256').update(spki).digest('base64'));
	});
});

describe('MySQL packet framing', () => {
	it('splits complete packets and keeps partial ones buffered', () => {
		const first = packet(0, [1, 2, 3]);
		const second = packet(1, [4]);
		const { packets, rest } = splitPackets(new Uint8Array([...first, ...second, 9, 0, 0]));

		expect(packets).toEqual([first, second]);
		expect(rest).toEqual(new Uint8Array([9, 0, 0]));
		expect(splitPackets(new Uint8Array([5, 0, 0, 0, 1])).packets).toEqual([]);
	});

	it('classifies OK and ERR packets', () => {
		expect(isOkPacket(packet(2, [0, 0, 0]))).toBe(true);
		expect(isErrorPacket(packet(2, [0xFF, 0x15, 0x04]))).toBe(true);
		expect(isOkPacket(packet(2, [0xFE]))).toBe(false);
	});
});

describe('server greeting', () => {
	const scramble = Array.from({ length: 20 }, (_value, index) => index + 1);

	it('reads the 20-byte scramble and recognizes MariaDB', () => {
		expect(parseGreeting(packet(0, greetingPayload('12.3.3-MariaDB-ubu2404', scramble)))).toEqual({ isMariaDb: true, scramble: new Uint8Array(scramble) });
		expect(parseGreeting(packet(0, greetingPayload('8.4.13', scramble)))?.isMariaDb).toBe(false);
	});

	it('rejects packets that are not protocol-10 greetings', () => {
		expect(parseGreeting(packet(0, [0xFF, 0x10, 0x04, ...ascii('Too many connections')]))).toBeNull();
		expect(parseGreeting(packet(0, [10, ...ascii('no terminator')]))).toBeNull();
		expect(parseGreeting(packet(0, [10, ...ascii('8.4.13'), 0, 1, 2, 3]))).toBeNull();
	});
});

describe('MariaDB certificate proof', () => {
	it('reads the scramble from AuthSwitchRequest packets only', () => {
		expect(authSwitchScramble(packet(2, [0xFE, ...ascii('mysql_native_password'), 0, 9, 8, 7, 0]))).toEqual(new Uint8Array([9, 8, 7]));
		expect(authSwitchScramble(packet(2, [0xFE, ...ascii('client_ed25519'), 0, 9, 8, 7]))).toEqual(new Uint8Array([9, 8, 7]));
		expect(authSwitchScramble(packet(2, [0xFE]))).toBeNull();
		expect(authSwitchScramble(packet(2, [0xFE, ...ascii('unterminated')]))).toBeNull();
		expect(authSwitchScramble(packet(2, [0, 0, 0]))).toBeNull();
	});

	it('extracts the proof from the OK packet info', () => {
		const proof = '7E230447F216CAE12770A338743D72B56EEFF83AF5987FBF7869D857800BFA58';
		// Captured from MariaDB 12.3.3: affected rows, insert id, status, warnings, then a length-prefixed "\x01" + hex info string.
		const ok = packet(2, [0, 0, 0, 2, 0, 0, 0, 0x41, 1, ...ascii(proof)]);

		expect(okPacketProof(ok)).toBe(proof);
		expect(okPacketProof(packet(2, [0, 0, 0, 2, 0, 0, 0, 0x41, 1, ...ascii(proof.toLowerCase())]))).toBe(proof);
		expect(okPacketProof(packet(2, [0, 1, 0, 2, 0, 0, 0, 1, ...ascii('short')]))).toBeNull();
		expect(okPacketProof(packet(2, [0, 0, 0, 2, 0, 0, 0]))).toBeNull();
	});

	it('computes SHA-256(SHA1(SHA1(password)) || scramble || SHA-256(certificate))', async () => {
		const certificate = new Uint8Array(new X509Certificate(rsaCertificate).raw);
		const scrambleBytes = new Uint8Array(20).map((_value, index) => index);
		const passwordHash = createHash('sha1').update(createHash('sha1').update('customerpw').digest()).digest();
		const expected = createHash('sha256').update(passwordHash).update(scrambleBytes)
			.update(createHash('sha256').update(certificate).digest())
			.digest('hex')
			.toUpperCase();

		expect(await expectedMariaDbProof('customerpw', scrambleBytes, certificate)).toBe(expected);
		expect(await expectedMariaDbProof('other', scrambleBytes, certificate)).not.toBe(expected);
	});
});

// Production MySQL/MariaDB servers use self-signed certificates that no CA vouches for, so identity is established in two ways:
// MySQL keys are pinned (their auto-generated certificates persist across restarts and upgrades), and MariaDB, whose zero-config
// certificate changes on every restart, proves its certificate in the OK packet with a hash bound to the user's password.

import type { Bytes } from '~/lib/tls/bytes';

const encoder = new TextEncoder();

const sha = async (algorithm: 'SHA-1' | 'SHA-256', ...parts: Bytes[]): Promise<Bytes> => {
	const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		joined.set(part, offset);
		offset += part.length;
	}
	return new Uint8Array(await crypto.subtle.digest(algorithm, joined));
};

const base64 = (bytes: Bytes): string => btoa(String.fromCodePoint(...bytes));

const hex = (bytes: Bytes): string => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();

/** Pins are base64 SHA-256 digests of the certificate's SubjectPublicKeyInfo, as printed by scripts/collect-tls-pins.mjs. */
export const spkiPin = async (spki: Bytes): Promise<string> => base64(await sha('SHA-256', spki));

const PACKET_HEADER = 4;

/** Splits buffered MySQL protocol bytes into complete packets (header included) and the incomplete remainder. */
export const splitPackets = (buffer: Bytes): { packets: Bytes[]; rest: Bytes; } => {
	const packets: Bytes[] = [];
	let offset = 0;
	while (buffer.length - offset >= PACKET_HEADER) {
		const length = (buffer[offset] as number) | ((buffer[offset + 1] as number) << 8) | ((buffer[offset + 2] as number) << 16);
		if (buffer.length - offset < PACKET_HEADER + length) {
			break;
		}
		packets.push(buffer.subarray(offset, offset + PACKET_HEADER + length));
		offset += PACKET_HEADER + length;
	}
	return { packets, rest: buffer.subarray(offset) };
};

export interface ServerGreeting {
	isMariaDb: boolean;
	scramble: Bytes;
}

/** Reads the server version and 20-byte auth scramble from a protocol-10 handshake packet (header included). */
export const parseGreeting = (packet: Bytes): ServerGreeting | null => {
	const payload = packet.subarray(PACKET_HEADER);
	const versionEnd = payload.indexOf(0, 1);
	if (payload[0] !== 10 || versionEnd === -1) {
		return null;
	}
	const version = new TextDecoder().decode(payload.subarray(1, versionEnd));
	// version NUL, thread id (4), scramble part 1 (8), filler, capabilities (2), charset, status (2), capabilities (2), auth length, reserved (10).
	const partOne = versionEnd + 1 + 4;
	const partTwo = partOne + 8 + 1 + 2 + 1 + 2 + 2 + 1 + 10;
	if (payload.length < partTwo + 12) {
		return null;
	}
	const scramble = new Uint8Array(20);
	scramble.set(payload.subarray(partOne, partOne + 8));
	scramble.set(payload.subarray(partTwo, partTwo + 12), 8);
	return { isMariaDb: /mariadb/i.test(version), scramble };
};

/** An AuthSwitchRequest replaces the scramble the proof is computed with. */
export const authSwitchScramble = (packet: Bytes): Bytes | null => {
	const payload = packet.subarray(PACKET_HEADER);
	if (payload[0] !== 0xFE || payload.length < 2) {
		return null;
	}
	const nameEnd = payload.indexOf(0, 1);
	if (nameEnd === -1) {
		return null;
	}
	let data = payload.subarray(nameEnd + 1);
	if (data.at(-1) === 0) {
		data = data.subarray(0, -1);
	}
	return data;
};

export const isOkPacket = (packet: Bytes): boolean => packet[PACKET_HEADER] === 0x00;

export const isErrorPacket = (packet: Bytes): boolean => packet[PACKET_HEADER] === 0xFF;

/** Extracts MariaDB's certificate proof ("\x01" + 64 hex characters) from an OK packet's info, if present. */
export const okPacketProof = (packet: Bytes): string | null => {
	const text = new TextDecoder('latin1').decode(packet.subarray(PACKET_HEADER));
	for (let index = text.indexOf('\u{1}'); index !== -1; index = text.indexOf('\u{1}', index + 1)) {
		const candidate = text.slice(index + 1, index + 65);
		if (/^[\dA-F]{64}$/i.test(candidate)) {
			return candidate.toUpperCase();
		}
	}
	return null;
};

/** SHA-256(SHA1(SHA1(password)) || scramble || SHA-256(certificate)), as MariaDB 11.4+ computes it. */
export const expectedMariaDbProof = async (password: string, scramble: Bytes, certificate: Bytes): Promise<string> => {
	const passwordHash = await sha('SHA-1', await sha('SHA-1', encoder.encode(password)));
	return hex(await sha('SHA-256', passwordHash, scramble, await sha('SHA-256', certificate)));
};

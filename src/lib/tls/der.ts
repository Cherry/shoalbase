import { type Bytes, TlsError, concat } from '~/lib/tls/bytes';

interface Tlv {
	tag: number;
	/** The whole element including its header. */
	element: Bytes;
	content: Bytes;
}

const readTlv = (bytes: Bytes, offset: number): Tlv => {
	const tag = bytes[offset];
	let length = bytes[offset + 1];
	if (tag === undefined || length === undefined) { throw new TlsError('Malformed certificate.', 42); }
	let header = 2;
	if (length > 0x7F) {
		const lengthBytes = length & 0x7F;
		if (lengthBytes === 0 || lengthBytes > 4) { throw new TlsError('Malformed certificate.', 42); }
		length = 0;
		for (let index = 0; index < lengthBytes; index += 1) {
			const byte = bytes[offset + 2 + index];
			if (byte === undefined) { throw new TlsError('Malformed certificate.', 42); }
			length = (length * 256) + byte;
		}
		header += lengthBytes;
	}
	const end = offset + header + length;
	if (end > bytes.length) { throw new TlsError('Malformed certificate.', 42); }
	return { tag, element: bytes.subarray(offset, end), content: bytes.subarray(offset + header, end) };
};

const children = (content: Bytes): Tlv[] => {
	const items: Tlv[] = [];
	for (let offset = 0; offset < content.length;) {
		const item = readTlv(content, offset);
		items.push(item);
		offset += item.element.length;
	}
	return items;
};

const SEQUENCE = 0x30;
const CONTEXT_VERSION = 0xA0;

/** Returns the DER SubjectPublicKeyInfo of an X.509 certificate. */
export const certificateSpki = (certificate: Bytes): Bytes => {
	const outer = readTlv(certificate, 0);
	const [tbs] = outer.tag === SEQUENCE ? children(outer.content) : [];
	if (tbs?.tag !== SEQUENCE) { throw new TlsError('Malformed certificate.', 42); }
	const fields = children(tbs.content);
	// tbsCertificate: [0] version (optional), serial, signature, issuer, validity, subject, subjectPublicKeyInfo.
	const spkiIndex = fields[0]?.tag === CONTEXT_VERSION ? 6 : 5;
	const spki = fields[spkiIndex];
	if (spki?.tag !== SEQUENCE) { throw new TlsError('Malformed certificate.', 42); }
	return spki.element;
};

export type PublicKeyType = { kind: 'rsa'; } | { kind: 'ec'; curve: 'P-256' | 'P-384'; size: number; };

const OID_RSA = '2a864886f70d010101';
const OID_EC = '2a8648ce3d0201';
const OID_P256 = '2a8648ce3d030107';
const OID_P384 = '2b81040022';

const hex = (bytes: Bytes): string => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

export const spkiKeyType = (spki: Bytes): PublicKeyType => {
	const [algorithm] = children(readTlv(spki, 0).content);
	const [oid, parameters] = algorithm ? children(algorithm.content) : [];
	const algorithmOid = oid ? hex(oid.content) : '';
	if (algorithmOid === OID_RSA) { return { kind: 'rsa' }; }
	if (algorithmOid === OID_EC && parameters) {
		const curve = hex(parameters.content);
		if (curve === OID_P256) { return { kind: 'ec', curve: 'P-256', size: 32 }; }
		if (curve === OID_P384) { return { kind: 'ec', curve: 'P-384', size: 48 }; }
	}
	throw new TlsError('Unsupported server certificate key type.', 43);
};

/** Converts a DER ECDSA-Sig-Value into the fixed-width r||s form WebCrypto verifies. */
export const ecdsaSignatureToRaw = (signature: Bytes, size: number): Bytes => {
	const sequence = readTlv(signature, 0);
	const parts = children(sequence.content);
	if (sequence.tag !== SEQUENCE || parts.length !== 2) { throw new TlsError('Malformed ECDSA signature.', 51); }
	return concat(...parts.map((part) => {
		const firstSignificant = part.content.findIndex(byte => byte !== 0);
		const value = firstSignificant === -1 ? new Uint8Array(0) : part.content.subarray(firstSignificant);
		if (part.tag !== 0x02 || value.length > size) { throw new TlsError('Malformed ECDSA signature.', 51); }
		const padded = new Uint8Array(size);
		padded.set(value, size - value.length);
		return padded;
	}));
};

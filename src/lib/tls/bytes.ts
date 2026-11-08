/** ArrayBuffer-backed bytes, which WebCrypto requires for every input. */
export type Bytes = Uint8Array<ArrayBuffer>;

export class TlsError extends Error {
	constructor(message: string, readonly alert = 40) {
		super(message);
		this.name = 'TlsError';
	}
}

export const concat = (...parts: Bytes[]): Bytes => {
	const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}
	return result;
};

export const equalBytes = (left: Bytes, right: Bytes): boolean => {
	if (left.length !== right.length) { return false; }
	let difference = 0;
	for (const [index, value] of left.entries()) {
		difference |= value ^ (right[index] as number);
	}
	return difference === 0;
};

export const uint = (value: number, length: number): Bytes => {
	const bytes = new Uint8Array(length);
	for (let index = length - 1, remaining = value; index >= 0; index -= 1) {
		bytes[index] = remaining & 0xFF;
		remaining = Math.floor(remaining / 256);
	}
	return bytes;
};

/** A TLS vector: the payload prefixed with its length in `lengthBytes` bytes. */
export const vector = (payload: Bytes, lengthBytes: number): Bytes => concat(uint(payload.length, lengthBytes), payload);

export const ascii = (text: string): Bytes => new TextEncoder().encode(text);

/** Bounds-checked sequential reader; every overrun is a decode_error rather than silently reading zeros. */
export class ByteReader {
	private offset = 0;

	constructor(private readonly bytes: Bytes) {}

	get remaining(): number {
		return this.bytes.length - this.offset;
	}

	read(length: number): Bytes {
		if (length > this.remaining) { throw new TlsError('Malformed TLS message.', 50); }
		const slice = this.bytes.subarray(this.offset, this.offset + length);
		this.offset += length;
		return slice;
	}

	uint(length: number): number {
		let value = 0;
		for (const byte of this.read(length)) {
			value = (value * 256) + byte;
		}
		return value;
	}

	vector(lengthBytes: number): Bytes {
		return this.read(this.uint(lengthBytes));
	}

	end(): void {
		if (this.remaining !== 0) { throw new TlsError('Unexpected trailing bytes in TLS message.', 50); }
	}
}

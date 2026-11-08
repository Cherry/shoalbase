// Raw bytes inside export text: binary column values (one char per byte) travel as private-use characters until the file is encoded.

// Bytes 0x80-0xFF map to U+F780-U+F7FF, which UTF-8 text from MySQL practically never contains.
const BYTE_BASE = 0xF7_00;

/** Marks the high bytes of a byte string (as the DBI decodes binary columns) so encodeOutput() writes them back unchanged. */
export function escapeBinary(bytes: string): string {
	return bytes.replaceAll(/[\u{80}-\u{FF}]/gu, character => String.fromCodePoint(BYTE_BASE + (character.codePointAt(0) as number)));
}

/** UTF-8 encodes export text, turning the characters escapeBinary() made back into single bytes. */
export function encodeOutput(text: string): Uint8Array {
	const encoder = new TextEncoder();
	const parts = text.split(/([\u{F780}-\u{F7FF}]+)/u);
	const chunks = parts.map((part, index) => {
		if (index % 2 === 0) {
			return encoder.encode(part);
		}
		return Uint8Array.from(part, character => (character.codePointAt(0) as number) - BYTE_BASE);
	});
	const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.length;
	}
	return result;
}

/** Export text as htmlspecialchars() without ENT_SUBSTITUTE reads it: the decoded UTF-8, or '' when the bytes are not valid UTF-8. */
export function validUtf8OrEmpty(text: string): string {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(encodeOutput(text));
	} catch {
		return '';
	}
}

/** What PHP's htmlspecialchars() with ENT_SUBSTITUTE sees in a byte string: valid UTF-8 decoded, invalid bytes as U+FFFD. */
export function substituteInvalid(bytes: string): string {
	const data = Uint8Array.from(bytes, character => (character.codePointAt(0) as number) & 0xFF);
	const lead = (byte: number | undefined): boolean => byte === undefined || byte < 0x80 || (byte >= 0xC2 && byte <= 0xF4);
	const trail = (byte: number | undefined): boolean => byte !== undefined && byte >= 0x80 && byte <= 0xBF;
	let text = '';
	let position = 0;
	// php_next_utf8_char(): how many bytes one replacement character swallows differs from TextDecoder's rules.
	const fail = (length: number): void => {
		text += '\u{FFFD}';
		position += length;
	};
	// The length of the invalid sequence: up to the first byte that could start a new character.
	const failure = (size: number): number => {
		for (let offset = 1; offset < size; offset++) {
			if (position + offset >= data.length || lead(data[position + offset])) {
				return offset;
			}
		}
		return size;
	};
	while (position < data.length) {
		const byte = data[position];
		let size = 4;
		if (byte < 0x80) {
			size = 1;
		} else if (byte < 0xC2 || byte > 0xF4) {
			fail(1);
			continue;
		} else if (byte < 0xE0) {
			size = 2;
		} else if (byte < 0xF0) {
			size = 3;
		}
		const sequence = data.subarray(position, position + size);
		if (sequence.length < size || !sequence.subarray(1).every(next => trail(next))) {
			fail(failure(size));
			continue;
		}
		const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
		try {
			text += decoded.decode(sequence);
			position += size;
		} catch {
			// Overlong forms, surrogates and code points past U+10FFFF take the whole sequence.
			fail(size);
		}
	}
	return text;
}

/** A byte array as a byte string, one char per byte like the DBI's binary columns. */
export function bytesToString(bytes: Uint8Array): string {
	let text = '';
	for (let start = 0; start < bytes.length; start += 8192) {
		text += String.fromCodePoint(...bytes.subarray(start, start + 8192));
	}
	return text;
}

// The uploaded file side of an import: File::open() compression handling, ZipExtension::getContents() and Import::getNextChunk() decoding.

export type Compression = 'application/bzip2' | 'application/gzip' | 'application/zip' | 'none';

/** Util::getCompressionMimeType(): sniffed from the first bytes. */
export function detectCompression(bytes: Uint8Array): Compression {
	if (bytes.length >= 2 && bytes[0] === 0x1F && bytes[1] === 0x8B) {
		return 'application/gzip';
	}
	if (bytes.length >= 3 && bytes[0] === 0x42 && bytes[1] === 0x5A && bytes[2] === 0x68) {
		return 'application/bzip2';
	}
	if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04) {
		return 'application/zip';
	}
	return 'none';
}

async function inflate(bytes: Uint8Array, format: 'deflate-raw' | 'gzip'): Promise<Uint8Array> {
	const stream = (new Response(bytes as Uint8Array<ArrayBuffer>).body as ReadableStream).pipeThrough(new DecompressionStream(format));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** gzread() of the whole file: what decompresses before an error is kept, as zlib's stream reader does. */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
	const reader = (new Response(bytes as Uint8Array<ArrayBuffer>).body as ReadableStream).pipeThrough(new DecompressionStream('gzip')).getReader();
	const chunks: Uint8Array[] = [];
	try {
		for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
			chunks.push(chunk.value);
		}
	} catch {
		// A truncated or corrupt member ends the data, like gzread() returning short.
	}
	const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.length;
	}
	return result;
}

interface ZipEntry {
	name: string;
	method: number;
	compressedSize: number;
	localOffset: number;
}

// ZipArchive::open() reads the central directory, whose order getFromIndex() follows.
function zipEntries(bytes: Uint8Array): ZipEntry[] | null {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let end = -1;
	for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 22 - 0xFF_FF); index--) {
		if (view.getUint32(index, true) === 0x06_05_4B_50) {
			end = index;
			break;
		}
	}
	if (end === -1) {
		return null;
	}
	const count = view.getUint16(end + 10, true);
	let offset = view.getUint32(end + 16, true);
	const entries: ZipEntry[] = [];
	const decoder = new TextDecoder();
	for (let index = 0; index < count; index++) {
		if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02_01_4B_50) {
			return null;
		}
		const nameLength = view.getUint16(offset + 28, true);
		entries.push({
			name: decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)),
			method: view.getUint16(offset + 10, true),
			compressedSize: view.getUint32(offset + 20, true),
			localOffset: view.getUint32(offset + 42, true),
		});
		offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
	}
	return entries;
}

async function zipEntryData(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const start = entry.localOffset + 30 + view.getUint16(entry.localOffset + 26, true) + view.getUint16(entry.localOffset + 28, true);
	const data = bytes.subarray(start, start + entry.compressedSize);
	if (entry.method === 0) {
		return data;
	}
	return inflate(data, 'deflate-raw');
}

const ODS_MEDIA_TYPE = 'application/vnd.oasis.opendocument.spreadsheet';

/** ZipExtension::getNumberOfFiles(). */
export function zipFileCount(bytes: Uint8Array): number {
	return zipEntries(bytes)?.length ?? 0;
}

/** A specific entry to extract: the pattern, and how upstream writes it in its error. */
export interface ZipEntryPattern {
	pattern: RegExp;
	source: string;
}

/** ZipExtension::getContents(): the first file, the first one matching `entry`, or content.xml of an OpenDocument spreadsheet. */
export async function zipContents(bytes: Uint8Array, entry: ZipEntryPattern | null = null): Promise<{ error: string; data: Uint8Array; unreadable?: true; }> {
	const entries = zipEntries(bytes);
	// ZipArchive::getStatusString() after a failed open() throws a ValueError in PHP 8.
	if (entries === null) {
		return { error: '', data: new Uint8Array(), unreadable: true };
	}
	if (entries.length === 0) {
		return { error: 'No files found inside ZIP archive!', data: new Uint8Array() };
	}
	const first = await zipEntryData(bytes, entries[0]);
	let specific = entry;
	if (new TextDecoder().decode(first) === ODS_MEDIA_TYPE) {
		specific = { pattern: /^content\.xml$/, source: String.raw`/^content\.xml$/` };
	}
	if (specific === null) {
		return { error: '', data: first };
	}
	const { pattern, source } = specific;
	const match = entries.find(candidate => pattern.test(candidate.name));
	const data = match === undefined ? new Uint8Array() : await zipEntryData(bytes, match);
	// empty($fileData) also rejects a matching entry that is empty or just "0".
	if (data.length === 0 || (data.length === 1 && data[0] === 0x30)) {
		return { error: `Error in ZIP archive: Could not find "${source}"`, data };
	}
	return { error: '', data };
}

/** Import::skipByteOrderMarksFromContents(). */
export function skipByteOrderMarks(bytes: Uint8Array): Uint8Array {
	if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
		return bytes.subarray(3);
	}
	if ((bytes[0] === 0xFE && bytes[1] === 0xFF) || (bytes[0] === 0xFF && bytes[1] === 0xFE)) {
		return bytes.subarray(2);
	}
	return bytes;
}

/** The file as text: converted from its charset (Encoding::convertString()), or UTF-8 without a byte order mark. */
export function decodeImport(bytes: Uint8Array, charset: string | null): string {
	if (charset !== null) {
		try {
			return new TextDecoder(charset).decode(bytes);
		} catch {
			// An encoding the runtime lacks falls back to the bytes as UTF-8.
		}
	}
	return new TextDecoder('utf-8', { ignoreBOM: true }).decode(skipByteOrderMarks(bytes));
}

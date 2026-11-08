// The gzip and zip writers export uses: gzencode() and ZipExtension::createFile(), on a zlib-identical deflate so the bytes match PHP's.

import { zlibDeflateRaw } from './zlib-deflate.ts';

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
	let crc = index;
	for (let bit = 0; bit < 8; bit++) {
		crc = (crc & 1) === 1 ? (0xED_B8_83_20 ^ (crc >>> 1)) : crc >>> 1;
	}
	return crc >>> 0;
});

/** PHP's crc32(). */
export function crc32(bytes: Uint8Array): number {
	let crc = 0xFF_FF_FF_FF;
	for (const byte of bytes) {
		crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
	}
	return (crc ^ 0xFF_FF_FF_FF) >>> 0;
}

function concat(parts: Uint8Array[]): Uint8Array {
	const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}
	return result;
}

function le32(value: number): Uint8Array {
	return new Uint8Array([value & 0xFF, (value >>> 8) & 0xFF, (value >>> 16) & 0xFF, (value >>> 24) & 0xFF]);
}

function le16(value: number): Uint8Array {
	return new Uint8Array([value & 0xFF, (value >>> 8) & 0xFF]);
}

/** gzencode(): a gzip member with no file name, mtime 0 and the Unix OS byte, like PHP's zlib. */
export function gzencode(bytes: Uint8Array): Uint8Array {
	const header = new Uint8Array([0x1F, 0x8B, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03]);
	return concat([header, zlibDeflateRaw(bytes), le32(crc32(bytes)), le32(bytes.length)]);
}

/** The MS-DOS date and time ZipExtension::createFile() stamps on every entry, from getdate() in the server's zone (UTC). */
export function dosTime(date: Date): number {
	if (date.getUTCFullYear() < 1980) {
		return (1 << 21) | (1 << 16);
	}
	return (((date.getUTCFullYear() - 1980) << 25) | ((date.getUTCMonth() + 1) << 21) | (date.getUTCDate() << 16)
		| (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1)) >>> 0;
}

/** ZipExtension::createFile() for named entries. */
export function createZip(entries: [string, Uint8Array][], date: Date): Uint8Array {
	const encoder = new TextEncoder();
	const time = le32(dosTime(date));
	const sections: Uint8Array[] = [];
	const directory: Uint8Array[] = [];
	let offset = 0;
	for (const [entryName, data] of entries) {
		const name = encoder.encode(entryName.replaceAll('\\', '/'));
		const compressed = zlibDeflateRaw(data);
		const sizes = concat([le32(crc32(data)), le32(compressed.length), le32(data.length), le16(name.length), le16(0)]);
		const local = concat([new Uint8Array([0x50, 0x4B, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]), time, sizes, name, compressed]);
		sections.push(local);
		directory.push(concat([
			new Uint8Array([0x50, 0x4B, 0x01, 0x02, 0x00, 0x00, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]),
			time,
			sizes,
			le16(0),
			le16(0),
			le16(0),
			le32(32),
			le32(offset),
			name,
		]));
		offset += local.length;
	}
	const centralDirectory = concat(directory);
	const end = concat([
		new Uint8Array([0x50, 0x4B, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00]),
		le16(directory.length),
		le16(directory.length),
		le32(centralDirectory.length),
		le32(offset),
		new Uint8Array([0x00, 0x00]),
	]);
	return concat([...sections, centralDirectory, end]);
}

/** ZipExtension::createFile() with an array of dumps: "db.sql" becomes "db_<key>.sql" for each part. */
export function separateFileNames(name: string, keys: string[]): string[] {
	const dot = name.indexOf('.');
	const extension = dot === -1 ? name : name.slice(dot);
	return keys.map(key => name.replaceAll(extension, () => `_${key}${extension}`));
}

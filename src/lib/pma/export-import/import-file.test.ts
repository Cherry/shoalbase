import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { createZip } from './compress.ts';
import {
	decodeImport,
	detectCompression,
	gunzip,
	skipByteOrderMarks,
	zipContents,
	zipFileCount,
} from './import-file.ts';

const encoder = new TextEncoder();
const date = new Date('2026-01-02T03:04:05Z');
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

async function dataOf(...args: Parameters<typeof zipContents>): Promise<string> {
	const result = await zipContents(...args);
	return decode(result.data);
}

async function errorOf(...args: Parameters<typeof zipContents>): Promise<string> {
	const result = await zipContents(...args);
	return result.error;
}

describe('detectCompression', () => {
	it.each([
		[[0x1F, 0x8B, 0], 'application/gzip'],
		[[0x42, 0x5A, 0x68], 'application/bzip2'],
		[[0x50, 0x4B, 0x03, 0x04], 'application/zip'],
		[[0x50, 0x4B, 0x03], 'none'],
		[[], 'none'],
	])('sniffs %j as %s', (bytes, type) => {
		expect(detectCompression(new Uint8Array(bytes))).toBe(type);
	});
});

describe('gunzip', () => {
	it('inflates a gzip upload and keeps what precedes a truncation', async () => {
		const packed = gzipSync('SELECT 1;\n'.repeat(500));
		expect(decode(await gunzip(packed))).toBe('SELECT 1;\n'.repeat(500));
		const partial = decode(await gunzip(packed.subarray(0, -8)));
		expect('SELECT 1;\n'.repeat(500).startsWith(partial)).toBe(true);
	});
});

describe('zipContents', () => {
	it('returns the first entry of a plain archive', async () => {
		const zip = createZip([['dump.sql', encoder.encode('SELECT 1;')], ['other.txt', encoder.encode('x')]], date);
		expect(zipFileCount(zip)).toBe(2);
		expect(await dataOf(zip)).toBe('SELECT 1;');
	});

	it('finds the end of central directory record before an archive comment', async () => {
		const zip = createZip([['dump.sql', encoder.encode('SELECT 1;')]], date);
		const comment = encoder.encode('exported by hand');
		const commented = new Uint8Array([...zip, ...comment]);
		new DataView(commented.buffer).setUint16(zip.length - 2, comment.length, true);
		expect(zipFileCount(commented)).toBe(1);
		expect(await dataOf(commented)).toBe('SELECT 1;');
	});

	it('returns content.xml of an OpenDocument spreadsheet and the first match of a pattern', async () => {
		const ods = createZip([['mimetype', encoder.encode('application/vnd.oasis.opendocument.spreadsheet')], ['content.xml', encoder.encode('<x/>')]], date);
		expect(await dataOf(ods)).toBe('<x/>');
		const shapes = createZip([['a.txt', encoder.encode('x')], ['data/Points.SHP', encoder.encode('shape')]], date);
		expect(await dataOf(shapes, { pattern: /^.*\.shp$/i, source: String.raw`/^.*\.shp$/i` })).toBe('shape');
	});

	it('names the pattern it could not find, which also covers an empty or "0" entry', async () => {
		const zip = createZip([['a.txt', encoder.encode('x')], ['b.shp', encoder.encode('0')]], date);
		expect(await errorOf(zip, { pattern: /^.*\.shp$/i, source: 'SHP' })).toBe('Error in ZIP archive: Could not find "SHP"');
		const ods = createZip([['mimetype', encoder.encode('application/vnd.oasis.opendocument.spreadsheet')]], date);
		expect(await errorOf(ods)).toBe(String.raw`Error in ZIP archive: Could not find "/^content\.xml$/"`);
	});

	it('flags archives ZipArchive cannot open and reports empty ones', async () => {
		expect(await zipContents(encoder.encode('PK\u{3}\u{4}garbage'))).toMatchObject({ unreadable: true });
		expect(zipFileCount(encoder.encode('nope'))).toBe(0);
		expect(await errorOf(createZip([], date))).toBe('No files found inside ZIP archive!');
	});

	it('reads stored entries and rejects a broken central directory', async () => {
		const stored = createZip([['a.sql', encoder.encode('stored')]], date);
		// Flip the entry to method 0 (stored) with the raw bytes in place of the deflated ones.
		const view = new DataView(stored.buffer);
		const raw = encoder.encode('stored');
		const local = new Uint8Array([...stored.subarray(0, 30), ...encoder.encode('a.sql'), ...raw]);
		new DataView(local.buffer).setUint16(8, 0, true);
		new DataView(local.buffer).setUint32(18, raw.length, true);
		const central = Uint8Array.from(stored.subarray(view.getUint32(stored.length - 6, true), -22));
		new DataView(central.buffer).setUint16(10, 0, true);
		new DataView(central.buffer).setUint32(20, raw.length, true);
		const end = Uint8Array.from(stored.subarray(-22));
		new DataView(end.buffer).setUint32(16, local.length, true);
		expect(await dataOf(new Uint8Array([...local, ...central, ...end]))).toBe('stored');
		const broken = new Uint8Array([...local, ...encoder.encode('XXXX'), ...central.subarray(4), ...end]);
		expect(await zipContents(broken)).toMatchObject({ unreadable: true });
	});
});

describe('decoding the upload', () => {
	it('drops UTF-8 and UTF-16 byte order marks', () => {
		expect([...skipByteOrderMarks(new Uint8Array([0xEF, 0xBB, 0xBF, 0x41]))]).toEqual([0x41]);
		expect([...skipByteOrderMarks(new Uint8Array([0xFF, 0xFE, 0x41]))]).toEqual([0x41]);
		expect([...skipByteOrderMarks(new Uint8Array([0xFE, 0xFF, 0x41]))]).toEqual([0x41]);
		expect(decodeImport(new Uint8Array([0xEF, 0xBB, 0xBF, 0xC3, 0xA9]), null)).toBe('é');
	});

	it('converts from the chosen charset and falls back to UTF-8 for unknown ones', () => {
		expect(decodeImport(new Uint8Array([0xE9, 0x74, 0xE9]), 'iso-8859-1')).toBe('été');
		expect(decodeImport(new Uint8Array([0x61]), 'no-such-charset')).toBe('a');
	});
});

import { gunzipSync, inflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
	bytesToString,
	encodeOutput,
	escapeBinary,
	substituteInvalid,
	validUtf8OrEmpty,
} from './bytes.ts';
import {
	crc32,
	createZip,
	dosTime,
	gzencode,
	separateFileNames,
} from './compress.ts';

const encoder = new TextEncoder();

describe('crc32', () => {
	it('matches PHP crc32()', () => {
		expect(crc32(encoder.encode('The quick brown fox jumps over the lazy dog'))).toBe(0x41_4F_A3_39);
		expect(crc32(new Uint8Array())).toBe(0);
	});
});

describe('gzencode', () => {
	it('writes the bytes PHP gzencode() writes', () => {
		const data = encoder.encode('SELECT 1;\n'.repeat(50));
		const gzip = gzencode(data);
		expect(Buffer.from(gzip).toString('hex')).toBe('1f8b08000000000000030b76f571750e5130b4e60a1e658d101600aa67af0ef4010000');
		expect(new TextDecoder().decode(gunzipSync(gzip))).toBe('SELECT 1;\n'.repeat(50));
	});
});

describe('dosTime', () => {
	it('packs the date and time, clamping dates before 1980', () => {
		expect(dosTime(new Date(Date.UTC(2024, 4, 6, 7, 8, 10)))).toBe(((44 << 25) | (5 << 21) | (6 << 16) | (7 << 11) | (8 << 5) | 5) >>> 0);
		expect(dosTime(new Date(Date.UTC(1970, 0, 1)))).toBe((1 << 21) | (1 << 16));
	});
});

describe('createZip', () => {
	it('lays out local headers, the central directory and its end record like ZipExtension', () => {
		const zip = createZip([[String.raw`a\b.sql`, encoder.encode('hello')], ['c.sql', encoder.encode('')]], new Date(Date.UTC(2024, 0, 1)));
		const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
		expect(view.getUint32(0, true)).toBe(0x04_03_4B_50);
		const nameLength = view.getUint16(26, true);
		expect(new TextDecoder().decode(zip.subarray(30, 30 + nameLength))).toBe('a/b.sql');
		const size = view.getUint32(18, true);
		expect(new TextDecoder().decode(inflateRawSync(zip.subarray(30 + nameLength, 30 + nameLength + size)))).toBe('hello');
		expect(view.getUint32(14, true)).toBe(crc32(encoder.encode('hello')));
		const end = zip.length - 22;
		expect(view.getUint32(end, true)).toBe(0x06_05_4B_50);
		expect(view.getUint16(end + 8, true)).toBe(2);
		const directoryStart = view.getUint32(end + 16, true);
		expect(view.getUint32(directoryStart, true)).toBe(0x02_01_4B_50);
		expect(view.getUint32(directoryStart + 38, true)).toBe(32);
	});
});

describe('separateFileNames', () => {
	it('inserts the part name before the first dot, or prefixes it without one', () => {
		expect(separateFileNames('db.sql', ['database', 'table_t'])).toEqual(['db_database.sql', 'db_table_t.sql']);
		expect(separateFileNames('dump', ['x'])).toEqual(['_xdump']);
	});
});

describe('binary bytes in export text', () => {
	it('round-trips raw bytes next to UTF-8 text', () => {
		const text = `é ${escapeBinary('\u{0}ÿ\u{80}')} ü`;
		expect([...encodeOutput(text)]).toEqual([0xC3, 0xA9, 0x20, 0x00, 0xFF, 0x80, 0x20, 0xC3, 0xBC]);
	});

	it('turns invalid UTF-8 into replacement characters and converts byte arrays back', () => {
		expect(substituteInvalid('aÿbÃ©')).toBe('a�bé');
		expect(bytesToString(new Uint8Array([0x41, 0xFF]))).toBe('Aÿ');
	});

	// Expected values from htmlspecialchars(..., ENT_SUBSTITUTE) in the oracle container.
	it.each([
		['ffd8ffe00010', 'efbfbdefbfbdefbfbd0010'],
		['c3', 'efbfbd'],
		['c341', 'efbfbd41'],
		['e282', 'efbfbd'],
		['e2827a', 'efbfbd7a'],
		['e08080', 'efbfbd'],
		['eda080', 'efbfbd'],
		['f4908080', 'efbfbd'],
		['f0908d', 'efbfbd'],
		['f09f9880', 'f09f9880'],
		['c0af', 'efbfbdefbfbd'],
		['80', 'efbfbd'],
		['f5', 'efbfbd'],
		['e28241', 'efbfbd41'],
	])('replaces invalid UTF-8 in %s the way PHP does', (input, expected) => {
		const bytes = bytesToString(Uint8Array.from(Buffer.from(input, 'hex')));
		expect(Buffer.from(substituteInvalid(bytes), 'utf8').toString('hex')).toBe(expected);
	});

	it('blanks text whose bytes are not valid UTF-8, as htmlspecialchars() does without ENT_SUBSTITUTE', () => {
		expect(validUtf8OrEmpty(`a ${escapeBinary('â\u{82}¬')} ü`)).toBe('a € ü');
		expect(validUtf8OrEmpty(`a ${escapeBinary('ÿ')}`)).toBe('');
	});
});

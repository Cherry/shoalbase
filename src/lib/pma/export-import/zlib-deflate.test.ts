import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { zlibDeflateRaw } from './zlib-deflate.ts';

function xorshift(seed: number): () => number {
	let state = seed;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return state >>> 0;
	};
}

const noise = (length: number, seed: number): Uint8Array => {
	const next = xorshift(seed);
	return Uint8Array.from({ length }, () => next() & 0xFF);
};

function sqlText(length: number, seed: number): Uint8Array {
	const next = xorshift(seed);
	const words = ['INSERT INTO `players` VALUES ', '(1, \'Ada\', NULL),', '(2, \'Grace\', \'x\'),', '\n', '<table:table-cell office:value-type="string">', 'Linus', '0.5', ' '];
	let text = '';
	while (text.length < length) {
		text += words[next() % words.length];
	}
	return new TextEncoder().encode(text.slice(0, length));
}

/**
 * Noise with no repeated three-byte string, plus bytes 0-13 with Fibonacci counts that chain up with END_BLOCK's single count,
 * so the optimal literal codes run past 15 bits.
 */
function fibonacciLiterals(): Uint8Array {
	const length = 30000;
	const next = xorshift(5);
	const rare: number[] = [];
	let [current, following] = [1, 2];
	for (let symbol = 0; symbol < 14; symbol++) {
		for (let count = 0; count < current; count++) {
			rare.push(symbol);
		}
		[current, following] = [following, current + following];
	}
	const bytes: number[] = [];
	const seen = new Set<number>();
	while (bytes.length < length) {
		const index = bytes.length;
		const useRare = rare.length > 0 && next() % Math.max(1, Math.floor((length - index) / rare.length)) === 0;
		let value = 14 + (next() % 242);
		if (useRare) {
			value = rare.at(-1) ?? 0;
		}
		const trigram = ((bytes[index - 2] ?? 0) << 16) | ((bytes[index - 1] ?? 0) << 8) | value;
		if (seen.has(trigram)) {
			continue;
		}

		if (useRare) {
			rare.pop();
		}
		seen.add(trigram);
		bytes.push(value);
	}
	return Uint8Array.from(bytes);
}

const md5 = (bytes: Uint8Array): string => createHash('md5').update(bytes).digest('hex');

// Expected values are strlen() and md5() of gzdeflate() on the same input in the oracle's PHP 8 with zlib 1.3.1.
describe('zlibDeflateRaw', () => {
	it.each([
		['empty input', new Uint8Array(), 2, '598f4fe64aefab8f00bcbea4c9239abf'],
		['one byte', new Uint8Array([0x61]), 3, 'e266db42a8cd74035cfd93adeabf41e3'],
		['three bytes', new Uint8Array([0x61, 0x62, 0x63]), 5, 'c4b4d684e8f3223f0bb156c56f3af69e'],
		['a long run of one byte', new Uint8Array(300000).fill(0x61), 308, 'dc08c97b94fb95e03bdcc54f97509c92'],
	])('matches PHP for %s', (_name, input, length, hash) => {
		const output = zlibDeflateRaw(input);
		expect(output.length).toBe(length);
		expect(md5(output)).toBe(hash);
	});

	it('matches PHP on SQL-like text long enough to slide the window many times', () => {
		const input = sqlText(700000, 2);
		const output = zlibDeflateRaw(input);
		expect(output.length).toBe(38294);
		expect(md5(output)).toBe('91d3d584b0728c1b4febb82078749be1');
		expect(inflateRawSync(output).equals(input)).toBe(true);
	});

	it('matches PHP on incompressible bytes, which zlib sends as stored blocks', () => {
		const output = zlibDeflateRaw(noise(300000, 1));
		expect(output.length).toBe(300050);
		expect(md5(output)).toBe('e60ac4e604a5849c9390fab9869213d9');
	});

	it('matches PHP when text, noise and zeros alternate', () => {
		const input = new Uint8Array([...sqlText(40000, 3), ...noise(90000, 4), ...new Uint8Array(70000), ...sqlText(30000, 5)]);
		const output = zlibDeflateRaw(input);
		expect(output.length).toBe(96094);
		expect(md5(output)).toBe('d4d3893930d019f0f71efa4da3c85f7e');
	});

	it('matches PHP when code lengths overflow and zlib rebalances the tree', () => {
		const output = zlibDeflateRaw(fibonacciLiterals());
		expect(output.length).toBe(29788);
		expect(md5(output)).toBe('aa9bf12823c6d0c93688bff1e9247038');
	});

	it('matches PHP on short matches that fill the symbol buffer many times', () => {
		const next = xorshift(11);
		const output = zlibDeflateRaw(Uint8Array.from({ length: 1_000_000 }, () => 0x61 + (next() & 3)));
		expect(output.length).toBe(292705);
		expect(md5(output)).toBe('19526ed0fb3d95f035da73b58fb8824d');
	});
});

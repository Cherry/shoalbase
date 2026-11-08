/*
 * Altered from zlib 1.3 (deflate.c and trees.c): translated to TypeScript and reduced to the settings below.
 * This is not the original software.
 *
 * Copyright (C) 1995-2023 Jean-loup Gailly and Mark Adler
 *
 * This software is provided 'as-is', without any express or implied warranty. In no event will the authors be held liable
 * for any damages arising from the use of this software.
 *
 * Permission is granted to anyone to use this software for any purpose, including commercial applications, and to alter
 * it and redistribute it freely, subject to the following restrictions:
 *
 * 1. The origin of this software must not be misrepresented; you must not claim that you wrote the original software. If
 *    you use this software in a product, an acknowledgment in the product documentation would be appreciated but is not
 *    required.
 * 2. Altered source versions must be plainly marked as such, and must not be misrepresented as being the original software.
 * 3. This notice may not be removed or altered from any source distribution.
 */

// A port of zlib 1.3's deflate.c and trees.c at PHP's gzencode()/gzcompress() settings (level 6, memLevel 9, 32K window, one Z_FINISH call).
// The runtimes' own deflaters (Chromium's zlib in Node and workerd) pick different matches, so their bytes differ from what PHP sends.

const WSIZE = 32768;
const WMASK = WSIZE - 1;
const WINDOW_SIZE = 2 * WSIZE;
// memLevel 9 gives 16 hash bits, and the shift makes a hash forget a byte after MIN_MATCH updates.
const HASH_MASK = (1 << 16) - 1;
const HASH_SHIFT = 6;
const LIT_BUFSIZE = 1 << 15;
const MIN_MATCH = 3;
const MAX_MATCH = 258;
const MIN_LOOKAHEAD = MAX_MATCH + MIN_MATCH + 1;
const MAX_DIST = WSIZE - MIN_LOOKAHEAD;
const TOO_FAR = 4096;
// configuration_table[6]: good_length, max_lazy, nice_length, max_chain.
const GOOD_MATCH = 8;
const MAX_LAZY = 16;
const NICE_MATCH = 128;
const MAX_CHAIN = 128;

const LENGTH_CODES = 29;
const LITERALS = 256;
const L_CODES = LITERALS + 1 + LENGTH_CODES;
const D_CODES = 30;
const BL_CODES = 19;
const HEAP_SIZE = 2 * L_CODES + 1;
const MAX_BITS = 15;
const MAX_BL_BITS = 7;
const END_BLOCK = 256;
const REP_3_6 = 16;
const REPZ_3_10 = 17;
const REPZ_11_138 = 18;

const EXTRA_LBITS = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]);
const EXTRA_DBITS = new Uint8Array([0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]);
const EXTRA_BLBITS = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 7]);
const BL_ORDER = new Uint8Array([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);

// Trees store [freq or code, len or dad] pairs, as zlib's ct_data unions do.
const STATIC_LTREE = new Uint16Array((L_CODES + 2) * 2);
const STATIC_DTREE = new Uint16Array(D_CODES * 2);
const DIST_CODE = new Uint8Array(512);
const LENGTH_CODE = new Uint8Array(MAX_MATCH - MIN_MATCH + 1);
const BASE_LENGTH = new Uint16Array(LENGTH_CODES);
const BASE_DIST = new Uint16Array(D_CODES);

function bitReverse(code: number, length: number): number {
	let result = 0;
	for (let bit = 0; bit < length; bit++) {
		result = (result << 1) | ((code >>> bit) & 1);
	}
	return result;
}

/** gen_codes(): canonical codes from the bit lengths. */
function generateCodes(tree: Uint16Array, maxCode: number, blCount: Uint16Array): void {
	const nextCode = new Uint16Array(MAX_BITS + 1);
	let code = 0;
	for (let bits = 1; bits <= MAX_BITS; bits++) {
		code = (code + blCount[bits - 1]) << 1;
		nextCode[bits] = code;
	}
	for (let index = 0; index <= maxCode; index++) {
		const length = tree[index * 2 + 1];
		if (length !== 0) {
			tree[index * 2] = bitReverse(nextCode[length]++, length);
		}
	}
}

/** tr_static_init(). */
function initStaticTables(): void {
	let length = 0;
	let code = 0;
	for (; code < LENGTH_CODES - 1; code++) {
		BASE_LENGTH[code] = length;
		for (let count = 0; count < (1 << EXTRA_LBITS[code]); count++) {
			LENGTH_CODE[length++] = code;
		}
	}
	// Match length 258 has two encodings, and zlib uses the shorter code 285.
	LENGTH_CODE[length - 1] = code;
	let dist = 0;
	for (code = 0; code < 16; code++) {
		BASE_DIST[code] = dist;
		for (let count = 0; count < (1 << EXTRA_DBITS[code]); count++) {
			DIST_CODE[dist++] = code;
		}
	}
	dist >>= 7;
	for (; code < D_CODES; code++) {
		BASE_DIST[code] = dist << 7;
		for (let count = 0; count < (1 << (EXTRA_DBITS[code] - 7)); count++) {
			DIST_CODE[256 + dist++] = code;
		}
	}
	const blCount = new Uint16Array(MAX_BITS + 1);
	for (let index = 0; index < L_CODES + 2; index++) {
		let bits = 8;
		if (index >= 144 && index <= 255) {
			bits = 9;
		} else if (index >= 256 && index <= 279) {
			bits = 7;
		}
		STATIC_LTREE[index * 2 + 1] = bits;
		blCount[bits]++;
	}
	generateCodes(STATIC_LTREE, L_CODES + 1, blCount);
	for (let index = 0; index < D_CODES; index++) {
		STATIC_DTREE[index * 2 + 1] = 5;
		STATIC_DTREE[index * 2] = bitReverse(index, 5);
	}
}

initStaticTables();

/** d_code(): distances from 256 on share codes in steps of 128. */
function distCode(dist: number): number {
	if (dist < 256) {
		return DIST_CODE[dist];
	}
	return DIST_CODE[256 + (dist >>> 7)];
}

interface StaticDesc {
	tree: Uint16Array | null;
	extra: Uint8Array;
	base: number;
	elems: number;
	maxLength: number;
}

interface TreeDesc {
	tree: Uint16Array;
	stat: StaticDesc;
	maxCode: number;
}

class Deflater {
	private readonly input: Uint8Array;
	private nextIn = 0;
	private out = new Uint8Array(1024);
	private outLength = 0;

	private readonly window = new Uint8Array(WINDOW_SIZE);
	private readonly prev = new Uint16Array(WSIZE);
	private readonly head = new Uint16Array(HASH_MASK + 1);
	private insH = 0;
	private strstart = 0;
	private blockStart = 0;
	private lookahead = 0;
	private matchLength = MIN_MATCH - 1;
	private prevLength = MIN_MATCH - 1;
	private matchStart = 0;
	private prevMatch = 0;
	private matchAvailable = false;

	private readonly dynLtree = new Uint16Array(HEAP_SIZE * 2);
	private readonly dynDtree = new Uint16Array((2 * D_CODES + 1) * 2);
	private readonly blTree = new Uint16Array((2 * BL_CODES + 1) * 2);
	private readonly lDesc: TreeDesc = { tree: this.dynLtree, stat: { tree: STATIC_LTREE, extra: EXTRA_LBITS, base: LITERALS + 1, elems: L_CODES, maxLength: MAX_BITS }, maxCode: 0 };
	private readonly dDesc: TreeDesc = { tree: this.dynDtree, stat: { tree: STATIC_DTREE, extra: EXTRA_DBITS, base: 0, elems: D_CODES, maxLength: MAX_BITS }, maxCode: 0 };
	private readonly blDesc: TreeDesc = { tree: this.blTree, stat: { tree: null, extra: EXTRA_BLBITS, base: 0, elems: BL_CODES, maxLength: MAX_BL_BITS }, maxCode: 0 };
	private readonly heap = new Uint16Array(HEAP_SIZE);
	private heapLength = 0;
	private heapMax = 0;
	private readonly depth = new Uint16Array(HEAP_SIZE);
	private readonly blCount = new Uint16Array(MAX_BITS + 1);
	private optLength = 0;
	private staticLength = 0;
	private readonly symDist = new Uint16Array(LIT_BUFSIZE);
	private readonly symLc = new Uint8Array(LIT_BUFSIZE);
	private symNext = 0;
	private biBuf = 0;
	private biValid = 0;

	constructor(input: Uint8Array) {
		this.input = input;
		this.initBlock();
	}

	/** INSERT_STRING(): returns the previous head of the string's hash chain. */
	private insertString(position: number): number {
		this.insH = ((this.insH << HASH_SHIFT) ^ this.window[position + MIN_MATCH - 1]) & HASH_MASK;
		const head = this.head[this.insH];
		this.prev[position & WMASK] = head;
		this.head[this.insH] = position;
		return head;
	}

	/** fill_window(), sliding the upper half down when the window is full. */
	private fillWindow(): void {
		do {
			let more = WINDOW_SIZE - this.lookahead - this.strstart;
			if (this.strstart >= WSIZE + MAX_DIST) {
				this.window.copyWithin(0, WSIZE, WSIZE + WSIZE - more);
				this.matchStart -= WSIZE;
				this.strstart -= WSIZE;
				this.blockStart -= WSIZE;
				for (const table of [this.head, this.prev]) {
					for (let index = 0; index < table.length; index++) {
						table[index] = table[index] >= WSIZE ? table[index] - WSIZE : 0;
					}
				}
				more += WSIZE;
			}
			if (this.nextIn === this.input.length) {
				break;
			}
			const count = Math.min(this.input.length - this.nextIn, more);
			this.window.set(this.input.subarray(this.nextIn, this.nextIn + count), this.strstart + this.lookahead);
			this.nextIn += count;
			this.lookahead += count;
			if (this.lookahead >= MIN_MATCH) {
				this.insH = ((this.window[this.strstart] << HASH_SHIFT) ^ this.window[this.strstart + 1]) & HASH_MASK;
			}
		} while (this.lookahead < MIN_LOOKAHEAD && this.nextIn < this.input.length);
	}

	/** longest_match(): sets matchStart and returns the match length, capped at the lookahead. */
	private longestMatch(firstMatch: number): number {
		const window = this.window;
		let chainLength = MAX_CHAIN;
		let bestLength = this.prevLength;
		const niceMatch = Math.min(NICE_MATCH, this.lookahead);
		const limit = this.strstart > MAX_DIST ? this.strstart - MAX_DIST : 0;
		const strend = this.strstart + MAX_MATCH;
		let scanEnd1 = window[this.strstart + bestLength - 1];
		let scanEnd = window[this.strstart + bestLength];
		if (this.prevLength >= GOOD_MATCH) {
			chainLength >>= 2;
		}
		let curMatch = firstMatch;
		do {
			let match = curMatch;
			if (window[match + bestLength] !== scanEnd || window[match + bestLength - 1] !== scanEnd1
				|| window[match] !== window[this.strstart] || window[++match] !== window[this.strstart + 1]) {
				continue;
			}
			// The third bytes always match once the hashes and the first two bytes do.
			let scan = this.strstart + 2;
			match++;
			while (window[++scan] === window[++match] && scan < strend) {
				// Scanning only.
			}
			const length = MAX_MATCH - (strend - scan);
			if (length <= bestLength) {
				continue;
			}

			this.matchStart = curMatch;
			bestLength = length;
			if (length >= niceMatch) {
				break;
			}
			scanEnd1 = window[this.strstart + bestLength - 1];
			scanEnd = window[this.strstart + bestLength];
		} while ((curMatch = this.prev[curMatch & WMASK]) > limit && --chainLength !== 0);
		return Math.min(bestLength, this.lookahead);
	}

	/** _tr_tally(): records a literal (dist 0) or a match, and reports a full symbol buffer. */
	private tally(dist: number, lc: number): boolean {
		this.symDist[this.symNext] = dist;
		this.symLc[this.symNext] = lc;
		this.symNext++;
		if (dist === 0) {
			this.dynLtree[lc * 2]++;
		} else {
			this.dynLtree[(LENGTH_CODE[lc] + LITERALS + 1) * 2]++;
			this.dynDtree[distCode(dist - 1) * 2]++;
		}
		return this.symNext === LIT_BUFSIZE - 1;
	}

	/** FLUSH_BLOCK(): a stored block is only possible while the block's bytes are still in the window. */
	private flushBlock(last: boolean): void {
		this.trFlushBlock(this.blockStart >= 0 ? this.blockStart : -1, this.strstart - this.blockStart, last);
		this.blockStart = this.strstart;
	}

	private initBlock(): void {
		this.dynLtree.fill(0, 0, L_CODES * 2);
		this.dynDtree.fill(0, 0, D_CODES * 2);
		this.blTree.fill(0, 0, BL_CODES * 2);
		this.dynLtree[END_BLOCK * 2] = 1;
		this.optLength = 0;
		this.staticLength = 0;
		this.symNext = 0;
	}

	private putByte(byte: number): void {
		if (this.outLength === this.out.length) {
			const grown = new Uint8Array(this.out.length * 2);
			grown.set(this.out);
			this.out = grown;
		}
		this.out[this.outLength++] = byte;
	}

	private putShort(value: number): void {
		this.putByte(value & 0xFF);
		this.putByte((value >>> 8) & 0xFF);
	}

	private sendBits(value: number, length: number): void {
		this.biBuf |= (value << this.biValid) & 0xFF_FF;
		if (this.biValid > 16 - length) {
			this.putShort(this.biBuf);
			this.biBuf = value >> (16 - this.biValid);
			this.biValid += length - 16;
		} else {
			this.biValid += length;
		}
	}

	private sendCode(code: number, tree: Uint16Array): void {
		this.sendBits(tree[code * 2], tree[code * 2 + 1]);
	}

	private biWindup(): void {
		if (this.biValid > 8) {
			this.putShort(this.biBuf);
		} else if (this.biValid > 0) {
			this.putByte(this.biBuf);
		}
		this.biBuf = 0;
		this.biValid = 0;
	}

	private smaller(tree: Uint16Array, left: number, right: number): boolean {
		return tree[left * 2] < tree[right * 2] || (tree[left * 2] === tree[right * 2] && this.depth[left] <= this.depth[right]);
	}

	private heapDown(tree: Uint16Array, start: number): void {
		const value = this.heap[start];
		let node = start;
		let child = node << 1;
		while (child <= this.heapLength) {
			if (child < this.heapLength && this.smaller(tree, this.heap[child + 1], this.heap[child])) {
				child++;
			}
			if (this.smaller(tree, value, this.heap[child])) {
				break;
			}
			this.heap[node] = this.heap[child];
			node = child;
			child <<= 1;
		}
		this.heap[node] = value;
	}

	/** gen_bitlen(): optimal bit lengths, limited to the tree's maximum the way zlib redistributes overflow. */
	private generateBitLengths(desc: TreeDesc): void {
		const { tree, maxCode, stat } = desc;
		this.blCount.fill(0);
		tree[this.heap[this.heapMax] * 2 + 1] = 0;
		let overflow = 0;
		let index = this.heapMax + 1;
		for (; index < HEAP_SIZE; index++) {
			const node = this.heap[index];
			let bits = tree[tree[node * 2 + 1] * 2 + 1] + 1;
			if (bits > stat.maxLength) {
				bits = stat.maxLength;
				overflow++;
			}
			tree[node * 2 + 1] = bits;
			if (node > maxCode) {
				continue;
			}
			this.blCount[bits]++;
			const extraBits = node >= stat.base ? stat.extra[node - stat.base] : 0;
			const frequency = tree[node * 2];
			this.optLength += frequency * (bits + extraBits);
			if (stat.tree) {
				this.staticLength += frequency * (stat.tree[node * 2 + 1] + extraBits);
			}
		}
		if (overflow === 0) {
			return;
		}
		do {
			let bits = stat.maxLength - 1;
			while (this.blCount[bits] === 0) {
				bits--;
			}
			this.blCount[bits]--;
			this.blCount[bits + 1] += 2;
			this.blCount[stat.maxLength]--;
			overflow -= 2;
		} while (overflow > 0);
		for (let bits = stat.maxLength; bits !== 0; bits--) {
			let count = this.blCount[bits];
			while (count !== 0) {
				const node = this.heap[--index];
				if (node > maxCode) {
					continue;
				}

				if (tree[node * 2 + 1] !== bits) {
					this.optLength += (bits - tree[node * 2 + 1]) * tree[node * 2];
					tree[node * 2 + 1] = bits;
				}
				count--;
			}
		}
	}

	/** build_tree(). */
	private buildTree(desc: TreeDesc): void {
		const { tree, stat } = desc;
		let maxCode = -1;
		this.heapLength = 0;
		this.heapMax = HEAP_SIZE;
		for (let index = 0; index < stat.elems; index++) {
			if (tree[index * 2] === 0) {
				tree[index * 2 + 1] = 0;
			} else {
				this.heap[++this.heapLength] = index;
				maxCode = index;
				this.depth[index] = 0;
			}
		}
		// zlib forces at least two codes of non-zero frequency, since a single code would get a zero bit length.
		while (this.heapLength < 2) {
			let node = 0;
			if (maxCode < 2) {
				node = ++maxCode;
			}
			this.heap[++this.heapLength] = node;
			tree[node * 2] = 1;
			this.depth[node] = 0;
			this.optLength--;
			// Only the bit-length tree has no static tree, and its codes always include two used ones, so this padding never runs for it.
			/* v8 ignore else -- @preserve */
			if (stat.tree) {
				this.staticLength -= stat.tree[node * 2 + 1];
			}
		}
		desc.maxCode = maxCode;
		for (let index = this.heapLength >> 1; index >= 1; index--) {
			this.heapDown(tree, index);
		}
		let node = stat.elems;
		do {
			const first = this.heap[1];
			this.heap[1] = this.heap[this.heapLength--];
			this.heapDown(tree, 1);
			const second = this.heap[1];
			this.heap[--this.heapMax] = first;
			this.heap[--this.heapMax] = second;
			tree[node * 2] = tree[first * 2] + tree[second * 2];
			this.depth[node] = Math.max(this.depth[first], this.depth[second]) + 1;
			tree[first * 2 + 1] = node;
			tree[second * 2 + 1] = node;
			this.heap[1] = node++;
			this.heapDown(tree, 1);
		} while (this.heapLength >= 2);
		this.heap[--this.heapMax] = this.heap[1];
		this.generateBitLengths(desc);
		generateCodes(tree, maxCode, this.blCount);
	}

	/** scan_tree() when counting is set, send_tree() otherwise: the run-length coding of a tree's bit lengths. */
	private walkTree(tree: Uint16Array, maxCode: number, counting: boolean): void {
		let previous = -1;
		let next = tree[1];
		let count = 0;
		let maxCount = 7;
		let minCount = 4;
		if (next === 0) {
			maxCount = 138;
			minCount = 3;
		}
		if (counting) {
			tree[(maxCode + 1) * 2 + 1] = 0xFF_FF;
		}
		for (let index = 0; index <= maxCode; index++) {
			const current = next;
			next = tree[(index + 1) * 2 + 1];
			if (++count < maxCount && current === next) {
				continue;
			}
			if (count < minCount) {
				if (counting) {
					this.blTree[current * 2] += count;
				} else {
					for (; count > 0; count--) {
						this.sendCode(current, this.blTree);
					}
				}
			} else if (current !== 0) {
				if (current !== previous) {
					this.emitLength(counting, current);
					count--;
				}
				this.emitRepeat(counting, REP_3_6, count - 3, 2);
			} else if (count <= 10) {
				this.emitRepeat(counting, REPZ_3_10, count - 3, 3);
			} else {
				this.emitRepeat(counting, REPZ_11_138, count - 11, 7);
			}
			count = 0;
			previous = current;
			if (next === 0) {
				maxCount = 138;
				minCount = 3;
			} else if (current === next) {
				maxCount = 6;
				minCount = 3;
			} else {
				maxCount = 7;
				minCount = 4;
			}
		}
	}

	private emitLength(counting: boolean, length: number): void {
		if (counting) {
			this.blTree[length * 2]++;
		} else {
			this.sendCode(length, this.blTree);
		}
	}

	private emitRepeat(counting: boolean, code: number, extra: number, extraBits: number): void {
		if (counting) {
			this.blTree[code * 2]++;
		} else {
			this.sendCode(code, this.blTree);
			this.sendBits(extra, extraBits);
		}
	}

	/** build_bl_tree(): returns the index in BL_ORDER of the last bit length code to send. */
	private buildBlTree(): number {
		this.walkTree(this.dynLtree, this.lDesc.maxCode, true);
		this.walkTree(this.dynDtree, this.dDesc.maxCode, true);
		this.buildTree(this.blDesc);
		let maxIndex = BL_CODES - 1;
		while (maxIndex >= 3 && this.blTree[BL_ORDER[maxIndex] * 2 + 1] === 0) {
			maxIndex--;
		}
		this.optLength += 3 * (maxIndex + 1) + 5 + 5 + 4;
		return maxIndex;
	}

	private compressBlock(ltree: Uint16Array, dtree: Uint16Array): void {
		for (let index = 0; index < this.symNext; index++) {
			let dist = this.symDist[index];
			let lc = this.symLc[index];
			if (dist === 0) {
				this.sendCode(lc, ltree);
			} else {
				let code = LENGTH_CODE[lc];
				this.sendCode(code + LITERALS + 1, ltree);
				if (EXTRA_LBITS[code] !== 0) {
					lc -= BASE_LENGTH[code];
					this.sendBits(lc, EXTRA_LBITS[code]);
				}
				dist--;
				code = distCode(dist);
				this.sendCode(code, dtree);
				if (EXTRA_DBITS[code] !== 0) {
					dist -= BASE_DIST[code];
					this.sendBits(dist, EXTRA_DBITS[code]);
				}
			}
		}
		this.sendCode(END_BLOCK, ltree);
	}

	/** _tr_flush_block(): emits the block as stored, static or dynamic, whichever is smallest. */
	private trFlushBlock(buffer: number, storedLength: number, last: boolean): void {
		const lastBit = last ? 1 : 0;
		this.buildTree(this.lDesc);
		this.buildTree(this.dDesc);
		const maxBlIndex = this.buildBlTree();
		let optBytes = (this.optLength + 3 + 7) >>> 3;
		const staticBytes = (this.staticLength + 3 + 7) >>> 3;
		if (staticBytes <= optBytes) {
			optBytes = staticBytes;
		}
		if (storedLength + 4 <= optBytes && buffer !== -1) {
			this.sendBits(lastBit, 3);
			this.biWindup();
			this.putShort(storedLength);
			this.putShort(~storedLength);
			for (let index = buffer; index < buffer + storedLength; index++) {
				this.putByte(this.window[index]);
			}
		} else if (staticBytes === optBytes) {
			this.sendBits(2 + lastBit, 3);
			this.compressBlock(STATIC_LTREE, STATIC_DTREE);
		} else {
			this.sendBits(4 + lastBit, 3);
			this.sendBits(this.lDesc.maxCode + 1 - 257, 5);
			this.sendBits(this.dDesc.maxCode + 1 - 1, 5);
			this.sendBits(maxBlIndex + 1 - 4, 4);
			for (let rank = 0; rank <= maxBlIndex; rank++) {
				this.sendBits(this.blTree[BL_ORDER[rank] * 2 + 1], 3);
			}
			this.walkTree(this.dynLtree, this.lDesc.maxCode, false);
			this.walkTree(this.dynDtree, this.dDesc.maxCode, false);
			this.compressBlock(this.dynLtree, this.dynDtree);
		}
		this.initBlock();
		if (last) {
			this.biWindup();
		}
	}

	/** deflate(strm, Z_FINISH) with enough output space, which runs deflate_slow() to the end. */
	run(): Uint8Array {
		for (;;) {
			if (this.lookahead < MIN_LOOKAHEAD) {
				this.fillWindow();
				if (this.lookahead === 0) {
					break;
				}
			}
			let hashHead = 0;
			if (this.lookahead >= MIN_MATCH) {
				hashHead = this.insertString(this.strstart);
			}
			this.prevLength = this.matchLength;
			this.prevMatch = this.matchStart;
			this.matchLength = MIN_MATCH - 1;
			if (hashHead !== 0 && this.prevLength < MAX_LAZY && this.strstart - hashHead <= MAX_DIST) {
				this.matchLength = this.longestMatch(hashHead);
				// A length-3 match that far back costs more bits than three literals.
				if (this.matchLength === MIN_MATCH && this.strstart - this.matchStart > TOO_FAR) {
					this.matchLength = MIN_MATCH - 1;
				}
			}
			if (this.prevLength >= MIN_MATCH && this.matchLength <= this.prevLength) {
				const maxInsert = this.strstart + this.lookahead - MIN_MATCH;
				const flush = this.tally(this.strstart - 1 - this.prevMatch, this.prevLength - MIN_MATCH);
				this.lookahead -= this.prevLength - 1;
				for (let remaining = this.prevLength - 2; remaining > 0; remaining--) {
					if (++this.strstart <= maxInsert) {
						this.insertString(this.strstart);
					}
				}
				this.matchAvailable = false;
				this.matchLength = MIN_MATCH - 1;
				this.strstart++;
				if (flush) {
					this.flushBlock(false);
				}
			} else if (this.matchAvailable) {
				if (this.tally(0, this.window[this.strstart - 1])) {
					this.flushBlock(false);
				}
				this.strstart++;
				this.lookahead--;
			} else {
				this.matchAvailable = true;
				this.strstart++;
				this.lookahead--;
			}
		}
		if (this.matchAvailable) {
			this.tally(0, this.window[this.strstart - 1]);
		}
		this.flushBlock(true);
		return this.out.subarray(0, this.outLength);
	}
}

/** Raw DEFLATE bytes identical to PHP's gzdeflate() at the default level. */
export function zlibDeflateRaw(bytes: Uint8Array): Uint8Array {
	return new Deflater(bytes).run();
}

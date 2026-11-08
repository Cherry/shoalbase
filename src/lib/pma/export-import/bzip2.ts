// A bzip2 decoder for .bz2 imports, which the PHP image reads with bzread(): Huffman and MTF decoding, inverse BWT and the run-length stage.

const BLOCK_MAGIC = 0x31_41_59_26_53_59;
const END_MAGIC = 0x17_72_45_38_50_90;
const GROUP_SIZE = 50;
const MAX_CODE_LENGTH = 20;

class Bzip2Error extends Error {}

/** Reads bits most significant first. */
class BitReader {
	private position = 0;

	constructor(private readonly bytes: Uint8Array) {}

	bits(count: number): number {
		let result = 0;
		for (let index = 0; index < count; index++) {
			const byte = this.bytes[this.position >>> 3];
			if (byte === undefined) {
				throw new Bzip2Error('unexpected end of data');
			}
			result = (result * 2) + ((byte >>> (7 - (this.position & 7))) & 1);
			this.position++;
		}
		return result;
	}
}

interface HuffmanTable {
	minLength: number;
	maxLength: number;
	limit: number[];
	base: number[];
	perm: number[];
}

// hbCreateDecodeTables() of the reference implementation.
function huffmanTable(lengths: number[]): HuffmanTable {
	const minLength = Math.min(...lengths);
	const maxLength = Math.max(...lengths);
	const perm: number[] = [];
	for (let length = minLength; length <= maxLength; length++) {
		for (const [symbol, symbolLength] of lengths.entries()) {
			if (symbolLength === length) {
				perm.push(symbol);
			}
		}
	}
	const base = Array.from({ length: MAX_CODE_LENGTH + 2 }, () => 0);
	for (const length of lengths) {
		base[length + 1]++;
	}
	for (let index = 1; index < base.length; index++) {
		base[index] += base[index - 1];
	}
	const limit = Array.from({ length: MAX_CODE_LENGTH + 1 }, () => 0);
	let code = 0;
	for (let length = minLength; length <= maxLength; length++) {
		code += base[length + 1] - base[length];
		limit[length] = code - 1;
		code *= 2;
	}
	for (let length = minLength + 1; length <= maxLength; length++) {
		base[length] = ((limit[length - 1] + 1) * 2) - base[length];
	}
	return { minLength, maxLength, limit, base, perm };
}

function decodeSymbol(reader: BitReader, table: HuffmanTable): number {
	let length = table.minLength;
	let code = reader.bits(length);
	while (code > table.limit[length]) {
		length++;
		if (length > table.maxLength) {
			throw new Bzip2Error('bad Huffman code');
		}
		code = (code * 2) + reader.bits(1);
	}
	return table.perm[code - table.base[length]];
}

// The symbol map: which byte values occur in the block.
function readSymbols(reader: BitReader): number[] {
	const used = reader.bits(16);
	const symbols: number[] = [];
	for (let high = 0; high < 16; high++) {
		if ((used & (0x80_00 >>> high)) === 0) {
			continue;
		}
		const low = reader.bits(16);
		for (let bit = 0; bit < 16; bit++) {
			if ((low & (0x80_00 >>> bit)) !== 0) {
				symbols.push((high * 16) + bit);
			}
		}
	}
	if (symbols.length === 0) {
		throw new Bzip2Error('empty symbol map');
	}
	return symbols;
}

// The Huffman tables of a block and which table each group of 50 symbols uses.
function readTables(reader: BitReader, alphabetSize: number): { tables: HuffmanTable[]; selectors: number[]; } {
	const groups = reader.bits(3);
	const selectorCount = reader.bits(15);
	if (groups < 2 || groups > 6 || selectorCount === 0) {
		throw new Bzip2Error('bad table header');
	}
	const order = Array.from({ length: groups }, (_, index) => index);
	const selectors: number[] = [];
	for (let index = 0; index < selectorCount; index++) {
		let position = 0;
		while (reader.bits(1) === 1) {
			position++;
			if (position >= groups) {
				throw new Bzip2Error('bad selector');
			}
		}
		const [group] = order.splice(position, 1);
		order.unshift(group);
		selectors.push(group);
	}
	const tables: HuffmanTable[] = [];
	for (let group = 0; group < groups; group++) {
		const lengths: number[] = [];
		let length = reader.bits(5);
		for (let symbol = 0; symbol < alphabetSize; symbol++) {
			for (;;) {
				if (length < 1 || length > MAX_CODE_LENGTH) {
					throw new Bzip2Error('bad code length');
				}
				if (reader.bits(1) === 0) {
					break;
				}
				length += reader.bits(1) === 1 ? -1 : 1;
			}
			lengths.push(length);
		}
		tables.push(huffmanTable(lengths));
	}
	return { tables, selectors };
}

// The inverse Burrows-Wheeler transform, with the links packed above each byte as the reference does.
function inverseBwt(block: number[], origin: number): number[] {
	const starts = Array.from({ length: 256 }, () => 0);
	for (const byte of block) {
		starts[byte]++;
	}
	let sum = 0;
	for (let byte = 0; byte < 256; byte++) {
		const count = starts[byte];
		starts[byte] = sum;
		sum += count;
	}
	const links = Uint32Array.from(block);
	for (const [index, byte] of block.entries()) {
		links[starts[byte]] |= index << 8;
		starts[byte]++;
	}
	const output: number[] = [];
	let position = links[origin] >>> 8;
	for (let index = 0; index < block.length; index++) {
		position = links[position];
		output.push(position & 0xFF);
		position >>>= 8;
	}
	return output;
}

/** One block: the bytes before the final run-length stage, or null at the end of the stream. */
function readBlock(reader: BitReader, blockSize: number): number[] | null {
	const magic = (reader.bits(24) * 0x1_00_00_00) + reader.bits(24);
	if (magic === END_MAGIC) {
		return null;
	}
	if (magic !== BLOCK_MAGIC) {
		throw new Bzip2Error('bad block header');
	}
	reader.bits(32);
	if (reader.bits(1) === 1) {
		throw new Bzip2Error('randomised blocks are not supported');
	}
	const origin = reader.bits(24);
	const symbols = readSymbols(reader);
	const alphabetSize = symbols.length + 2;
	const { tables, selectors } = readTables(reader, alphabetSize);
	const moveToFront = symbols.map((_, index) => index);
	const block: number[] = [];
	let groupLeft = 0;
	let groupIndex = -1;
	let table = tables[0];
	let run = 0;
	let runWeight = 1;
	for (;;) {
		if (groupLeft === 0) {
			groupIndex++;
			if (groupIndex >= selectors.length) {
				throw new Bzip2Error('ran out of selectors');
			}
			table = tables[selectors[groupIndex]];
			groupLeft = GROUP_SIZE;
		}
		groupLeft--;
		const symbol = decodeSymbol(reader, table);
		// RUNA and RUNB spell a run length of the front symbol in bijective base 2.
		if (symbol <= 1) {
			run += runWeight * (symbol + 1);
			runWeight *= 2;
			continue;
		}
		if (run > 0) {
			// Stopping one past the block size keeps a hostile run from filling memory; the size check below rejects it.
			for (let copy = 0; copy < run && block.length <= blockSize; copy++) {
				block.push(symbols[moveToFront[0]]);
			}
			run = 0;
			runWeight = 1;
		}
		if (symbol === alphabetSize - 1) {
			break;
		}
		const [front] = moveToFront.splice(symbol - 1, 1);
		moveToFront.unshift(front);
		block.push(symbols[front]);
	}
	if (origin >= block.length || block.length > blockSize) {
		throw new Bzip2Error('bad block');
	}
	return inverseBwt(block, origin);
}

/** bzread() of the whole file: the first stream, up to any corruption, as libbz2 delivers it. */
export function bunzip2(bytes: Uint8Array): Uint8Array {
	const output: number[] = [];
	try {
		const reader = new BitReader(bytes);
		if (reader.bits(24) !== 0x42_5A_68) {
			throw new Bzip2Error('not bzip2 data');
		}
		const level = reader.bits(8) - 0x30;
		if (level < 1 || level > 9) {
			throw new Bzip2Error('bad block size');
		}
		for (let block = readBlock(reader, level * 100000); block !== null; block = readBlock(reader, level * 100000)) {
			// Four equal bytes are followed by how many more copies of that byte follow.
			let last = -1;
			let same = 0;
			for (const byte of block) {
				if (same === 4) {
					for (let copy = 0; copy < byte; copy++) {
						output.push(last);
					}
					same = 0;
					last = -1;
					continue;
				}
				output.push(byte);
				if (byte === last) {
					same++;
				} else {
					last = byte;
					same = 1;
				}
			}
		}
	} catch {
		// Corrupt data ends the output, as bzread() stops returning data on an error.
	}
	return Uint8Array.from(output);
}

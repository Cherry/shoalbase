// PHP's password_hash($value, PASSWORD_DEFAULT): bcrypt with cost 10 and the $2y$ prefix, for the PHP_PASSWORD_HASH insert function.

const BCRYPT_ALPHABET = './ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const MAGIC = new TextEncoder().encode('OrpheanBeholderScryDoubt');
const WORDS = 18 + (4 * 256);

let piWords: Uint32Array | undefined;

/** Blowfish's P-array and S-boxes are the hexadecimal digits of pi; computing them on first use keeps 4 KB of constants out of the bundle. */
function blowfishConstants(): Uint32Array {
	if (piWords !== undefined) {
		return piWords;
	}
	const bits = BigInt((WORDS * 32) + 64);
	const one = 1n << bits;
	// Machin: pi = 16 atan(1/5) - 4 atan(1/239).
	const arctanInverse = (x: bigint): bigint => {
		let sum = 0n;
		let term = one / x;
		const square = x * x;
		for (let divisor = 1n; term !== 0n; divisor += 2n) {
			sum += (divisor % 4n === 1n ? term : -term) / divisor;
			term /= square;
		}
		return sum;
	};
	const pi = (16n * arctanInverse(5n)) - (4n * arctanInverse(239n));
	let fraction = pi - (3n << bits);
	const words = new Uint32Array(WORDS);
	for (let index = 0; index < WORDS; index++) {
		fraction <<= 32n;
		words[index] = Number(fraction >> bits);
		fraction &= one - 1n;
	}
	piWords = words;
	return words;
}

/** Reads the next 32-bit word of a key or salt, wrapping around its end. */
function streamWord(data: Uint8Array, position: { value: number; }): number {
	let word = 0;
	for (let index = 0; index < 4; index++) {
		word = ((word << 8) | data[position.value]) >>> 0;
		position.value = (position.value + 1) % data.length;
	}
	return word;
}

class Blowfish {
	readonly pArray: Uint32Array;
	readonly sBoxes: Uint32Array;

	constructor() {
		const constants = blowfishConstants();
		this.pArray = constants.slice(0, 18);
		this.sBoxes = constants.slice(18);
	}

	private feistel(x: number): number {
		const boxes = this.sBoxes;
		return ((((boxes[x >>> 24] + boxes[256 | ((x >>> 16) & 0xFF)]) ^ boxes[512 | ((x >>> 8) & 0xFF)]) >>> 0) + boxes[768 | (x & 0xFF)]) >>> 0;
	}

	private mixKey(key: Uint8Array): void {
		const position = { value: 0 };
		for (let index = 0; index < 18; index++) {
			this.pArray[index] = (this.pArray[index] ^ streamWord(key, position)) >>> 0;
		}
	}

	private fill(salt: Uint8Array | null): void {
		const block = new Uint32Array(2);
		const position = { value: 0 };
		const next = (): void => {
			if (salt !== null) {
				block[0] ^= streamWord(salt, position);
				block[1] ^= streamWord(salt, position);
			}
			this.encrypt(block, 0);
		};
		for (let index = 0; index < 18; index += 2) {
			next();
			this.pArray[index] = block[0];
			this.pArray[index + 1] = block[1];
		}
		for (let index = 0; index < 1024; index += 2) {
			next();
			this.sBoxes[index] = block[0];
			this.sBoxes[index + 1] = block[1];
		}
	}

	encrypt(block: Uint32Array, offset: number): void {
		let left = block[offset];
		let right = block[offset + 1];
		for (let round = 0; round < 16; round += 2) {
			left ^= this.pArray[round];
			right ^= this.feistel(left);
			right ^= this.pArray[round + 1];
			left ^= this.feistel(right);
		}
		block[offset] = (right ^ this.pArray[17]) >>> 0;
		block[offset + 1] = (left ^ this.pArray[16]) >>> 0;
	}

	/** ExpandKey(state, salt, key). */
	expand(key: Uint8Array, salt: Uint8Array | null): void {
		this.mixKey(key);
		this.fill(salt);
	}
}

function encodeBase64(bytes: Uint8Array, length: number): string {
	let output = '';
	let index = 0;
	while (index < length) {
		let c1 = bytes[index++];
		output += BCRYPT_ALPHABET[(c1 >> 2) & 0x3F];
		c1 = (c1 & 0x03) << 4;
		if (index >= length) {
			output += BCRYPT_ALPHABET[c1 & 0x3F];
			break;
		}
		let c2 = bytes[index++];
		c1 |= (c2 >> 4) & 0x0F;
		output += BCRYPT_ALPHABET[c1 & 0x3F];
		c1 = (c2 & 0x0F) << 2;
		if (index >= length) {
			output += BCRYPT_ALPHABET[c1 & 0x3F];
			break;
		}
		c2 = bytes[index++];
		c1 |= (c2 >> 6) & 0x03;
		output += BCRYPT_ALPHABET[c1 & 0x3F] + BCRYPT_ALPHABET[c2 & 0x3F];
	}
	return output;
}

/** Decodes the 22 salt characters into its 16 bytes: five full 4-character groups, then one byte from the last two. */
function decodeSalt(text: string): Uint8Array {
	const bytes = new Uint8Array(16);
	const value = (index: number): number => BCRYPT_ALPHABET.indexOf(text.charAt(index));
	let offset = 0;
	let index = 0;
	while (offset < 15) {
		const c1 = value(index++);
		const c2 = value(index++);
		const c3 = value(index++);
		const c4 = value(index++);
		bytes[offset++] = ((c1 << 2) | ((c2 & 0x30) >> 4)) & 0xFF;
		bytes[offset++] = (((c2 & 0x0F) << 4) | ((c3 & 0x3C) >> 2)) & 0xFF;
		bytes[offset++] = (((c3 & 0x03) << 6) | c4) & 0xFF;
	}
	bytes[15] = ((value(index) << 2) | ((value(index + 1) & 0x30) >> 4)) & 0xFF;
	return bytes;
}

/** crypt() with a $2a$/$2y$ setting string: "$2y$" + cost + "$" + 22 salt characters. */
export function bcryptCrypt(password: string, setting: string): string {
	const match = /^\$2([aby])\$(\d{2})\$([./A-Za-z0-9]{22})/.exec(setting);
	if (!match) {
		throw new Error('Invalid bcrypt setting');
	}
	const cost = Number(match[2]);
	const saltText = match[3];
	const salt = decodeSalt(saltText);
	const passwordBytes = new TextEncoder().encode(password);
	const key = new Uint8Array(Math.min(passwordBytes.length + 1, 72));
	key.set(passwordBytes.subarray(0, key.length));

	const state = new Blowfish();
	state.expand(key, salt);
	for (let round = 0; round < 2 ** cost; round++) {
		state.expand(key, null);
		state.expand(salt, null);
	}

	const text = new Uint32Array(6);
	for (let index = 0; index < 6; index++) {
		for (let byte = 0; byte < 4; byte++) {
			text[index] = ((text[index] << 8) | MAGIC[(index * 4) + byte]) >>> 0;
		}
	}
	for (let round = 0; round < 64; round++) {
		for (let index = 0; index < 6; index += 2) {
			state.encrypt(text, index);
		}
	}
	const output = new Uint8Array(24);
	for (let index = 0; index < 6; index++) {
		output[index * 4] = text[index] >>> 24;
		output[(index * 4) + 1] = (text[index] >>> 16) & 0xFF;
		output[(index * 4) + 2] = (text[index] >>> 8) & 0xFF;
		output[(index * 4) + 3] = text[index] & 0xFF;
	}
	// The salt is re-encoded so its unused low bits come out as zero, as crypt_blowfish does.
	return `$2${match[1]}$${match[2]}$${encodeBase64(salt, 16)}${encodeBase64(output, 23)}`;
}

/** password_hash($password, PASSWORD_DEFAULT). */
export function bcryptHash(password: string, cost = 10): string {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	return bcryptCrypt(password, `$2y$${String(cost).padStart(2, '0')}$${encodeBase64(salt, 16)}`);
}

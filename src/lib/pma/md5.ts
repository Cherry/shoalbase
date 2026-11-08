// PHP's md5() over the UTF-8 bytes of a string, which WebCrypto does not offer.

const SHIFTS = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const CONSTANTS = Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 2 ** 32) >>> 0);

function padded(input: Uint8Array): DataView {
	const length = Math.ceil((input.length + 9) / 64) * 64;
	const bytes = new Uint8Array(length);
	bytes.set(input);
	bytes[input.length] = 0x80;
	const view = new DataView(bytes.buffer);
	const bits = input.length * 8;
	view.setUint32(length - 8, bits >>> 0, true);
	view.setUint32(length - 4, Math.floor(bits / 2 ** 32), true);
	return view;
}

/** The auxiliary function F, G, H or I of a round, and which message word it reads. */
function roundInput(round: number, [, second, third, fourth]: number[]): [number, number] {
	if (round < 16) {
		return [(second & third) | (~second & fourth), round];
	}
	if (round < 32) {
		return [(fourth & second) | (~fourth & third), (5 * round + 1) % 16];
	}
	if (round < 48) {
		return [second ^ third ^ fourth, (3 * round + 5) % 16];
	}
	return [third ^ (second | ~fourth), (7 * round) % 16];
}

/** md5(): the lowercase hex digest. */
export function md5(value: string): string {
	const view = padded(new TextEncoder().encode(value));
	const state = [0x67_45_23_01, 0xEF_CD_AB_89, 0x98_BA_DC_FE, 0x10_32_54_76];
	for (let offset = 0; offset < view.byteLength; offset += 64) {
		const words = [...state];
		for (let round = 0; round < 64; round++) {
			const [mixed, word] = roundInput(round, words);
			const sum = (words[0] + mixed + CONSTANTS[round] + view.getUint32(offset + word * 4, true)) >>> 0;
			const shift = SHIFTS[(Math.floor(round / 16) * 4) + (round % 4)];
			const rotated = (words[1] + ((sum << shift) | (sum >>> (32 - shift)))) >>> 0;
			words.splice(0, 4, words[3], rotated, words[1], words[2]);
		}
		for (let index = 0; index < 4; index++) {
			state[index] = (state[index] + words[index]) >>> 0;
		}
	}
	const out = new DataView(new ArrayBuffer(16));
	for (const [index, word] of state.entries()) {
		out.setUint32(index * 4, word, true);
	}
	return Array.from(new Uint8Array(out.buffer, out.byteOffset, out.byteLength), byte => byte.toString(16).padStart(2, '0')).join('');
}

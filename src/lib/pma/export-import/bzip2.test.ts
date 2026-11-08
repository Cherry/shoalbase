import { describe, expect, it } from 'vitest';

import { bunzip2 } from './bzip2.ts';
import { md5 } from '../md5.ts';

// Streams made by PHP bzcompress() in the oracle container.
const SMALL = 'QlpoNDFBWSZTWTmXNO8AAA1fgAAQQGQwCDolnwCHI0TAIABIaoyGamNTJk8oADVNGTATAEaD1HCmXdTYrKldGXhmLxmpTnhZKLidnoCSAWD3Ni3kXHeR8K6jc+noIEcEPxdyRThQkDmXNO8=';
const RUNS = 'QlpoOTFBWSZTWY2L1HEAAAGAgYBwAIAACCAAISTT0GaBn0ItDC7kinChIRsXqOI=';
// 5000 lines (114450 bytes) at level 1, which the first run-length stage brings under one 100k block.
const BLOCKS = 'QlpoMTFBWSZTWcvelPkAdB5ZgAAQQAB/4CAAkIBgF1898tGWmW1tNtLRlo1iyyZaywCy1mhpVA2YAbYAY2AMbALGAGzTMFlACmAAmhTAATQpgAJoIqnpVP3pP9VVABNVVT2akf+pVQAUqVUD/e1VSZNPyIVHhCo/YhUf3P8nk9Pp00/E/2fmfqfqdNPTTTTTSSSTqSSYkkkkkkkmpJNl4ssssssuLLLLL1ZZZZZerLLLLLiyyyy8WWUkkkmpJJJiSSSSSSSdWmnppppppppp0yaaaSSSSSSSdSEkxJJJJJJJPkk8SSSSSSSSTqSSYkkkkkkkmpJJJxJJJJJsuLLLLL1ZZZZZerLLLLLiyyyy8WWWWWWX1ZZSYkkkkkkknUkk8SSSSWmmmnTJppppppppppqQkknEkkkkkk+STxJJJJJJJJOpJJiSSSSSSSfVlll4ssssssuLLLLL1ZZZZZerLLLLLiyyyy8SSSSSSTUkkkxJJJJJNNPppp6aaaaaaaadMmWWWWWWWWWXFpZZZerGmmmnTT000000000+mSTEkkkkkkk1JJJOJJJllllxZZZZerLLLLL1YSSSSepJJJJxJJJJJJNSSSTEkkkkkkk6kkniSaaaaaaadMmmmmmmmmWWXq0ssssuLLLLL9WX8EkkkkkkknUkkxJJJJJZZfVlll4ssssssuLLLLL1ZZZZZerLLLLLiywkk4kkkkkkmpJJJiSSU0000+mmnppppppppp8kJJJJJJJJJJJxISSSSSTUkkk+STxJJJJJJJJOpJJiSSSSSSSakkknFllllllxZZZZerLLLLL1ZZZZZcWWWWXiyyywkk1JJJMSSSSSSSTqSU9NNNNNNNNOmTTTTTRJJJJJiQkkkkkknUkk+STxJJJJJJJJOpJJiSSSSSSSakkknEkkkkkk9WWWWXqyyyyy9WWWWWXqSSSScSSSSSSTUkkkxaaaaaaafTTT0000000006ZNNNNNNNNNNPTJppppppp006aemmmmkkkknUkkxJJJJJJJNSbLLxZZZZZZcWWWWXqyyyyy9WWWWWXFllll4spJJJJNSSSTEkkkkkkl9NNPTTTTTTTTTpk000000000yZNNNNNNNJJPkk8SSSSSSSSTqSSYkkkkkkkmpJJJxJJJJJZcWWWWXqyyyyy9WWWWWXFllll4ssssssvqywkxJJJJJJJOpJJ4kkklNNNNOmTTTTTTTTTTR4niSSSSSSSdSSTEkkkllll9WWWXiyyyyyy4ssssvVlllll6sssssuLCSSTiSSSSSSakkkmJJTTTTTT6aaemmmmmmmmnTJpk/U0000000yf5Pp9Pp9Pp9Ppp06dOnTp06dOnTp06dOnTp06dOnTp06dOn06dOnTp06dOnTp06dOnTp06dOnTp06dOnTp06dOnTp06dOnTp06dOnTp06dOnT09PT0/E+mmmmmmjqSSYkkkkkkkmpJJJxJZZZZZcWWWWXqyyyyy9WWWWWXFllll4sssssJNSSSTEkkkkkkk6kknk000000006ZNNPxNNNEkkknqepqampqakkkqMkssssssssJlllllllllhMsssssssssJljTTTTTTTVLTTpppppllhMsssssssssJlllllllllhMsssssssssJlllllllllhPkvkur8XV1dXV1dWX6sv4ssssskkknUkkxJJJJJJJNSTLLxZZZZZZcWWWWXqyyyyy9WWWWWXFllll4sskkkkmpJJJiSSSSSSSfiyy/iy6ssssssv1cXFxfRqampJJKjJJJJJJJJJCZZZZZZZZZYTLLLLLLLLLCZZZZZZZZZYTLLLLLLLLLCZZZfqyyyyywmWWWWWWWWWEyyyyyyyyywmWWWWWWWWWE+L5Lq+rq6urq6urJpk0000000006aemkkkkkkknUkkxJJJJJJJNSSSTiSSSSSSepJJJL1ZZZZZerLLLLLiyyyy8WWWWWWX1ZZZfF1ZZZZZZfi4uLi4vq+r6sssJlllllllllhMsssssssssJlllllllllhMsssssssssJlllllllllhMsssssssssJllll+rLLLLCZZZZZZZZZYTLLLLLLLLLCfF8XV/FxdXV1dXV1Zfq0sssssaaZNNMmmmmmmmmmnRJ4kkkkkkkknUkkxJJJZZZZfVlll4ssssssuLLLLL1ZZZZZerLLLLLiyyy6vFllllll9XFxcXFxfV9WWWEyyyyyyyyywmWWWWWWWWWEyyyyyyyyywmWWWWWWWWWEyyyyyyyyywmWWWWWWWWWEyyyyyyyyywmWWWWX6ssssJlllllllllhPi+Lq9XxdXV1dXV1afTTT0000000006ZNNNNNNMmmmmTTTTTTTTTTpp6aaaaaaaafTTTEkkkkkkk1JJJOJJJJNllxZZZZerLLLqy9WWWWWXFxcXFxcXF9WWWEyyyyyyyyywmWWWWWWWWWEyyyyyyyyywmWWWWWWWWWEyyyyyyyyywmWWWWWWWWWEyyyyyyyyywmWWWWWWWWWEyyyyyy/VllhPF8XV6urxdXV1dXVl9WWWXxZZY0000+mmnppppppppp0yaaaaaZNNNNMmmmmmmmmmnTT000000000dSSTEkkkkkkk1JJJOJLLLqyy4ssssvVxcXFxcXFl+LLCZZZZZZZZZYTLLLLLLLLLCZZZZZZZZZYTLLLLLLLLLCZZZZZZZZZYTLLLLLLLLLCZZZZZZZZZYTLLLLLLLLLCZZZZZZZZZYTxfF1erq6vV1dXV1YepJJJJxJJJJJJNSSSTJppppppp9NNPTTTTTTTTTpk0000yaaaaaZNNNNNNNNNOmnpppppllll+LLL4sssurLLL6sssvFxcXFxcXFll+rCZZZZZZZZZYTLLLLLLLLLCZZZZZZZZZYTLLLLLLLLLCZZZZZZZZZYTLLLLLLLLLCZZZZZZZZZYTLLLLLLLLLCZZZZZZZZZYTxeLq9XV1dXF1dXVl6sssssvVlllllxZZZZeLLLLLLL6pJJMSSSSSSSTqSSeJJLTTTTTTpk000yaaaaaaZNNNNNNNNNOmnppll1ZZZZfiyy+Li4uLi4uGmnTFXpppppppppqlpppppppppkWnpppppJJJJ8IMkmJJJJJJJJ0QZJJOJJJJJJJogySSS9WWWWWXJTLLLLLiyyyy9lMsssssvqyyy8lMssssssvxZZfJT4vi6urq6urq+rq6svFllllllxZZZZerLLLLL1ZZZZZcWWEknEkkkkkk1JJJMSSSmmmmn0009NNNNNNNNOmTTTJpppppppk000flJJJJJPkk8TU1NTU1NTUp009UtNNNNNNNNNUtNNNNNNNNMi09NNNNNNNNORaemmmmmmmmnItPTTTTTTTTTkWnpppppppppyLT0000000005Fp6aaaaaaaaci09NNNNNNNNORfoUSV4QqP2IVH/CFR+xCo/8XckU4UJDL3pT5A==';

const bytes = (base64: string): Uint8Array => Uint8Array.from(Buffer.from(base64, 'base64'));
const text = (data: Uint8Array): string => new TextDecoder().decode(data);

describe('bunzip2', () => {
	it('decodes a small stream', () => {
		expect(text(bunzip2(bytes(SMALL)))).toBe('CREATE TABLE wf_exp_imp (id int);\nINSERT INTO wf_exp_imp VALUES (1), (2);\n');
	});

	it('expands long runs of one byte', () => {
		expect(text(bunzip2(bytes(RUNS)))).toBe(`${'x'.repeat(1000)}yz`);
	});

	it('decodes a full block', () => {
		const result = text(bunzip2(bytes(BLOCKS)));
		expect(result.length).toBe(114450);
		expect(md5(result)).toBe('0d57468b05292d6e282e7942c8dc4798');
	});

	it('gives up on a block that is cut off or damaged', () => {
		const blocks = bytes(BLOCKS);
		expect(bunzip2(blocks.subarray(0, -100)).length).toBe(0);
		const damaged = Uint8Array.from(blocks);
		damaged[4] ^= 0xFF;
		expect(bunzip2(damaged).length).toBe(0);
		// Bits 137 to 152 are the symbol map of the first block; with none set the block cannot hold any byte.
		const empty = bytes(RUNS);
		for (let bit = 137; bit < 153; bit++) {
			empty[bit >>> 3] &= ~(0x80 >>> (bit & 7));
		}
		expect(bunzip2(empty).length).toBe(0);
		expect(bunzip2(new TextEncoder().encode('BZh0')).length).toBe(0);
		expect(bunzip2(new TextEncoder().encode('nope')).length).toBe(0);
	});

	it('never throws on a stream with any single bit flipped', () => {
		for (const fixture of [SMALL, RUNS]) {
			const original = bytes(fixture);
			for (let bit = 0; bit < original.length * 8; bit++) {
				const damaged = Uint8Array.from(original);
				damaged[bit >>> 3] ^= 1 << (bit & 7);
				expect(() => bunzip2(damaged)).not.toThrow();
			}
		}
	});
});

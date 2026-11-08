import { describe, expect, it } from 'vitest';

import { md5 } from './md5.ts';

describe('md5', () => {
	it('matches PHP md5() for empty, ASCII and UTF-8 input', () => {
		expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
		expect(md5('The quick brown fox jumps over the lazy dog')).toBe('9e107d9d372bb6826bd81d3542a419d6');
		expect(md5('customer_db.players')).toBe('6376a050a5e3e273fc3afbc44edaf8e5');
		expect(md5('é')).toBe('66ddcd97cfdeabb2f6fb8a999b4bc76f');
	});

	it('pads correctly around the 55 and 56 byte block boundary and across blocks', () => {
		expect(md5('b'.repeat(55))).toBe('73979428bc0de15c39d14ae331b35295');
		expect(md5('b'.repeat(56))).toBe('b9d955696c7654cd20086bec31670b11');
		expect(md5('a'.repeat(64))).toBe('014842d480b571495a4a0363793f7367');
	});
});

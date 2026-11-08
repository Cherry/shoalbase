import { describe, expect, it } from 'vitest';

import { bcryptCrypt, bcryptHash } from './bcrypt.ts';

describe('bcrypt', () => {
	it('matches the crypt_blowfish reference vectors', () => {
		expect(bcryptCrypt('U*U', '$2a$05$CCCCCCCCCCCCCCCCCCCCC.')).toBe('$2a$05$CCCCCCCCCCCCCCCCCCCCC.E5YPO9kmyuRGyh0XouQYb4YMJKvyOeW');
		expect(bcryptCrypt('U*U*', '$2a$05$CCCCCCCCCCCCCCCCCCCCC.')).toBe('$2a$05$CCCCCCCCCCCCCCCCCCCCC.VGOzA784oUp/Z0DY336zx7pLYAy0lwK');
		expect(bcryptCrypt('', '$2a$05$CCCCCCCCCCCCCCCCCCCCC.')).toBe('$2a$05$CCCCCCCCCCCCCCCCCCCCC.7uG0VCzI2bS7j6ymqJi9CdcdxiRTWNy');
	});

	it('produces password_hash() style $2y$10$ hashes that verify against themselves', () => {
		const hash = bcryptHash('secret', 4);
		expect(hash).toMatch(/^\$2y\$04\$[./A-Za-z0-9]{53}$/);
		expect(bcryptCrypt('secret', hash)).toBe(hash);
		expect(bcryptHash('x')).toMatch(/^\$2y\$10\$/);
	});

	it('only uses the first 72 bytes of the password and rejects malformed settings', () => {
		const setting = '$2y$04$abcdefghijklmnopqrstuu';
		expect(bcryptCrypt('a'.repeat(72), setting)).toBe(bcryptCrypt(`${'a'.repeat(72)}b`, setting));
		expect(() => bcryptCrypt('x', '$1$abc')).toThrow('Invalid bcrypt setting');
	});
});

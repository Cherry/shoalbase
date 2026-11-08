import { describe, expect, it } from 'vitest';

import { releaseRef, serverEntry } from './installer.ts';

describe('releaseRef', () => {
	it('clones the release tag a published installer was cut from', () => {
		expect(releaseRef('1.4.2')).toBe('v1.4.2');
	});

	it('clones the default branch from an unreleased checkout', () => {
		expect(releaseRef('0.0.0-semantically-released')).toBeUndefined();
		expect(releaseRef('2.0.0-beta.1')).toBeUndefined();
	});
});

describe('serverEntry', () => {
	it('leaves out the default port and plain connections', () => {
		expect(serverEntry({ host: 'db.example.com', port: 3306, ssl: false })).toEqual({ host: 'db.example.com' });
	});

	it('keeps a custom port, TLS and the pin', () => {
		expect(serverEntry({ host: 'db.example.com', port: 3307, ssl: true, pin: 'abc=' })).toEqual({ host: 'db.example.com', port: 3307, ssl: true, pin: 'abc=' });
	});
});

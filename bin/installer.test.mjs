import { describe, expect, it } from 'vitest';

import { releaseRef } from './installer.mjs';

describe('releaseRef', () => {
	it('clones the release tag a published installer was cut from', () => {
		expect(releaseRef('1.4.2')).toBe('v1.4.2');
	});

	it('clones the default branch from an unreleased checkout', () => {
		expect(releaseRef('0.0.0-semantically-released')).toBeUndefined();
		expect(releaseRef('2.0.0-beta.1')).toBeUndefined();
	});
});

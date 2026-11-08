// @vitest-environment node
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { renderJavaScriptMessages } from './messages';

describe('renderJavaScriptMessages', () => {
	it('matches js/messages.php?l=en&v=5.2.3&lang=en from phpMyAdmin 5.2.3, body and headers', () => {
		const live = readFileSync(new URL('../../../tests/fixtures/pma-5.2.3/messages.js', import.meta.url), 'utf8');
		// Captured at Date: Fri, 06 Nov 2026 16:39:09 GMT, with Expires one hour later.
		const response = renderJavaScriptMessages({}, new Date('2026-11-06T16:39:09Z'));
		expect(response.body).toBe(live);
		expect(response.headers).toEqual([
			['Content-Type', 'text/javascript; charset=UTF-8'],
			['Expires', 'Fri, 06 Nov 2026 17:39:09 GMT'],
		]);
	});
});

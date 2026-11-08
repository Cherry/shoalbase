// @vitest-environment node
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { renderConsole } from './console';

import type { PmaContext } from '../core/context';

const live = readFileSync(new URL('../../../../tests/fixtures/pma-5.2.3/home.live.html', import.meta.url), 'utf8');

function fakeContext(isAjax: boolean): PmaContext {
	const url = { server: 1, serverDefault: 1, lang: 'en', hasLangCookie: true, token: 't' };
	return { response: { isAjax },
		templateState: async () => {
			return { url, mysqlVersion: 80413 };
		} } as unknown as PmaContext;
}

describe('renderConsole', () => {
	it('reproduces the 5.2.3 console without bookmarks or stored history, as served without pmadb', async () => {
		const html = await renderConsole(fakeContext(false));
		const start = live.indexOf('<div id="pma_console_container"');
		const end = live.indexOf('<!-- #console_container end -->') + '<!-- #console_container end -->'.length;
		expect(html.trimEnd()).toBe(live.slice(start, end));
		expect(html).not.toContain('pma_bookmarks');
	});

	it('renders nothing for AJAX requests, which keep the console already on the page', async () => {
		expect(await renderConsole(fakeContext(true))).toBe('');
	});
});

import type { Page } from '@playwright/test';

// The fixed console bar sometimes lands 1px lower on either side depending on load timing, so its icon is ignored everywhere.
const ALWAYS_MASK = ['#pma_console .toolbar .console_switch img'];
// The server select is sized by its option labels, which name the Docker host on the oracle and the IP on ours.
const SERVER_SELECT = 'select[name="server"]';

/** Replaces text that changes on every request (timings, clocks, host label) so it does not dominate the diff. */
async function normalizeVolatileText(page: Page): Promise<void> {
	await page.evaluate(() => {
		const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			const text = node.textContent ?? '';
			const next = text
				.replaceAll(/Query took \d+\.\d+ seconds/g, 'Query took 0.0000 seconds')
				.replaceAll(/Network traffic since startup: [\d.,]+ \S+/g, 'Network traffic since startup: 0 B')
				// Uptime ticks between the two captures, and a masked cell still resizes the table when its digit count changes.
				.replaceAll(/\d+ days, \d+ hours, \d+ minutes and \d+ seconds/g, '0 days, 0 hours, 0 minutes and 0 seconds')
				// Server 1 is the same MySQL 8.4 container, named by its Docker host on the oracle and by IP on ours.
				.replaceAll(/\bdbadmin-mysql\b(?!-)/g, '127.0.0.1')
				.replaceAll(/\b\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\b/g, '2000-01-01 00:00:00')
				// The console stamps each query with the browser clock, unpadded, in a text node of its own.
				.replaceAll(/\b\d{1,2}:\d{1,2}:\d{1,2}\b/g, '0:00:00');
			if (next !== text) {
				node.textContent = next;
			}
		}
		// The caret and text-input blink would otherwise differ between the two captures.
		(document.activeElement as HTMLElement | null)?.blur();
	});
	await page.addStyleTag({ content: `${SERVER_SELECT} { width: 160px !important; }` });
}

/** Full-page screenshot with volatile text normalized and environment-specific regions masked. */
export async function snapshot(page: Page, mask: string[] = [], hide: string[] = []): Promise<Buffer> {
	await normalizeVolatileText(page);
	if (hide.length > 0) {
		await page.addStyleTag({ content: `${hide.join(', ')} { display: none !important; }` });
	}
	return page.screenshot({
		fullPage: true,
		animations: 'disabled',
		caret: 'hide',
		mask: [...ALWAYS_MASK, SERVER_SELECT, ...mask].map(selector => page.locator(selector)),
		maskColor: '#ff00ff',
	});
}

import path from 'node:path';

import { defineConfig } from '@playwright/test';

const port = process.env.PMA_VISUAL_PORT ?? '8841';

// Specs use the .visual.ts suffix so vitest's default *.spec/*.test glob never collects them.
export default defineConfig({
	testDir: import.meta.dirname,
	testMatch: '**/*.visual.ts',
	outputDir: path.join(import.meta.dirname, '.results'),
	globalSetup: './global-setup.ts',
	globalTeardown: './global-teardown.ts',
	// Both sides share one MySQL server and scratch tables, so screens run one at a time.
	fullyParallel: false,
	workers: 1,
	// Other agents create and drop tables in customer_db between the two captures; a retry separates that noise from real differences.
	retries: 1,
	timeout: 120000,
	reporter: [['list']],
	use: {
		browserName: 'chromium',
		channel: process.env.PMA_VISUAL_CHANNEL,
		headless: true,
		actionTimeout: 15000,
		navigationTimeout: 30000,
	},
	webServer: {
		command: `node tests/visual/serve.ts ${port}`,
		cwd: path.join(import.meta.dirname, '..', '..'),
		url: `http://127.0.0.1:${port}/index.php`,
		reuseExistingServer: true,
		timeout: 180000,
		stdout: 'ignore',
		stderr: 'pipe',
	},
});

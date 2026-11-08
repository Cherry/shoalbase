// Runs tests/workers/** in workerd against the real session Durable Object, with the bindings and compatibility settings of wrangler.jsonc.
import { fileURLToPath } from 'node:url';

import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		cloudflareTest({
			// src/worker.ts imports Astro's virtual modules, which only an Astro build provides, so the tests use an entry with just the session object.
			main: './tests/workers/worker.ts',
			wrangler: { configPath: './wrangler.jsonc' },
			// Fixed values instead of .dev.vars, so the tests never depend on a developer's servers or secret.
			miniflare: {
				bindings: {
					PMA_COOKIE_SECRET: 'workerd-tests-only-cookie-secret-0123456789',
					PMA_SERVERS: JSON.stringify([{ host: 'db-a.test' }, { host: 'db-b.test' }]),
				},
			},
		}),
	],
	resolve: {
		alias: {
			'~': fileURLToPath(new URL('./src', import.meta.url)),
		},
	},
	test: {
		include: ['tests/workers/**/*.test.ts'],
	},
});

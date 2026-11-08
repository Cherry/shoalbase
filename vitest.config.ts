import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: {
			'~': fileURLToPath(new URL('./src', import.meta.url)),
			// Node stand-ins for the Workers runtime modules, shared with scripts/render-route.ts.
			'cloudflare:workers': fileURLToPath(new URL('./scripts/stubs/cloudflare-workers.ts', import.meta.url)),
			'cloudflare:sockets': fileURLToPath(new URL('./scripts/stubs/cloudflare-sockets.ts', import.meta.url)),
		},
	},
	test: {
		environment: 'jsdom',
		exclude: ['**/node_modules/**', '**/dist/**', '**/.git/**', '**/.reference/**', '**/.research-phpmyadmin/**'],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'html'],
			include: ['src/lib/**/*.ts'],
			thresholds: {
				branches: 100,
				functions: 100,
				lines: 100,
				statements: 100,
			},
		},
	},
});

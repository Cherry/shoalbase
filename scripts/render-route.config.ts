// vite-node config for scripts/render-route.ts: the vitest config plus Node stand-ins for the cloudflare:* modules.
import { fileURLToPath } from 'node:url';

import { mergeConfig } from 'vite';

import base from '../vitest.config.ts';

export default mergeConfig(base, {
	resolve: {
		alias: {
			'cloudflare:workers': fileURLToPath(new URL('./stubs/cloudflare-workers.ts', import.meta.url)),
			'cloudflare:sockets': fileURLToPath(new URL('./stubs/cloudflare-sockets.ts', import.meta.url)),
		},
	},
});

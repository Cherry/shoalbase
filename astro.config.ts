import cloudflare from '@astrojs/cloudflare';
import { defineConfig } from 'astro/config';

export default defineConfig({
	adapter: cloudflare({
		imageService: 'passthrough',
	}),
	output: 'server',
	// phpMyAdmin's session lives in its own Durable Object (src/server/session-object.ts), so Astro's KV-backed sessions (and their SESSION binding) are not needed.
	session: false,
	site: 'https://shoalbase.example',
	build: {
		format: 'directory',
	},
});

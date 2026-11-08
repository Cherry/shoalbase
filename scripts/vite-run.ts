// Runs a script through Vite's SSR module runner, so it can import src/ with the `~/` alias, the cloudflare:* stubs and TypeScript that Node's type stripping cannot run.
// Usage: node scripts/vite-run.ts <script> [args...]; the script sees process.argv as [node, script, ...args].
import path from 'node:path';
import process from 'node:process';

import { createServer, createServerModuleRunner } from 'vite';

const [entry, ...args] = process.argv.slice(2);
if (entry === undefined) {
	console.error('Usage: node scripts/vite-run.ts <script> [args...]');
	process.exit(2);
}

// No watcher, HMR or socket, so the server holds no handles: the process ends when the script's own work does.
const server = await createServer({
	configFile: path.join(import.meta.dirname, 'render-route.config.ts'),
	appType: 'custom',
	clearScreen: false,
	logLevel: 'warn',
	optimizeDeps: { noDiscovery: true, include: [] },
	server: { middlewareMode: true, hmr: false, ws: false, watch: null },
});
// The server stays open, because a script such as render-route's warm mode imports more modules long after it starts.
const runner = createServerModuleRunner(server.environments.ssr, { hmr: false });

const script = path.resolve(entry);
process.argv = [process.argv[0], script, ...args];
await runner.import(script);

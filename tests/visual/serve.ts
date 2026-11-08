// Serves a private copy of the latest build with wrangler dev, so rebuilding dist mid-run cannot change what is under test.
// Usage: node tests/visual/serve.ts [port]   (run `npm run build` first; Playwright starts this as its webServer)
import { spawn } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..', '..');
const copy = path.join(root, '.visual-dist');
const port = process.argv[2] ?? '8841';

if (!existsSync(path.join(root, 'dist', 'server', 'wrangler.json'))) {
	console.error('dist/server/wrangler.json is missing; run `npm run build` first.');
	process.exit(1);
}
for (const part of ['client', 'server']) {
	rmSync(path.join(copy, part), { recursive: true, force: true });
	cpSync(path.join(root, 'dist', part), path.join(copy, part), { recursive: true });
}

const args = [
	'wrangler',
	'dev',
	'-c',
	path.join(copy, 'server', 'wrangler.json'),
	'--env-file',
	path.join(root, '.dev.vars'),
	'--persist-to',
	path.join(copy, 'state'),
	'--port',
	port,
	'--ip',
	'127.0.0.1',
	'--inspector-port',
	String(Number(port) + 500),
	'--show-interactive-dev-session=false',
];
const child = spawn('npx', args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
const stop = () => child.kill();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', code => process.exit(code ?? 0));

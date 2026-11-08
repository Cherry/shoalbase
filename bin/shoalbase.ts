#!/usr/bin/env node
// Sets up a Shoalbase checkout: clones the release matching this package, asks for the servers, writes .dev.vars, and can deploy it.
// The published package runs the bundle tsdown builds from this file (`npm run build:bin`), so it needs nothing from the clone.
import { execFileSync, execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';

// A named JSON import lets the bundler inline just the version; Node cannot run it unbundled, so try the installer with `npm run build:bin`.
import { version } from '../package.json' with { type: 'json' };
import { pinFor, releaseRef, serverEntry } from './installer.ts';

import type { ServerEntry } from './installer.ts';
import type { Interface } from 'node:readline/promises';

const REPOSITORY = 'https://github.com/Cherry/shoalbase.git';
const HELP = `Usage: npx shoalbase [directory]

Clones Shoalbase into the directory (default: shoalbase), installs it, asks which
MySQL and MariaDB servers users may sign in to, writes .dev.vars, and offers to
deploy it to your Cloudflare account.

Options:
  -h, --help     Show this help
  -v, --version  Show the version`;

function run(command: string, args: string[], cwd?: string) {
	if (process.platform === 'win32' && command === 'npm') {
		// npm is a .cmd shim on Windows, which only a shell starts, and Node deprecates passing a shell separate arguments; none here contain spaces.
		execSync([command, ...args].join(' '), { cwd, stdio: 'inherit' });
		return;
	}
	execFileSync(command, args, { cwd, stdio: 'inherit' });
}

type Ask = (question: string) => Promise<string>;

// Reads through the line iterator, which buffers, because rl.question() drops answers piped or pasted in before their question.
function prompter(rl: Interface): Ask {
	const lines = rl[Symbol.asyncIterator]();
	return async (question) => {
		rl.setPrompt(question);
		rl.prompt();
		const line = await lines.next();
		if (line.done) {
			throw new Error('Input ended before setup finished.');
		}
		return String(line.value).trim();
	};
}

async function askServer(ask: Ask): Promise<ServerEntry | undefined> {
	const host = await ask('Server host: ');
	if (host === '') {
		return;
	}
	const port = Number(await ask('Port (3306): ') || 3306);
	const ssl = /^y/i.test(await ask('Connect over TLS? (y/N): '));
	if (!ssl) {
		return serverEntry({ host, port, ssl });
	}
	let kind = '';
	while (kind !== 'mysql' && kind !== 'mariadb') {
		const answer = await ask('Is it mysql or mariadb? ');
		kind = answer.toLowerCase();
	}
	if (kind === 'mariadb') {
		// MariaDB proves its certificate after login, so it needs no pin.
		return serverEntry({ host, port, ssl });
	}
	// MySQL's self-signed certificate is trusted by pinning its key.
	const presented = await pinFor(host, port);
	console.log(`It presents ${presented.subject.replaceAll('\n', ' ')}, key pin ${presented.pin}`);
	if (!/^y/i.test(await ask('Trust this certificate? (y/N): '))) {
		console.log('Skipped. Check the certificate on the server, then add it again.');
		return;
	}
	return serverEntry({ host, port, ssl, pin: presented.pin });
}

async function askServers(ask: Ask) {
	const servers: ServerEntry[] = [];
	do {
		const server = await askServer(ask);
		if (server) {
			servers.push(server);
		}
	} while (servers.length === 0 || /^y/i.test(await ask('Add another server? (y/N): ')));
	return servers;
}

async function main(args: string[]) {
	if (args.includes('-h') || args.includes('--help')) {
		console.log(HELP);
		return;
	}
	if (args.includes('-v') || args.includes('--version')) {
		console.log(version);
		return;
	}
	const directory = path.resolve(args.find(arg => !arg.startsWith('-')) ?? 'shoalbase');
	if (existsSync(directory)) {
		throw new Error(`${directory} already exists. Pick a new directory.`);
	}
	const clone = ['clone', '--depth', '1'];
	const ref = releaseRef(version);
	if (ref) {
		clone.push('--branch', ref);
	}
	run('git', [...clone, REPOSITORY, directory]);
	run('npm', ['ci'], directory);

	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const ask = prompter(rl);
	let deploy;
	try {
		console.log('\nWhich servers can users sign in to? README.md explains how TLS servers are trusted.');
		const servers = await askServers(ask);
		writeFileSync(path.join(directory, '.dev.vars'), `PMA_COOKIE_SECRET=${randomBytes(36).toString('base64url')}\nPMA_SERVERS=${JSON.stringify(servers)}\n`);
		console.log(`\nWrote .dev.vars with ${servers.length} server(s) and a new cookie secret.`);
		deploy = /^y/i.test(await ask('Deploy to Cloudflare now? Wrangler will ask you to sign in. (y/N): '));
	} finally {
		rl.close();
	}
	if (deploy) {
		run('npm', ['run', 'build'], directory);
		run('npm', ['run', 'deploy', '--', '--secrets-file', '.dev.vars'], directory);
		return;
	}
	console.log(`\nNext, in ${directory}: \`npm run dev\` to try it, or \`npm run build\` and \`npm run deploy -- --secrets-file .dev.vars\` to deploy.`);
}

try {
	await main(process.argv.slice(2));
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
}

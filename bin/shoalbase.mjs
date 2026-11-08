#!/usr/bin/env node
// Sets up a Shoalbase checkout: clones the release matching this package, asks for the servers, writes .dev.vars, and can deploy it.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

import { releaseRef, serverEntry } from './installer.mjs';

const REPOSITORY = 'https://github.com/Cherry/shoalbase.git';
const HELP = `Usage: npx shoalbase [directory]

Clones Shoalbase into the directory (default: shoalbase), installs it, asks which
MySQL and MariaDB servers users may sign in to, writes .dev.vars, and offers to
deploy it to your Cloudflare account.

Options:
  -h, --help     Show this help
  -v, --version  Show the version`;

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function run(command, args, cwd) {
	// npm is a .cmd shim on Windows, which Node only starts through a shell; none of its arguments here contain spaces.
	const shell = process.platform === 'win32' && command === 'npm';
	execFileSync(command, args, { cwd, stdio: 'inherit', shell });
}

async function ask(rl, question) {
	const answer = await rl.question(question);
	return answer.trim();
}

async function askServer(rl, pinFor) {
	const host = await ask(rl, 'Server host: ');
	if (host === '') {
		return;
	}
	const port = Number(await ask(rl, 'Port (3306): ') || 3306);
	const ssl = /^y/i.test(await ask(rl, 'Connect over TLS? (y/N): '));
	if (!ssl) {
		return serverEntry({ host, port, ssl });
	}
	let kind = '';
	while (kind !== 'mysql' && kind !== 'mariadb') {
		const answer = await ask(rl, 'Is it mysql or mariadb? ');
		kind = answer.toLowerCase();
	}
	if (kind === 'mariadb') {
		// MariaDB proves its certificate after login, so it needs no pin.
		return serverEntry({ host, port, ssl });
	}
	// MySQL's self-signed certificate is trusted by pinning its key.
	const presented = await pinFor(host, port);
	console.log(`It presents ${presented.subject.replaceAll('\n', ' ')}, key pin ${presented.pin}`);
	if (!/^y/i.test(await ask(rl, 'Trust this certificate? (y/N): '))) {
		console.log('Skipped. Check the certificate on the server, then add it again.');
		return;
	}
	return serverEntry({ host, port, ssl, pin: presented.pin });
}

async function askServers(rl, directory) {
	const { pinFor } = await import(pathToFileURL(path.join(directory, 'scripts', 'collect-tls-pins.mjs')).href);
	const servers = [];
	do {
		const server = await askServer(rl, pinFor);
		if (server) {
			servers.push(server);
		}
	} while (servers.length === 0 || /^y/i.test(await ask(rl, 'Add another server? (y/N): ')));
	return servers;
}

async function main(args) {
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
	let deploy;
	try {
		console.log('\nWhich servers can users sign in to? README.md explains how TLS servers are trusted.');
		const servers = await askServers(rl, directory);
		writeFileSync(path.join(directory, '.dev.vars'), `PMA_COOKIE_SECRET=${randomBytes(36).toString('base64url')}\nPMA_SERVERS=${JSON.stringify(servers)}\n`);
		console.log(`\nWrote .dev.vars with ${servers.length} server(s) and a new cookie secret.`);
		deploy = /^y/i.test(await ask(rl, 'Deploy to Cloudflare now? Wrangler will ask you to sign in. (y/N): '));
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

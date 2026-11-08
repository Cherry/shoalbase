// Diffs the live phpMyAdmin 5.2.3 oracle against our port for one request, after masking tokens, dates and random ids.
// Usage: node scripts/pma-diff.mjs [--server <n>] [--user <persona>] [--post] [--ajax] [--headers] [--signed-out] [--out <dir>] [--before "[POST] <route> [key=value ...]"]... <route> [key=value ...]
// Example: node scripts/pma-diff.mjs --ajax database/structure db=customer_db   (exit code 1 when they differ)
// --user signs both sides in as a persona (customer, pma_grant, pma_creator or root; see PERSONAS in pma-oracle.mjs).
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { fetchOracle, parseArgs } from './pma-oracle.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONTEXT_LINES = 3;

const byText = (left, right) => (left < right ? -1 : Number(left > right));

// Headers that only describe the transport or the moment of the request.
const IGNORED_HEADERS = new Set(['date', 'server', 'connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length', 'vary', 'x-ob_mode']);

// PMA_RENDER_URL points at a warm render-route process (PMA_RENDER_SERVE), which skips vite-node's start-up on every diff.
async function renderStdout(argv) {
	if (process.env.PMA_RENDER_URL) {
		const response = await fetch(process.env.PMA_RENDER_URL, { method: 'POST', body: JSON.stringify(argv) });
		const text = await response.text();
		if (!response.ok) {
			throw new Error(`render-route failed: ${text}`);
		}
		return text;
	}
	const viteNode = path.join(ROOT, 'node_modules', 'vite-node', 'vite-node.mjs');
	const args = [viteNode, '--config', 'scripts/render-route.config.ts', 'scripts/render-route.ts', '--', ...argv];
	const { stdout } = await promisify(execFile)(process.execPath, args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
	return stdout;
}

async function renderOurs(argv) {
	const stdout = await renderStdout(['--headers', ...argv]);
	const split = stdout.indexOf('\n\n');
	const head = stdout.slice(0, split).split('\n');
	const status = Number(head[0].replace('HTTP ', ''));
	const headers = head.slice(1).map((line) => {
		const index = line.indexOf(': ');
		return [line.slice(0, index), line.slice(index + 2)];
	});
	return { status, headers, body: stdout.slice(split + 2) };
}

/** Masks values that legitimately differ between two runs of the same request. */
export function normalizeBody(body) {
	let text = body
		.replaceAll(/([?&;]token=|name="token" value="|token:"|"token": ?"|token=)[0-9a-f]{32}/g, '$1<token>')
		.replaceAll(/(name="set_session" value=")[0-9a-f]+/g, '$1<session>')
		.replaceAll(/((?:upload_id|UPLOAD_IDENTIFIER|APC_UPLOAD_PROGRESS|PHP_SESSION_UPLOAD_PROGRESS)" value=")[^"]*/g, '$1<upload-id>')
		// The import page's status poll URL carries the same uniqid() upload id.
		.replaceAll(/(import\\u002Dstatus\\u0026id\\u003D)[0-9a-f]{13}/g, '$1<upload-id>')
		.replaceAll(/[A-Z][a-z]{2} \d{2}, \d{4} at \d{2}:\d{2} [AP]M/g, '<date>')
		.replaceAll(/<select id="select_server"[\s\S]*?<\/select>/g, '<select id="select_server"><server-options></select>')
		// Core::signSqlQuery() HMACs use a per-session secret, and query timings vary between runs.
		.replaceAll(/((?:sql_signature|where_clause_signature|where_clause_sign)(?:=|%3D|" value="))[0-9a-f]{64}/g, '$1<signature>')
		.replaceAll(/Query took \d+\.\d{4} seconds/g, 'Query took <time> seconds')
		// Without pmadb coordinates the designer places each table at rand() offsets.
		.replaceAll(/(style="position:absolute; left:)\d+px; top:\d+px;/g, '$1<x>px; top:<y>px;');
	// Display\Results numbers each result table with random_int(), reused in several ids.
	for (const match of text.matchAll(/(?:id="showAll_|data-uniqueId=")(\d+)"/g)) {
		text = text.replaceAll(match[1], '<unique-id>');
	}
	return text;
}

// Cookie values are secrets or per-session; names and attributes are compared, in a fixed order.
function normalizeCookie(value) {
	const [pair, ...attributes] = value.split(';').map(part => part.trim());
	const name = pair.slice(0, pair.indexOf('='));
	const kept = attributes
		.map(attribute => attribute.toLowerCase())
		.filter(attribute => !attribute.startsWith('expires='))
		.toSorted(byText);
	return [`${name}=<value>`, ...kept].join('; ');
}

function normalizeHeaders(status, headers) {
	const lines = [`HTTP ${status}`];
	const kept = headers
		.filter(([name]) => !IGNORED_HEADERS.has(name.toLowerCase()))
		// PHP's session cookie and the per-server login cookies it refreshes each request; the port's own auth cookie comes from middleware, and its $_SESSION cookies stand in for PHP's session file.
		.filter(([name, value]) => name.toLowerCase() !== 'set-cookie' || !/^(?:phpMyAdmin|pmaAuth-\d+|pmaUser-\d+|pmaSession\d*)=/.test(value))
		.map(([name, value]) => {
			const lower = name.toLowerCase();
			if (lower === 'expires' || lower === 'last-modified') {
				return `${lower}: <date>`;
			}
			if (lower === 'set-cookie') {
				return `${lower}: ${normalizeCookie(value)}`;
			}
			return `${lower}: ${value}`;
		})
		.toSorted(byText);
	return [...lines, ...kept, ''].join('\n');
}

// JSON responses are spread over lines, with HTML strings printed raw, so their diff reads like a page diff.
function readable(body) {
	let json;
	try {
		json = JSON.parse(body);
	} catch {
		return body;
	}
	if (json === null || typeof json !== 'object' || Array.isArray(json)) {
		return body;
	}
	return Object.entries(json).map(([key, value]) => {
		const shown = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
		return `==== ${key} ====\n${shown}`;
	}).join('\n');
}

function lcsTable(oldLines, newLines) {
	const table = Array.from({ length: oldLines.length + 1 }, () => new Uint32Array(newLines.length + 1));
	for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex--) {
		for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex--) {
			table[oldIndex][newIndex] = oldLines[oldIndex] === newLines[newIndex] ? table[oldIndex + 1][newIndex + 1] + 1 : Math.max(table[oldIndex + 1][newIndex], table[oldIndex][newIndex + 1]);
		}
	}
	return table;
}

/** A unified diff of two texts; empty when they are equal. */
export function unifiedDiff(oldText, newText, oldLabel, newLabel) {
	const oldLines = oldText.split('\n');
	const newLines = newText.split('\n');
	// Trimming the shared head and tail keeps the quadratic LCS table small for large pages.
	let prefix = 0;
	while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
		prefix++;
	}
	let suffix = 0;
	while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) {
		suffix++;
	}
	const oldEnd = oldLines.length - suffix;
	const newEnd = newLines.length - suffix;
	const table = lcsTable(oldLines.slice(prefix, oldEnd), newLines.slice(prefix, newEnd));
	const ops = [];
	let oldIndex = 0;
	let newIndex = 0;
	for (; oldIndex < prefix; oldIndex++, newIndex++) {
		ops.push([' ', oldLines[oldIndex], oldIndex, newIndex]);
	}
	while (oldIndex < oldEnd || newIndex < newEnd) {
		const row = oldIndex - prefix;
		const column = newIndex - prefix;
		if (oldIndex < oldEnd && newIndex < newEnd && oldLines[oldIndex] === newLines[newIndex]) {
			ops.push([' ', oldLines[oldIndex], oldIndex++, newIndex++]);
		} else if (newIndex < newEnd && (oldIndex === oldEnd || table[row][column + 1] >= table[row + 1][column])) {
			ops.push(['+', newLines[newIndex], oldIndex, newIndex++]);
		} else {
			ops.push(['-', oldLines[oldIndex], oldIndex++, newIndex]);
		}
	}
	for (; oldIndex < oldLines.length; oldIndex++, newIndex++) {
		ops.push([' ', oldLines[oldIndex], oldIndex, newIndex]);
	}
	const changed = ops.map((op, index) => (op[0] === ' ' ? -1 : index)).filter(index => index >= 0);
	if (changed.length === 0) {
		return '';
	}
	const hunks = [];
	let start = Math.max(changed[0] - CONTEXT_LINES, 0);
	let end = Math.min(changed[0] + CONTEXT_LINES, ops.length - 1);
	for (const index of changed.slice(1)) {
		if (index - CONTEXT_LINES <= end + 1) {
			end = Math.min(index + CONTEXT_LINES, ops.length - 1);
		} else {
			hunks.push([start, end]);
			start = index - CONTEXT_LINES;
			end = Math.min(index + CONTEXT_LINES, ops.length - 1);
		}
	}
	hunks.push([start, end]);
	const out = [`--- ${oldLabel}`, `+++ ${newLabel}`];
	for (const [from, to] of hunks) {
		const slice = ops.slice(from, to + 1);
		const oldCount = slice.filter(op => op[0] !== '+').length;
		const newCount = slice.filter(op => op[0] !== '-').length;
		out.push(`@@ -${slice[0][2] + 1},${oldCount} +${slice[0][3] + 1},${newCount} @@`);
		for (const [kind, line] of slice) {
			out.push(kind + line);
		}
	}
	return `${out.join('\n')}\n`;
}

function takeOutDir(argv) {
	const index = argv.indexOf('--out');
	if (index === -1) {
		return { argv, outDir: null };
	}
	return { argv: [...argv.slice(0, index), ...argv.slice(index + 2)], outDir: argv[index + 1] };
}

async function main() {
	const { argv, outDir } = takeOutDir(process.argv.slice(2).filter(arg => arg !== '--'));
	const options = parseArgs(argv);
	const forwarded = argv.filter(arg => arg !== '--headers');
	const [oracle, ours] = await Promise.all([fetchOracle(options), renderOurs(forwarded)]);
	let oracleText = normalizeBody(readable(oracle.body));
	let ourText = normalizeBody(readable(ours.body));
	if (options.headers) {
		oracleText = normalizeHeaders(oracle.status, oracle.headers) + oracleText;
		ourText = normalizeHeaders(ours.status, ours.headers) + ourText;
	}
	if (outDir) {
		mkdirSync(outDir, { recursive: true });
		writeFileSync(path.join(outDir, 'oracle.txt'), oracleText);
		writeFileSync(path.join(outDir, 'ours.txt'), ourText);
	}
	const diff = unifiedDiff(oracleText, ourText, `oracle ${options.method} ${options.route}`, `ours ${options.method} ${options.route}`);
	process.stdout.on('error', () => {});
	if (diff === '') {
		process.stdout.write(`identical (HTTP ${oracle.status})\n`);
		return;
	}
	process.stdout.write(diff);
	process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
}

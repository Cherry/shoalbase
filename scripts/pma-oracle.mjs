// Fetches a route from the live phpMyAdmin 5.2.3 oracle, as the unprivileged customer unless --user picks another persona.
// Usage: node scripts/pma-oracle.mjs [--server <n>] [--user <persona>] [--post] [--ajax] [--headers] [--signed-out] [--before "[POST] <route> [key=value ...]"]... <route> [key=value ...]
// Example: node scripts/pma-oracle.mjs --ajax /database/structure db=customer_db
// --server signs in to oracle server n (default 1); ORACLE_SERVERS lists them and the local connection render-route uses for each.
// --user signs in as one of PERSONAS (customer, pma_grant, pma_creator, root) here, in render-route and in pma-diff.
// --before runs earlier requests in the same login first, for state kept in $_SESSION (recent tables, preferences, ...).
// PMA_MULTIPART=1 sends POSTs as multipart/form-data here and in render-route, with "key=@file:<path>" as an upload ("@file:" alone is an empty file input).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import nodePath from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const ORACLE_URL = process.env.PMA_ORACLE_URL ?? 'http://127.0.0.1:8088/';
const ORACLE_USER = process.env.PMA_ORACLE_USER ?? 'customer';
const ORACLE_PASSWORD = process.env.PMA_ORACLE_PASSWORD ?? 'customerpw';

/**
 * The oracle's $cfg['Servers'] by index: host is the name its pages show, connect is where render-route reaches the same database from the host.
 * TLS servers go through the Worker connector, so MariaDB is trusted by its certificate proof as in .dev.vars.
 */
export const ORACLE_SERVERS = {
	1: { host: 'dbadmin-mysql', name: 'mysql84', connect: { host: '127.0.0.1', port: 33306, ssl: false } },
	2: { host: 'dbadmin-mariadb', name: 'mariadb123', connect: { host: 'localhost', port: 33307, ssl: true } },
	3: { host: 'dbadmin-mysql57', name: 'mysql57', connect: { host: 'localhost', port: 33308, ssl: false } },
};

/** The ORACLE_SERVERS entry for a --server value, failing loudly on an unknown index. */
export function oracleServer(index) {
	const server = ORACLE_SERVERS[index];
	if (!server) {
		throw new Error(`Unknown --server "${index}"; expected one of ${Object.keys(ORACLE_SERVERS).join(', ')}`);
	}
	return server;
}

/**
 * Accounts that exist on every local test server: customer (customer_db only), pma_grant (ALL on customer_db WITH GRANT OPTION),
 * pma_creator (CREATE USER on *.* plus ALL on customer_db) and root, whose password is null because it is read from the container.
 */
export const PERSONAS = { customer: 'customerpw', pma_grant: 'grantpw', pma_creator: 'creatorpw', root: null };

const rootPasswords = new Map();

// Root's password stays in the container's env so it never lands in the repo or a log.
function rootPassword(container) {
	if (!rootPasswords.has(container)) {
		const env = JSON.parse(execFileSync('docker', ['inspect', container, '--format', '{{json .Config.Env}}'], { encoding: 'utf8' }));
		const entry = env.find(line => /^(?:MYSQL|MARIADB)_ROOT_PASSWORD=/.test(line));
		if (!entry) {
			throw new Error(`No root password in the env of container ${container}`);
		}
		rootPasswords.set(container, entry.slice(entry.indexOf('=') + 1));
	}
	return rootPasswords.get(container);
}

function assertPersona(user) {
	if (!Object.hasOwn(PERSONAS, user)) {
		throw new Error(`Unknown --user "${user}"; expected one of ${Object.keys(PERSONAS).join(', ')}`);
	}
}

/** The user name and password of a --user persona on oracle server n. */
export function personaCredentials(user, server) {
	assertPersona(user);
	let password = PERSONAS[user];
	if (password === null) {
		password = rootPassword(oracleServer(server).host);
	}
	return { user, password };
}

/** With PMA_MULTIPART=1, POST bodies go as multipart/form-data and "@file:<path>" values become file uploads ("@file:" alone is an empty file input). */
export function postBody(params) {
	if (!process.env.PMA_MULTIPART) {
		return params;
	}
	const form = new FormData();
	for (const [key, value] of params) {
		if (value === '@file:') {
			form.append(key, new Blob([]), '');
		} else if (value.startsWith('@file:')) {
			const file = value.slice('@file:'.length);
			form.append(key, new Blob([readFileSync(file)]), nodePath.basename(file));
		} else {
			form.append(key, value);
		}
	}
	return form;
}

// Git Bash rewrites a leading-slash argument into a Windows path ("/" becomes "C:/Program Files/Git/"), so undo that and accept routes without the slash.
function normalizeRoute(route) {
	const mangled = route.match(/^[A-Za-z]:[/\\].*?[/\\]Git([/\\].*)?$/);
	let path = route;
	if (mangled) {
		path = (mangled[1] ?? '/').replaceAll('\\', '/');
	}
	if (path.startsWith('/')) {
		return path;
	}
	return `/${path}`;
}

/** The route (first word without "=") and the key=value pairs after it. */
function routeAndParams(rest) {
	const words = [...rest];
	let route = '/';
	if (words.length > 0 && !words[0].includes('=')) {
		route = normalizeRoute(words.shift());
	}
	const params = words.map((pair) => {
		const index = pair.indexOf('=');
		if (index === -1) {
			throw new Error(`Expected key=value, got "${pair}"`);
		}
		return [pair.slice(0, index), pair.slice(index + 1)];
	});
	return { route, params };
}

/** One --before step: an optional method, the route, then key=value pairs separated by spaces. */
export function parseStep(text) {
	const words = text.split(' ').filter(Boolean);
	let method = 'GET';
	if (words[0] === 'GET' || words[0] === 'POST') {
		method = words.shift();
	}
	return { method, ajax: false, headers: false, signedOut: false, before: [], ...routeAndParams(words) };
}

/** Parses the shared CLI shape of the oracle, render and diff scripts. */
export function parseArgs(argv) {
	const options = { method: 'GET', ajax: false, headers: false, signedOut: false, server: '1', route: '/', params: [], before: [] };
	const rest = [];
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === '--') {
			continue;
		}
		if (arg === '--before') {
			options.before.push(parseStep(argv[++index] ?? ''));
		} else if (arg === '--server') {
			options.server = argv[++index] ?? '';
			// Any index is fine here, since PMA_ORACLE_URL may point at a Worker with its own server list; render-route checks ORACLE_SERVERS.
			if (!/^[1-9]\d*$/.test(options.server)) {
				throw new Error(`--server expects a server index, got "${options.server}"`);
			}
		} else if (arg === '--user') {
			options.user = argv[++index] ?? '';
			assertPersona(options.user);
		} else if (arg === '--post') {
			options.method = 'POST';
		} else if (arg === '--ajax') {
			options.ajax = true;
		} else if (arg === '--headers') {
			options.headers = true;
		} else if (arg === '--signed-out') {
			options.signedOut = true;
		} else {
			rest.push(arg);
		}
	}
	return { ...options, ...routeAndParams(rest) };
}

/**
 * PMA_EXTRA_COOKIES="name=value; other=value" adds cookies such as pma_theme to the request after login.
 * @returns {[string, string][]}
 */
export function extraCookies() {
	return (process.env.PMA_EXTRA_COOKIES ?? '').split(';').map(pair => pair.trim()).filter(Boolean)
		.map((pair) => {
			const index = pair.indexOf('=');
			return [pair.slice(0, index), pair.slice(index + 1)];
		});
}

class CookieJar {
	cookies = new Map();

	store(response) {
		for (const header of response.headers.getSetCookie()) {
			const [pair] = header.split(';', 1);
			const index = pair.indexOf('=');
			const name = pair.slice(0, index).trim();
			const value = pair.slice(index + 1).trim();
			if (value === 'deleted' || value === '') {
				this.cookies.delete(name);
			} else {
				this.cookies.set(name, value);
			}
		}
	}

	header() {
		return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
	}
}

async function send(jar, url, init = {}) {
	const headers = { ...init.headers, Cookie: jar.header() };
	// Browsers send Origin on every POST, and the Worker's CSRF check rejects form posts without it.
	if (init.method === 'POST') {
		headers.Origin = new URL(url).origin;
	}
	const response = await fetch(url, { ...init, redirect: 'manual', headers });
	jar.store(response);
	return response;
}

const hiddenValue = (html, name) => html.match(new RegExp(`name="${name}" value="([^"]*)"`))?.[1] ?? '';

/**
 * Logs in through the cookie-auth form and returns the jar and the session's CSRF token.
 * Without a persona it signs in as PMA_ORACLE_USER / PMA_ORACLE_PASSWORD (default customer).
 */
export async function oracleLogin(server = '1', persona) {
	let credentials = { user: ORACLE_USER, password: ORACLE_PASSWORD };
	if (persona !== undefined) {
		credentials = personaCredentials(persona, server);
	}
	const jar = new CookieJar();
	const formResponse = await send(jar, new URL('./index.php?route=/', ORACLE_URL));
	const form = await formResponse.text();
	const body = new URLSearchParams({
		route: '/',
		lang: 'en',
		token: hiddenValue(form, 'token'),
		set_session: hiddenValue(form, 'set_session'),
		pma_username: credentials.user,
		pma_password: credentials.password,
		server,
	});
	const login = await send(jar, new URL('./index.php?route=/', ORACLE_URL), { method: 'POST', body });
	if (login.status !== 302) {
		throw new Error(`Oracle login failed with HTTP ${login.status}`);
	}
	const homeResponse = await send(jar, new URL(login.headers.get('location'), ORACLE_URL));
	const home = await homeResponse.text();
	const token = home.match(/token:"([0-9a-f]+)"/)?.[1];
	if (!token) {
		throw new Error('Oracle login did not reach a signed-in page');
	}
	return { jar, token };
}

/**
 * Request parameters as phpMyAdmin's links send them: off the default server every URL and form carries server=n, without which it falls back to server 1.
 * @param {{ ajax: boolean, params: [string, string][] }} options
 * @param {string} server
 */
export function requestParams(options, server) {
	const params = new URLSearchParams(options.params);
	if (server !== '1' && !params.has('server')) {
		params.set('server', server);
	}
	if (options.ajax && !params.has('ajax_request')) {
		params.set('ajax_request', 'true');
	}
	return params;
}

async function sendRequest(jar, token, options, server) {
	const params = requestParams(options, server);
	const url = new URL('./index.php', ORACLE_URL);
	url.searchParams.set('route', options.route);
	const init = { headers: {} };
	if (options.ajax) {
		init.headers['X-Requested-With'] = 'XMLHttpRequest';
	}
	if (options.method === 'POST') {
		if (token && !params.has('token')) {
			params.set('token', token);
		}
		init.method = 'POST';
		init.body = postBody(params);
	} else {
		for (const [key, value] of params) {
			url.searchParams.append(key, value);
		}
	}
	return send(jar, url, init);
}

/** Runs one request against the oracle the way phpMyAdmin's own forms and ajax.js send it. */
export async function fetchOracle(options) {
	let jar = new CookieJar();
	let token = '';
	if (!options.signedOut) {
		({ jar, token } = await oracleLogin(options.server, options.user));
	}
	for (const [name, value] of extraCookies()) {
		jar.cookies.set(name, value);
	}
	for (const step of options.before ?? []) {
		const stepResponse = await sendRequest(jar, token, step, options.server);
		await stepResponse.text();
	}
	const response = await sendRequest(jar, token, options, options.server);
	return { status: response.status, headers: [...response.headers], body: await response.text(), token };
}

export function printResult(result, withHeaders) {
	if (withHeaders) {
		process.stdout.write(`HTTP ${result.status}\n`);
		for (const [name, value] of result.headers) {
			process.stdout.write(`${name}: ${value}\n`);
		}
		process.stdout.write('\n');
	}
	process.stdout.write(result.body);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	// Piping into head closes stdout early, which is not an error here.
	process.stdout.on('error', () => {});
	const options = parseArgs(process.argv.slice(2));
	printResult(await fetchOracle(options), options.headers);
}

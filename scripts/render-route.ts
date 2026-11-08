// Renders one route through our dispatcher in Node, signed in as the oracle's customer on the local MySQL 8.4.
// Usage: npx vite-node --config scripts/render-route.config.ts scripts/render-route.ts -- [--server <n>] [--user <persona>] [--post] [--ajax] [--headers] [--signed-out] [--before "[POST] <route> [key=value ...]"]... <route> [key=value ...]
// --server n signs in as on oracle server n (see ORACLE_SERVERS in pma-oracle.mjs); TLS servers connect through the Worker connector.
// --user signs in as one of PERSONAS in pma-oracle.mjs; it works per request in PMA_RENDER_SERVE mode too, since the argv is posted.
// Env: PMA_RENDER_DB_HOST/PORT override the connection, and PMA_RENDER_DB_USER/PASSWORD the login when --user is not given (default customer/customerpw).
import { createServer } from 'node:http';
import process from 'node:process';


import {
	extraCookies,
	oracleServer,
	parseStep,
	personaCredentials,
	postBody,
	requestParams,
} from './pma-oracle.mjs';
import { drainWaitUntil } from './stubs/cloudflare-workers.ts';

import type { APIContext } from 'astro';

import { createSessionId } from '~/lib/auth';
import { createRequestConnection } from '~/lib/connection';
import { connectFromWorker, connectWithMysql2 } from '~/server/mysql-connector';
import { dispatch } from '~/server/pma/dispatcher';
import { createScriptSession, startScriptSession } from '~/server/session-runtime';

// The same module the cloudflare:workers alias resolves to, so this sees the dispatcher's waitUntil() calls.


// The oracle serves on this host, so page titles and absolute URLs come out the same.
const ORIGIN = process.env.PMA_RENDER_ORIGIN ?? 'http://127.0.0.1:8088';

interface Options {
	method: 'GET' | 'POST';
	ajax: boolean;
	headers: boolean;
	signedOut: boolean;
	server: string;
	/** A PERSONAS name from --user; without one the PMA_RENDER_DB_USER env login is used. */
	user?: string;
	route: string;
	params: [string, string][];
	/** Earlier requests of the same login, run first so their session state carries over. */
	before: Options[];
}

// Git Bash rewrites "/route" arguments into Windows paths, so that is undone here as in pma-oracle.mjs.
function normalizeRoute(route: string): string {
	const mangled = /^[A-Za-z]:[/\\].*?[/\\]Git([/\\].*)?$/.exec(route);
	let path = route;
	if (mangled) {
		path = (mangled[1] ?? '/').replaceAll('\\', '/');
	}
	return path.startsWith('/') ? path : `/${path}`;
}

function parseArgs(argv: string[]): Options {
	const options: Options = { method: 'GET', ajax: false, headers: false, signedOut: false, server: '1', route: '/', params: [], before: [] };
	const rest: string[] = [];
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === '--before') {
			options.before.push(parseStep(argv[++index] ?? '') as unknown as Options);
		} else if (arg === '--server') {
			options.server = argv[++index] ?? '';
			oracleServer(options.server);
		} else if (arg === '--user') {
			options.user = argv[++index] ?? '';
		} else if (arg === '--post') {
			options.method = 'POST';
		} else if (arg === '--ajax') {
			options.ajax = true;
		} else if (arg === '--headers') {
			options.headers = true;
		} else if (arg === '--signed-out') {
			options.signedOut = true;
		} else if (arg !== '--') {
			rest.push(arg);
		}
	}
	if (rest.length > 0 && !rest[0].includes('=')) {
		options.route = normalizeRoute(rest.shift() as string);
	}
	for (const pair of rest) {
		const index = pair.indexOf('=');
		if (index === -1) {
			throw new Error(`Expected key=value, got "${pair}"`);
		}
		options.params.push([pair.slice(0, index), pair.slice(index + 1)]);
	}
	return options;
}

/** Just enough of AstroCookies for the dispatcher, recording what it sets as Set-Cookie lines. */
class ScriptCookies {
	readonly setCookies: string[] = [];

	constructor(private readonly values: Map<string, string>) {}

	get(name: string): { value: string; } | undefined {
		const value = this.values.get(name);
		return value === undefined ? undefined : { value };
	}

	has(name: string): boolean {
		return this.values.has(name);
	}

	// Attribute order and spelling follow the cookie package Astro serialises with.
	set(name: string, value: string, options: { path?: string; maxAge?: number; httpOnly?: boolean; secure?: boolean; sameSite?: string; } = {}): void {
		this.values.set(name, value);
		const parts = [`${name}=${encodeURIComponent(value)}`];
		if (options.maxAge !== undefined) {
			parts.push(`Max-Age=${options.maxAge}`);
		}
		parts.push(`Path=${options.path ?? '/'}`);
		if (options.httpOnly) {
			parts.push('HttpOnly');
		}
		if (options.secure) {
			parts.push('Secure');
		}
		if (options.sameSite) {
			parts.push(`SameSite=${options.sameSite[0].toUpperCase()}${options.sameSite.slice(1)}`);
		}
		this.setCookies.push(parts.join('; '));
	}

	remember(name: string, value: string): void {
		this.values.set(name, value);
	}

	forget(name: string): void {
		this.values.delete(name);
	}

	delete(name: string, options: { path?: string; } = {}): void {
		this.values.delete(name);
		this.setCookies.push(`${name}=deleted; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=${options.path ?? '/'}`);
	}
}

/** Keeps the cookies a response sets, as a browser would for the next request. */
function storeCookies(cookies: ScriptCookies, response: Response): void {
	for (const line of response.headers.getSetCookie()) {
		const [pair] = line.split(';', 1);
		const index = pair.indexOf('=');
		const name = pair.slice(0, index);
		const value = pair.slice(index + 1);
		if (value === '' || value === 'deleted' || /max-age=0|expires=thu, 01 jan 1970/i.test(line)) {
			cookies.forget(name);
		} else {
			cookies.remember(name, decodeURIComponent(value));
		}
	}
}

interface Login {
	user: string;
	password: string;
}

function loginFor(options: Options): Login {
	if (options.user !== undefined) {
		return personaCredentials(options.user, options.server) as Login;
	}
	return { user: process.env.PMA_RENDER_DB_USER ?? 'customer', password: process.env.PMA_RENDER_DB_PASSWORD ?? 'customerpw' };
}

async function renderOne(options: Options, server: string, sessionId: string, cookies: ScriptCookies, login: Login): Promise<Response> {
	// As the middleware does: a signed-in request loads the session, and a signed-out one gets a fresh session id.
	const locals = {} as App.Locals;
	let token = '';
	if (!options.signedOut) {
		const started = await startScriptSession(sessionId);
		token = started.token;
		locals.session = started.session;
		locals.sessionId = sessionId;
	} else {
		locals.sessionId = createSessionId();
	}
	const params = requestParams(options, server);
	const target = oracleServer(server);
	const url = new URL('/index.php', ORIGIN);
	url.searchParams.set('route', options.route);
	const init: RequestInit = { method: options.method, headers: {} };
	if (options.method === 'POST') {
		if (!options.signedOut && !params.has('token')) {
			params.set('token', token);
		}
		init.body = postBody(params);
		if (init.body === params) {
			init.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
		}
	} else {
		for (const [key, value] of params) {
			url.searchParams.append(key, value);
		}
	}
	if (!options.signedOut) {
		locals.auth = { user: login.user, host: target.host, server: `${target.host}:3306`, serverIndex: Number(server), token };
	}
	const astro = {
		request: new Request(url, init),
		url,
		cookies,
		locals,
		redirect: (location: string, status = 302) => new Response(null, { status, headers: { Location: location } }),
	} as unknown as APIContext;

	const settings = {
		host: process.env.PMA_RENDER_DB_HOST ?? target.connect.host,
		port: Number(process.env.PMA_RENDER_DB_PORT ?? target.connect.port),
		user: login.user,
		password: login.password,
		ssl: target.connect.ssl,
	};
	// The Worker connector is what verifies self-signed TLS servers in production; plain servers keep mysql2's own client.
	const connection = createRequestConnection(settings, settings.ssl ? connectFromWorker : connectWithMysql2);
	if (locals.auth) {
		locals.connection = connection;
	}
	try {
		const response = await dispatch(astro);
		// The body is read before the connection closes, as a streamed page may still be querying.
		return new Response(await response.arrayBuffer(), response);
	} finally {
		await connection.close();
		await drainWaitUntil();
	}
}

async function render(options: Options): Promise<{ status: number; headers: [string, string][]; body: Buffer; }> {
	const sessionId = await createScriptSession();
	const login = loginFor(options);
	// A signed-in browser already holds pma_lang from the login page, which changes how URLs are built.
	const cookies = new ScriptCookies(new Map(options.signedOut ? [] : [['pma_lang', 'en'], ...extraCookies()]));
	for (const step of options.before) {
		const response = await renderOne(step, options.server, sessionId, cookies, login);
		storeCookies(cookies, response);
		await response.text();
	}
	cookies.setCookies.length = 0;
	const response = await renderOne(options, options.server, sessionId, cookies, login);
	const headers: [string, string][] = [...response.headers];
	for (const line of cookies.setCookies) {
		headers.push(['set-cookie', line]);
	}
	// Bytes rather than text, so binary exports such as ODS reach stdout unchanged.
	return { status: response.status, headers, body: Buffer.from(await response.arrayBuffer()) };
}

async function renderText(argv: string[]): Promise<Buffer> {
	const options = parseArgs(argv);
	const result = await render(options);
	let head = '';
	if (options.headers) {
		head = `HTTP ${result.status}\n${result.headers.map(([name, value]) => `${name}: ${value}\n`).join('')}\n`;
	}
	return Buffer.concat([Buffer.from(head), result.body]);
}

/**
 * PMA_RENDER_SERVE=<port> keeps one warm process answering POSTs of a JSON argv, which pma-diff uses when PMA_RENDER_URL is set.
 * Requests run one at a time, as module state is shared like in one Worker isolate.
 */
function serve(port: number): void {
	let queue: Promise<unknown> = Promise.resolve();
	createServer((request, response) => {
		let body = '';
		request.on('data', (chunk: Buffer) => {
			body += chunk.toString('utf8');
		});
		request.on('end', () => {
			const task = queue.then(() => renderText(JSON.parse(body || '[]') as string[]));
			queue = task.catch(() => {});
			task.then((text) => {
				response.end(text);
			}).catch((error: unknown) => {
				response.statusCode = 500;
				response.end(error instanceof Error ? error.stack : String(error));
			});
		});
	}).listen(port, '127.0.0.1');
}

if (process.env.PMA_RENDER_SERVE) {
	serve(Number(process.env.PMA_RENDER_SERVE));
} else {
	process.stdout.on('error', () => {});
	process.stdout.write(await renderText(process.argv.slice(2)));
}

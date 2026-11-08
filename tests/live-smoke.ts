/**
 * Live smoke test of a running build (wrangler dev or a deployment) against a real MySQL server, signed in as an unprivileged customer account.
 * Usage: node tests/live-smoke.ts [baseUrl]
 * LIVE_SERVER (default 1) is the 1-based server in the build's PMA_SERVERS; LIVE_USER / LIVE_PASSWORD / LIVE_DATABASE / LIVE_TABLE must exist on it.
 */
import { upstreamRoutes } from '../src/server/pma/upstream-routes.ts';

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:8831';
const user = process.env.LIVE_USER ?? 'customer';
const password = process.env.LIVE_PASSWORD ?? 'customerpw';
const database = process.env.LIVE_DATABASE ?? 'customer_db';
const table = process.env.LIVE_TABLE ?? 'players';
const server = process.env.LIVE_SERVER ?? '1';

// Placeholders get a representative value; routes that change data on a bare GET are not crawled.
const placeholders: Record<string, string> = { engine: 'InnoDB', page: 'Status', name: 'max_connections' };
const skipped = new Set(['/logout', '/table/replace']);

const failures: string[] = [];
const check = (condition: boolean, message: string): void => {
	if (!condition) {
		failures.push(message);
	}
};

/** A minimal cookie jar, so the session and login cookies the server sends with each response carry over like in a browser. */
const jar = new Map<string, string>();
const remember = (response: Response): void => {
	for (const line of response.headers.getSetCookie()) {
		const [pair] = line.split(';', 1);
		const index = pair.indexOf('=');
		const name = pair.slice(0, index);
		if (/max-age=0|expires=thu, 01 jan 1970/i.test(line)) {
			jar.delete(name);
		} else {
			jar.set(name, pair.slice(index + 1));
		}
	}
};
const cookieHeader = (): string => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');

const send = async (target: string, init: RequestInit = {}): Promise<Response> => {
	const response = await fetch(`${baseUrl}${target}`, {
		...init,
		redirect: 'manual',
		// Astro refuses form POSTs without a same-origin Origin header, which browsers always send.
		headers: { Origin: baseUrl, ...(jar.size > 0 && { Cookie: cookieHeader() }), ...init.headers },
	});
	remember(response);
	return response;
};

const isLoginForm = (body: string): boolean => body.includes('name="pma_username"');

const login = (pmaPassword: string): Promise<Response> => send('/index.php?route=/', {
	method: 'POST',
	body: new URLSearchParams({ pma_username: user, pma_password: pmaPassword, server }),
});

// The docroot: index.php at / and /index.php, the two scripts that need no login, static files, and nothing else.
for (const target of ['/', '/index.php', '/index.php?route=/database/structure']) {
	const response = await send(target);
	check(response.status === 200 && isLoginForm(await response.text()), `signed-out GET ${target} must render the login form`);
}
for (const target of ['/login', '/logout', '/database/structure', '/api/databases']) {
	const response = await send(target);
	await response.body?.cancel();
	check(response.status === 404, `GET ${target} must be a 404, got ${response.status}`);
}
const messages = await send('/js/messages.php');
const messagesBody = await messages.text();
check(messages.status === 200 && messagesBody.startsWith('var Messages = {'), 'js/messages.php must serve the message catalog');
const redirect = await send(`/url.php?url=${encodeURIComponent('https://www.phpmyadmin.net/')}`);
const redirectBody = await redirect.text();
check(redirect.status === 200 && redirectBody.includes('Taking you to the target site.'), 'url.php must render its redirect page');
for (const asset of ['/themes/pmahomme/css/theme.css', '/js/dist/ajax.js', '/favicon.ico']) {
	const response = await send(asset);
	await response.body?.cancel();
	check(response.status === 200, `static ${asset} must be served, got ${response.status}`);
}

const rejected = await login('definitely-wrong');
const rejectedBody = await rejected.text();
check(rejectedBody.includes('Cannot log in to the MySQL server') && rejectedBody.includes('(HY000/1045)'), 'a wrong password must show the phpMyAdmin login failure');

const accepted = await login(password);
await accepted.body?.cancel();
const authCookie = `pmaAuth-${server}`;
check(accepted.status === 302 && jar.has(authCookie) && jar.has(`pmaUser-${server}`) && jar.has('phpMyAdmin'), 'valid credentials must sign in');
check(!jar.values().some(value => value.includes(password)), 'cookies must not contain the plaintext password');

// Off the default server every URL carries server=n, as phpMyAdmin's own links do.
const homeUrl = `/index.php?${new URLSearchParams({ route: '/', server })}`;
const signedIn = jar.get(authCookie) ?? '';
jar.set(authCookie, `AAAAAAAA${signedIn.slice(8)}`);
const tampered = await send(homeUrl);
check(isLoginForm(await tampered.text()), 'a tampered credentials cookie must be rejected');

// A rejected password cookie discards its session, as Session::secure() does, so sign in again.
const again = await login(password);
await again.body?.cancel();

const home = await send(homeUrl);
const homeBody = await home.text();
check(home.status === 200 && !isLoginForm(homeBody), 'GET / must render the home page when signed in');
const token = /name="token" value="([\da-f]+)"/.exec(homeBody)?.[1] ?? '';
check(token !== '', 'the home page must embed the session token');

let crawled = 0;
for (const route of upstreamRoutes) {
	if (!route.methods.includes('GET') || skipped.has(route.path)) {
		continue;
	}
	const path = route.path
		.replace(/^\[\/\]$/, '/')
		.replaceAll(/\[([^\]]+)\]/g, '$1')
		.replaceAll(/\{(\w+)\}/g, (_match, key: string) => placeholders[key] ?? key);
	const target = `/index.php?${new URLSearchParams({ route: path, db: database, table, server })}`;
	const response = await send(target);
	const body = await response.text();
	crawled += 1;
	// Upstream answers some bare requests with 400 or an empty body too (user-groups/edit-form, phpinfo), but never with 404 or 5xx.
	if (response.status === 404 || response.status >= 500) {
		failures.push(`${response.status} GET ${target}`);
	} else if (isLoginForm(body)) {
		failures.push(`unexpected sign-out on GET ${target}`);
	}
}

const copied = new Map(jar);
const loggedOut = await send('/index.php?route=/logout', { method: 'POST', body: new URLSearchParams({ token, server }) });
await loggedOut.body?.cancel();
check(loggedOut.status === 302 && !jar.has(authCookie), 'logout must clear the credentials cookie');

// Logout deletes the session itself, so a copy of the cookies taken before it no longer signs anyone in.
jar.clear();
for (const [name, value] of copied) {
	jar.set(name, value);
}
const replayed = await send(homeUrl);
check(isLoginForm(await replayed.text()), 'cookies copied before logout must not sign in');

console.log(`Crawled ${crawled} GET routes as ${user} on server ${server}.`);
if (failures.length > 0) {
	console.error(`${failures.length} failure(s):\n${failures.map(failure => `  - ${failure}`).join('\n')}`);
	process.exitCode = 1;
} else {
	console.log('Live smoke passed.');
}

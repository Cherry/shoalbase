import { execFileSync } from 'node:child_process';

import type { Browser, BrowserContext, Page } from '@playwright/test';

export type TargetName = 'oracle' | 'ours';

export interface Target {
	name: TargetName;
	baseUrl: string;
}

export interface Credentials {
	user: string;
	password: string;
}

export const ORACLE_URL = process.env.PMA_ORACLE_URL ?? 'http://127.0.0.1:8088/';
export const OURS_URL = process.env.PMA_VISUAL_URL ?? 'http://127.0.0.1:8841/';
const CUSTOMER: Credentials = {
	user: process.env.PMA_ORACLE_USER ?? 'customer',
	password: process.env.PMA_ORACLE_PASSWORD ?? 'customerpw',
};

let root: Credentials | undefined;

/** Root's password is read from the server 1 container's env so it never lands in the repo or a report. */
export function rootCredentials(): Credentials {
	if (!root) {
		const container = process.env.PMA_VISUAL_ROOT_CONTAINER ?? 'dbadmin-mysql';
		const env = JSON.parse(execFileSync('docker', ['inspect', container, '--format', '{{json .Config.Env}}'], { encoding: 'utf8' })) as string[];
		const entry = env.find(line => /^(?:MYSQL|MARIADB)_ROOT_PASSWORD=/.test(line));
		if (!entry) {
			throw new Error(`No root password in the env of container ${container}`);
		}
		root = { user: 'root', password: entry.slice(entry.indexOf('=') + 1) };
	}
	return root;
}

export const TARGETS: Target[] = [
	{ name: 'oracle', baseUrl: ORACLE_URL },
	{ name: 'ours', baseUrl: OURS_URL },
];

export const DB = 'customer_db';

/** Identical rendering settings for both sides so pixel differences come from markup and CSS only. */
export const CONTEXT_OPTIONS = {
	viewport: { width: 1280, height: 900 },
	deviceScaleFactor: 1,
	locale: 'en-US',
	timezoneId: 'UTC',
	colorScheme: 'light',
	reducedMotion: 'reduce',
} as const;

export interface Problems {
	consoleErrors: string[];
	failedRequests: string[];
}

/** Records console errors, uncaught exceptions and failed or 4xx/5xx requests for one page. */
export function watchProblems(page: Page): Problems {
	const problems: Problems = { consoleErrors: [], failedRequests: [] };
	page.on('console', (message) => {
		if (message.type() === 'error') {
			problems.consoleErrors.push(message.text());
		}
	});
	page.on('pageerror', (error) => {
		problems.consoleErrors.push(`pageerror: ${error.message}`);
	});
	page.on('requestfailed', (request) => {
		// Navigations that replace a pending request report net::ERR_ABORTED, which is not a server failure.
		const failure = request.failure()?.errorText ?? '';
		if (failure !== 'net::ERR_ABORTED') {
			problems.failedRequests.push(`${request.method()} ${request.url()} ${failure}`);
		}
	});
	page.on('response', (response) => {
		if (response.status() >= 400) {
			problems.failedRequests.push(`${response.request().method()} ${response.url()} HTTP ${response.status()}`);
		}
	});
	return problems;
}

/** Strips the host so problems from both sides compare equal when they are the same request. */
export function relativeProblems(problems: Problems, target: Target): Problems {
	const strip = (line: string): string => line.replaceAll(target.baseUrl, '/');
	return {
		consoleErrors: problems.consoleErrors.map(line => strip(line)),
		failedRequests: problems.failedRequests.map(line => strip(line)),
	};
}

/** Builds an index.php URL the way phpMyAdmin links do, with route first. */
export function routeUrl(target: Target, route: string, params: Record<string, string> = {}): string {
	const url = new URL('./index.php', target.baseUrl);
	url.searchParams.set('route', route);
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value);
	}
	return url.href;
}

/** Waits until ajax requests and phpMyAdmin's own loading notices have settled. */
export async function settle(page: Page): Promise<void> {
	await page.waitForLoadState('networkidle');
	await page.waitForFunction(() => {
		const jq = (window as unknown as { jQuery?: { active: number; }; }).jQuery;
		const busy = document.querySelector('#loading_parent .ajax_notification, .ajax_notification:not(.hide)');
		return (!jq || jq.active === 0) && !busy?.textContent?.includes('Loading');
	}, undefined, { timeout: 15000 }).catch(() => {});
	await page.evaluate(async () => {
		// jQuery slide and fade animations are not covered by Playwright's CSS animation freezing.
		const jq = (window as unknown as { jQuery?: { fx: { off: boolean; }; }; }).jQuery;
		if (jq) {
			jq.fx.off = true;
		}
		await document.fonts.ready;
	});
	await page.waitForTimeout(300);
}

/** Signs in through the cookie-auth form on server 1, like a customer would. */
export async function login(page: Page, target: Target, credentials: Credentials = CUSTOMER): Promise<void> {
	await page.goto(routeUrl(target, '/'));
	await page.locator('#input_username').fill(credentials.user);
	await page.locator('#input_password').fill(credentials.password);
	const server = page.locator('#select_server');
	if (await server.count() > 0) {
		await server.selectOption('1');
	}
	await Promise.all([
		page.waitForURL(url => !url.toString().includes('login'), { timeout: 30000 }).catch(() => {}),
		page.locator('#input_go').click(),
	]);
	await page.locator('#pma_navigation').waitFor({ timeout: 30000 });
	await settle(page);
}

/** Expands customer_db and its Tables group in the navigation tree; vpath values are base64 node names. */
export async function expandNavigation(page: Page): Promise<void> {
	const tree = page.locator('#pma_navigation_tree');
	await tree.locator(`li.database:has(a:text-is("${DB}")) a.expander`).first().click();
	const tables = tree.locator('a.expander.container:has(span[data-vpath$=".VGFibGVz"])').first();
	const players = tree.locator('a.hover_show_full:text-is("players")').first();
	// phpMyAdmin only adds the Tables group when the database also holds views, routines or events.
	await tables.or(players).first().waitFor({ timeout: 15000 });
	if (await tables.locator('img.ic_b_plus').count() > 0) {
		await tables.click();
	}
	await players.waitFor({ state: 'visible', timeout: 15000 });
	await settle(page);
}

/** Drops user account rows other than the fixed personas, since scratch accounts of parallel runs come and go between the two captures. */
export async function keepFixedAccounts(page: Page): Promise<void> {
	await page.evaluate(() => {
		// The initials row only appears past 20 accounts, so it depends on those scratch accounts too.
		document.querySelector('#userAccountsPagination')?.closest('nav')?.remove();
		const fixed = new Set(['root', 'customer', 'pma_grant', 'pma_creator']);
		for (const box of document.querySelectorAll<HTMLInputElement>('#userRightsTable input[name="selected_usr[]"]')) {
			// Upstream escapes the user/host separator twice, so the value reads "user&amp;#27;host".
			const user = box.value.split(/&(?:amp;)*#27;/, 1)[0];
			if (!fixed.has(user) && !user.startsWith('mysql.')) {
				box.closest('tr')?.remove();
			}
		}
	});
}

export interface Session {
	context: BrowserContext;
	page: Page;
	problems: Problems;
}

export async function openSession(browser: Browser, target: Target, signedIn = true, credentials: Credentials = CUSTOMER): Promise<Session> {
	const context = await browser.newContext(CONTEXT_OPTIONS);
	const page = await context.newPage();
	const problems = watchProblems(page);
	if (signedIn) {
		await login(page, target, credentials);
	}
	return { context, page, problems };
}

import { writeFileSync } from 'node:fs';
import path from 'node:path';

import {
	type Browser,
	type Page,
	expect,
	test,
} from '@playwright/test';

import { REPORT_DIR, compareScreens } from './support/diff.ts';
import { snapshot } from './support/snapshot.ts';
import {
	type Credentials,
	DB,
	TARGETS,
	type Target,
	expandNavigation,
	keepFixedAccounts,
	openSession,
	relativeProblems,
	rootCredentials,
	routeUrl,
	settle,
} from './support/targets.ts';

interface Screen {
	name: string;
	route: string;
	params?: Record<string, string>;
	signedIn?: boolean;
	/** Signs in as root on server 1 instead of the customer, for the administration pages. */
	asRoot?: boolean;
	/** Extra steps after the page loads, such as opening the console or a modal. */
	prepare?: (page: Page) => Promise<void>;
	/** Regions whose content changes between two loads (uptime, counters, server-side timings). */
	mask?: string[];
	/** Rows whose count changes between two loads; removed from layout so page heights stay comparable. */
	hide?: string[];
}

const table = { db: DB, table: 'players' };

const SCREENS: Screen[] = [
	{ name: 'login', route: '/', signedIn: false },
	{ name: 'home', route: '/' },
	{ name: 'database-structure', route: '/database/structure', params: { db: DB } },
	{ name: 'browse-players', route: '/sql', params: { ...table, pos: '0' } },
	{ name: 'browse-players-sorted', route: '/sql', params: { ...table, sql_query: 'SELECT * FROM `players` ORDER BY `name` DESC' } },
	{ name: 'browse-paginated', route: '/sql', params: { db: DB, table: 'vis_pages', pos: '25' } },
	{ name: 'table-structure', route: '/table/structure', params: table },
	{ name: 'insert-form', route: '/table/change', params: table },
	{ name: 'edit-form', route: '/table/change', params: { ...table, where_clause: '`players`.`id` = 1' } },
	{ name: 'table-search', route: '/table/search', params: table },
	{ name: 'database-search', route: '/database/search', params: { db: DB } },
	{ name: 'table-sql', route: '/table/sql', params: table },
	{
		name: 'sql-run-select',
		route: '/table/sql',
		params: table,
		prepare: async (page) => {
			await page.evaluate(() => {
				const editor = (document.querySelector('#sqlquery + .CodeMirror') as unknown as { CodeMirror?: { setValue: (value: string) => void; }; } | null)?.CodeMirror;
				if (editor) {
					editor.setValue('SELECT `id`, `name` FROM `players` WHERE `score` > 20');
				} else {
					(document.querySelector('#sqlquery') as HTMLTextAreaElement).value = 'SELECT `id`, `name` FROM `players` WHERE `score` > 20';
				}
			});
			await page.locator('#button_submit_query').click();
			await page.locator('.result_query').first().waitFor({ timeout: 15000 });
		},
	},
	{ name: 'table-operations', route: '/table/operations', params: table },
	{ name: 'database-operations', route: '/database/operations', params: { db: DB } },
	{ name: 'table-export', route: '/table/export', params: table },
	{ name: 'server-export', route: '/server/export' },
	{ name: 'table-import', route: '/table/import', params: table },
	{ name: 'server-import', route: '/server/import' },
	{ name: 'server-databases', route: '/server/databases' },
	{ name: 'server-status', route: '/server/status', mask: ['#page_content table.table-striped', 'p:has-text("running for")', 'p:has-text("server has been")'] },
	{ name: 'server-variables', route: '/server/variables', mask: ['#serverVariables tr:has-text("timestamp") td.value', '#serverVariables tr:has-text("pseudo_thread_id") td.value', '#serverVariables tr:has-text("rand_seed") td.value'] },
	{ name: 'preferences-manage', route: '/preferences/manage' },
	{ name: 'preferences-features', route: '/preferences/features' },
	{ name: 'user-password', route: '/user-password' },
	{ name: 'preferences-sql', route: '/preferences/forms', params: { form: 'Sql' } },
	{ name: 'database-sql', route: '/database/sql', params: { db: DB } },
	{ name: 'database-export', route: '/database/export', params: { db: DB } },
	{ name: 'database-import', route: '/database/import', params: { db: DB } },
	{ name: 'database-routines', route: '/database/routines', params: { db: DB } },
	{ name: 'database-events', route: '/database/events', params: { db: DB } },
	{ name: 'database-triggers', route: '/database/triggers', params: { db: DB } },
	{ name: 'database-qbe', route: '/database/multi-table-query', params: { db: DB } },
	{ name: 'table-relation', route: '/table/relation', params: table },
	{ name: 'table-triggers', route: '/database/triggers', params: table },
	{ name: 'server-sql', route: '/server/sql' },
	{ name: 'sql-syntax-error', route: '/sql', params: { ...table, sql_query: 'SELEC * FROM `players`' } },
	{ name: 'table-missing', route: '/table/structure', params: { db: DB, table: 'vis_missing' } },
	{ name: 'browse-scratch-edit', route: '/sql', params: { db: DB, table: 'vis_pages', pos: '0', session_max_rows: '5' } },
	{ name: 'server-engines', route: '/server/engines' },
	{ name: 'server-charset', route: '/server/collations' },
	{ name: 'server-plugins', route: '/server/plugins' },
	// Other connections come and go between the two captures, so process rows are removed rather than masked to keep the height equal.
	{ name: 'server-status-processes', route: '/server/status/processes', hide: ['#tableprocesslist tbody tr'] },
	{ name: 'server-status-variables', route: '/server/status/variables', mask: ['#serverStatusVariables tbody td'] },
	{
		name: 'navigation-expanded',
		route: '/',
		prepare: async (page) => {
			await expandNavigation(page);
		},
	},
	{
		name: 'console-open',
		route: '/',
		prepare: async (page) => {
			await page.locator('#pma_console .console_switch').first().click();
			await page.locator('#pma_console > .content').first().waitFor({ state: 'visible', timeout: 10000 });
		},
	},
	{ name: 'privileges-overview', route: '/server/privileges', asRoot: true, prepare: keepFixedAccounts },
	{ name: 'privileges-edit', route: '/server/privileges', params: { username: 'customer', hostname: '%' }, asRoot: true },
	{ name: 'privileges-edit-db', route: '/server/privileges', params: { username: 'customer', hostname: '%', dbname: DB }, asRoot: true },
	{ name: 'privileges-add-user', route: '/server/privileges', params: { adduser: '1' }, asRoot: true },
	// The binary log position moves with every write other clients make between the two captures.
	{ name: 'replication', route: '/server/replication', asRoot: true, mask: ['#serverprimaryreplicationsummary td'] },
	{
		name: 'page-settings-modal',
		route: '/server/export',
		prepare: async (page) => {
			await page.locator('#page_settings_icon').click();
			await page.locator('.modal.show, .ui-dialog').first().waitFor({ state: 'visible', timeout: 10000 });
		},
	},
];

async function capture(browser: Browser, target: Target, screen: Screen) {
	let credentials: Credentials | undefined;
	if (screen.asRoot) {
		credentials = rootCredentials();
	}
	const session = await openSession(browser, target, screen.signedIn ?? true, credentials);
	const { page } = session;
	try {
		await page.goto(routeUrl(target, screen.route, screen.params ?? {}));
		await settle(page);
		if (screen.prepare) {
			await screen.prepare(page);
			await settle(page);
		}
		const mask = [...screen.mask ?? []];
		if (screen.asRoot) {
			// Root sees every database on the server, including scratch databases other runs create and drop.
			mask.push('#pma_navigation_tree');
		}
		const image = await snapshot(page, mask, screen.hide);
		return { image, problems: relativeProblems(session.problems, target), url: page.url() };
	} finally {
		await session.context.close();
	}
}

for (const screen of SCREENS) {
	test(`screen ${screen.name}`, async ({ browser }) => {
		const [oracleTarget, oursTarget] = TARGETS;
		const oracle = await capture(browser, oracleTarget, screen);
		const ours = await capture(browser, oursTarget, screen);
		const result = compareScreens(screen.name, oracle.image, ours.image);
		const record = {
			...result,
			oracleUrl: oracle.url,
			oursUrl: ours.url,
			oracleProblems: oracle.problems,
			oursProblems: ours.problems,
		};
		writeFileSync(path.join(REPORT_DIR, screen.name, 'result.json'), JSON.stringify(record, null, '\t'));
		expect.soft(ours.problems, 'console errors and failed requests should match the oracle').toEqual(oracle.problems);
		expect.soft(result.oursSize, 'page size should match the oracle').toBe(result.oracleSize);
		expect.soft(result.diffPixels, `pixel difference, see ${result.sideBySide}`).toBe(0);
	});
}

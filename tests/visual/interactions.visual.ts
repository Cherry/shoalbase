import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
	type Browser,
	type Page,
	expect,
	test,
} from '@playwright/test';

import { createPagesTable, withDb } from './support/db.ts';
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

type Outcome = Record<string, unknown>;

interface Check {
	name: string;
	/** Recreates the scratch tables before each side runs so both start from identical data. */
	setup?: () => Promise<void>;
	/** Signs in as root on server 1 instead of the customer, for the administration pages. */
	asRoot?: boolean;
	run: (page: Page, target: Target) => Promise<Outcome>;
}

const text = async (page: Page, selector: string): Promise<string[]> => {
	const values = await page.locator(selector).allInnerTexts();
	return values.map(value => value.replaceAll(/\s+/g, ' ').trim().replaceAll(/Query took \d+\.\d+ seconds/g, 'Query took X seconds'));
};

/** The visible ajax notice phpMyAdmin shows after an action, if any. */
const notice = async (page: Page): Promise<string[]> => text(page, '#loading_parent .ajax_notification:visible, #page_content .alert:visible');

/** The first data cell of every result row, which is the id column in the scratch tables. */
const firstColumn = async (page: Page): Promise<string[]> => page.locator('table.table_results tbody tr').evaluateAll(rows => rows.map(row => row.querySelector('td.data')?.textContent?.trim() ?? ''));

const createEditTable = async (): Promise<void> => {
	await withDb(async (connection) => {
		await connection.query('DROP TABLE IF EXISTS `vis_edit`');
		await connection.query('CREATE TABLE `vis_edit` (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, name VARCHAR(32) NOT NULL, score INT NOT NULL DEFAULT 0) ENGINE=InnoDB');
		await connection.query('INSERT INTO `vis_edit` (name, score) VALUES (\'alpha\', 1), (\'beta\', 2), (\'gamma\', 3)');
	});
};

const editRows = async (): Promise<unknown> => withDb(async (connection) => {
	const [rows] = await connection.query('SELECT id, name, score FROM `vis_edit` ORDER BY id');
	return rows;
});

const CHECKS: Check[] = [
	{
		name: 'inline-edit',
		setup: createEditTable,
		run: async (page, target) => {
			await page.goto(routeUrl(target, '/sql', { db: DB, table: 'vis_edit', pos: '0' }));
			await settle(page);
			const cell = page.locator('table.table_results tbody tr').first().locator('td.data')
				.nth(1);
			await cell.dblclick();
			const editor = page.locator('.cEdit .edit_box:visible').first();
			await editor.waitFor({ state: 'visible', timeout: 10000 });
			await editor.fill('alpha edited');
			await editor.press('Enter');
			await settle(page);
			const cellText = await cell.textContent();
			return {
				cell: cellText?.trim(),
				notice: await notice(page),
				rows: await editRows(),
			};
		},
	},
	{
		name: 'sort-header',
		setup: async () => withDb(connection => createPagesTable(connection, 'vis_pages')),
		run: async (page, target) => {
			await page.goto(routeUrl(target, '/sql', { db: DB, table: 'vis_pages', pos: '0' }));
			await settle(page);
			const header = page.locator('th[data-column="amount"] a.sortlink');
			await header.click();
			await settle(page);
			const ascending = await firstColumn(page);
			await page.locator('th[data-column="amount"] a.sortlink').click();
			await settle(page);
			const descending = await firstColumn(page);
			return {
				ascending: ascending.slice(0, 6),
				descending: descending.slice(0, 6),
				sqlShown: await text(page, '#page_content .result_query code.sql, #page_content .result_query .sqlOuter'),
			};
		},
	},
	{
		name: 'paginate',
		setup: async () => withDb(connection => createPagesTable(connection, 'vis_pages')),
		run: async (page, target) => {
			await page.goto(routeUrl(target, '/sql', { db: DB, table: 'vis_pages', pos: '0' }));
			await settle(page);
			const firstPage = await firstColumn(page);
			await page.locator('form:has(input[name="pos"]) input[name="navig"][title="Next"]').first().click();
			await settle(page);
			const secondPage = await firstColumn(page);
			const status = await text(page, '#page_content .result_query .alert-success');
			await page.locator('form:has(input[name="pos"]) input[name="navig"][title="Previous"]').first().click();
			await settle(page);
			const backTo = await firstColumn(page);
			return { firstPage, secondPage, status, backTo: backTo.slice(0, 3) };
		},
	},
	{
		name: 'console-query',
		setup: async () => withDb(connection => createPagesTable(connection, 'vis_pages')),
		run: async (page, target) => {
			await page.goto(routeUrl(target, '/'));
			await settle(page);
			await page.locator('#pma_console .console_switch').first().click();
			const input = page.locator('#pma_console .console_query_input .CodeMirror').first();
			await input.waitFor({ state: 'visible', timeout: 10000 });
			await input.click();
			await page.keyboard.type('SELECT COUNT(*) AS total FROM `customer_db`.`vis_pages`');
			await page.keyboard.press('Control+Enter');
			await page.locator('#page_content .result_query').first().waitFor({ timeout: 15000 });
			await settle(page);
			return {
				result: await text(page, '#page_content table.table_results tbody td.data'),
				status: await text(page, '#page_content .result_query .alert-success'),
				consoleMessages: await text(page, '#pma_console .console_message_container .message .query'),
			};
		},
	},
	{
		name: 'navigation-expand-collapse',
		run: async (page, target) => {
			await page.goto(routeUrl(target, '/'));
			await settle(page);
			await expandNavigation(page);
			const expanded = await text(page, '#pma_navigation_tree li.database:has(a:text-is("customer_db")) .list_container a.hover_show_full:visible');
			await page.locator('#pma_navigation_collapse').click();
			await settle(page);
			const afterCollapse = await text(page, '#pma_navigation_tree a.hover_show_full:visible');
			return {
				expandedIncludesPlayers: expanded.includes('players'),
				expandedFirst: expanded.slice(0, 5),
				afterCollapse,
			};
		},
	},
	{
		name: 'insert-form',
		setup: createEditTable,
		run: async (page, target) => {
			await page.goto(routeUrl(target, '/table/change', { db: DB, table: 'vis_edit' }));
			await settle(page);
			await page.locator('#field_2_3').fill('delta');
			await page.locator('#field_3_3').fill('4');
			await page.locator('#buttonYes').click();
			await page.locator('#page_content .result_query, #page_content .alert').first().waitFor({ timeout: 15000 });
			await settle(page);
			return {
				notice: await notice(page),
				sql: await text(page, '#page_content .result_query code.sql'),
				rows: await editRows(),
			};
		},
	},
	{
		name: 'drop-table-confirm',
		setup: async () => withDb(async (connection) => {
			await connection.query('DROP TABLE IF EXISTS `vis_drop`');
			await connection.query('CREATE TABLE `vis_drop` (id INT PRIMARY KEY) ENGINE=InnoDB');
		}),
		run: async (page, target) => {
			await page.goto(routeUrl(target, '/database/structure', { db: DB }));
			await settle(page);
			await page.locator('table.data tr:has(th a:text-is("vis_drop")) a.drop_table_anchor').click();
			const dialog = page.locator('#functionConfirmModal.show, .ui-dialog:visible').first();
			await dialog.waitFor({ state: 'visible', timeout: 10000 });
			await settle(page);
			const question = await dialog.locator('.modal-body, .ui-dialog-content').first().textContent() ?? '';
			await dialog.locator('#functionConfirmOkButton, button:has-text("OK")').first().click();
			await settle(page);
			const exists = await withDb(async (connection) => {
				const [rows] = await connection.query(String.raw`SHOW TABLES LIKE 'vis\_drop'`);
				return (rows as unknown[]).length > 0;
			});
			return {
				question: question.replaceAll(/\s+/g, ' ').trim(),
				notice: await notice(page),
				rowStillListed: await page.locator('table.data tr:has(th a:text-is("vis_drop"))').count(),
				exists,
			};
		},
	},
	{
		name: 'privileges-export-dialog',
		asRoot: true,
		run: async (page, target) => {
			await page.goto(routeUrl(target, '/server/privileges'));
			await settle(page);
			await keepFixedAccounts(page);
			await page.locator('#userRightsTable tr:has(input[value^="customer&"]) a.export_user_anchor').click();
			const modal = page.locator('#exportPrivilegesModal');
			await modal.locator('.modal-body textarea').first().waitFor({ state: 'attached', timeout: 15000 });
			await settle(page);
			return {
				title: await text(page, '#exportPrivilegesModal .modal-title'),
				grants: await modal.locator('.modal-body textarea').first().inputValue(),
			};
		},
	},
	{
		name: 'privileges-edit-link',
		asRoot: true,
		run: async (page, target) => {
			await page.goto(routeUrl(target, '/server/privileges'));
			await settle(page);
			await page.locator('#userRightsTable tr:has(input[value^="customer&"]) td.text-center a.edit_user_anchor').click();
			await page.locator('#page_content form#addUsersForm, #page_content #fieldset_user_global_rights').first().waitFor({ timeout: 15000 });
			await settle(page);
			return {
				url: page.url().replace(target.baseUrl, '/'),
				headings: await text(page, '#page_content h2, #page_content legend'),
				checked: await page.locator('#page_content input[type="checkbox"]:checked').count(),
			};
		},
	},
];

async function runSide(browser: Browser, target: Target, check: Check) {
	await check.setup?.();
	let credentials: Credentials | undefined;
	if (check.asRoot) {
		credentials = rootCredentials();
	}
	const session = await openSession(browser, target, true, credentials);
	try {
		let outcome: Outcome;
		try {
			outcome = await check.run(session.page, target);
		} catch (error) {
			outcome = { error: (error as Error).message.split('\n', 1)[0] };
		}
		await settle(session.page);
		const mask: string[] = [];
		if (check.asRoot) {
			// Root sees every database on the server, including scratch databases other runs create and drop.
			mask.push('#pma_navigation_tree');
		}
		const image = await snapshot(session.page, mask);
		return { outcome, image, problems: relativeProblems(session.problems, target) };
	} finally {
		await session.context.close();
	}
}

for (const check of CHECKS) {
	test(`interaction ${check.name}`, async ({ browser }) => {
		const [oracleTarget, oursTarget] = TARGETS;
		const oracle = await runSide(browser, oracleTarget, check);
		const ours = await runSide(browser, oursTarget, check);
		const screen = `interaction-${check.name}`;
		mkdirSync(path.join(REPORT_DIR, screen), { recursive: true });
		const diff = await compareScreens(screen, oracle.image, ours.image);
		const record = {
			check: screen,
			oracle: oracle.outcome,
			ours: ours.outcome,
			oracleProblems: oracle.problems,
			oursProblems: ours.problems,
			diffPixels: diff.diffPixels,
			sideBySide: diff.sideBySide,
		};
		writeFileSync(path.join(REPORT_DIR, screen, 'result.json'), JSON.stringify(record, null, '\t'));
		expect.soft(ours.outcome, 'interaction outcome should match the oracle').toEqual(oracle.outcome);
		expect.soft(ours.problems, 'console errors and failed requests should match the oracle').toEqual(oracle.problems);
		expect.soft(diff.diffPixels, `final state pixel difference, see ${diff.sideBySide}`).toBe(0);
	});
}

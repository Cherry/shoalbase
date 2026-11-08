// Crawls every customer-reachable upstream route through pma-diff.mjs on each oracle server and writes a parity report.
// Usage: npm run parity:crawl -- [--server 1,2,3] [--user <persona> (report goes to users/<persona>/)] [--only <substring> (report goes to partial/)] [--jobs <n>] [--keep] [--no-setup]
// Creates pc_* scratch objects in customer_db on each server first (dropped again unless --keep), and writes tests/parity-report/.
// Each differing case is retried once, so a case that matches on the retry is reported as flaky rather than as a gap.
import { execFile, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { JSDOM } from 'jsdom';
import mysql from 'mysql2/promise';

import { ORACLE_SERVERS, PERSONAS, fetchOracle } from './pma-oracle.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPORT_DIR = path.join(ROOT, 'tests', 'parity-report');
// An --only run writes under partial/ so it never replaces the last full report.
let reportDir = REPORT_DIR;
const DB = 'customer_db';
const DIFF_TIMEOUT_MS = 180000;
const RENDER_PORT_BASE = 47800;
// The --user persona every case signs in as; undefined keeps pma-diff's default customer.
let persona;
const userArgs = () => (persona === undefined ? [] : ['--user', persona]);

const run = promisify(execFile);
const b64 = text => Buffer.from(text).toString('base64');

function parseCli(argv) {
	const options = { servers: Object.keys(ORACLE_SERVERS), only: '', jobs: 4, keep: false, setup: true };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === '--server') {
			options.servers = argv[++index].split(',');
		} else if (arg === '--user') {
			options.user = argv[++index];
			if (!Object.hasOwn(PERSONAS, options.user)) {
				throw new Error(`Unknown --user "${options.user}"`);
			}
		} else if (arg === '--only') {
			options.only = argv[++index];
		} else if (arg === '--jobs') {
			options.jobs = Number(argv[++index]);
		} else if (arg === '--keep') {
			options.keep = true;
		} else if (arg === '--no-setup') {
			options.setup = false;
		} else if (arg !== '--') {
			throw new Error(`Unknown argument "${arg}"`);
		}
	}
	return options;
}

// One statement per object, so a privilege the customer lacks on one server only skips the cases that need that object.
const SCRATCH_DROP = [
	'DROP EVENT IF EXISTS pc_evt',
	'DROP TRIGGER IF EXISTS pc_trg',
	'DROP FUNCTION IF EXISTS pc_func',
	'DROP PROCEDURE IF EXISTS pc_proc',
	'DROP VIEW IF EXISTS pc_view',
	'DROP TABLE IF EXISTS pc_child',
	'DROP TABLE IF EXISTS pc_parent',
];

const parentRows = Array.from({ length: 30 }, (_, index) => {
	const id = index + 1;
	const kind = id % 2 === 0 ? 'beta' : 'alpha';
	const note = id % 3 === 0 ? 'NULL' : `'note ${id}'`;
	const day = String((id % 28) + 1).padStart(2, '0');
	return `('row${String(id).padStart(2, '0')}', '${kind}', 'x${id % 2 === 0 ? ',y' : ''}', ${(id * 1.5).toFixed(2)}, '2020-01-${day}', ${note})`;
});

const SCRATCH_CREATE = [
	{ object: 'table', sql: 'CREATE TABLE pc_parent (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, name VARCHAR(32) NOT NULL, kind ENUM(\'alpha\',\'beta\') NOT NULL DEFAULT \'alpha\', flags SET(\'x\',\'y\') NULL, amount DECIMAL(8,2) NULL, born DATE NULL, note TEXT NULL, KEY pc_name_idx (name), KEY pc_multi (kind, born)) ENGINE=InnoDB COMMENT=\'parity crawl\'' },
	{ object: 'table', sql: `INSERT INTO pc_parent (name, kind, flags, amount, born, note) VALUES ${parentRows.join(', ')}` },
	{ object: 'fk', sql: 'CREATE TABLE pc_child (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, parent_id INT NOT NULL, label VARCHAR(16) NOT NULL, KEY pc_child_parent (parent_id), CONSTRAINT pc_child_fk FOREIGN KEY (parent_id) REFERENCES pc_parent (id) ON DELETE CASCADE) ENGINE=InnoDB' },
	{ object: 'fk', sql: 'INSERT INTO pc_child (parent_id, label) VALUES (1, \'one\'), (2, \'two\'), (2, \'two-b\')' },
	{ object: 'view', sql: 'CREATE VIEW pc_view AS SELECT id, name FROM pc_parent WHERE kind = \'alpha\'' },
	{ object: 'procedure', sql: 'CREATE PROCEDURE pc_proc(IN n INT) SELECT n * 2 AS doubled' },
	{ object: 'function', sql: 'CREATE FUNCTION pc_func(x INT) RETURNS INT DETERMINISTIC RETURN x + 1' },
	{ object: 'trigger', sql: 'CREATE TRIGGER pc_trg BEFORE INSERT ON pc_child FOR EACH ROW SET NEW.label = LOWER(NEW.label)' },
	{ object: 'event', sql: 'CREATE EVENT pc_evt ON SCHEDULE EVERY 1 DAY STARTS \'2030-01-01 00:00:00\' DISABLE DO DELETE FROM pc_child WHERE id < 0' },
	{ object: 'table', sql: 'ANALYZE TABLE pc_parent, pc_child' },
];

async function connectScratch(server) {
	const { host, port, ssl } = ORACLE_SERVERS[server].connect;
	// The local test servers use self-signed certificates; this connection only manages scratch objects.
	const tls = ssl ? { rejectUnauthorized: false } : undefined;
	return mysql.createConnection({ host, port, user: 'customer', password: 'customerpw', database: DB, ssl: tls });
}

/** Creates the scratch objects and returns the kinds the customer could not create on this server. */
async function setupScratch(server) {
	const connection = await connectScratch(server);
	const missing = new Map();
	try {
		for (const statement of SCRATCH_DROP) {
			await connection.query(statement);
		}
		for (const { object, sql } of SCRATCH_CREATE) {
			if (missing.has(object)) {
				continue;
			}
			try {
				await connection.query(sql);
			} catch (error) {
				missing.set(object, error.message);
			}
		}
	} finally {
		await connection.end();
	}
	return missing;
}

async function dropScratch(server) {
	const connection = await connectScratch(server);
	try {
		for (const statement of SCRATCH_DROP) {
			await connection.query(statement);
		}
	} finally {
		await connection.end();
	}
}

const navParams = (aPath, vPath) => [`aPath=${aPath}`, `vPath=${vPath}`, 'pos=0', 'pos2_name=', 'pos2_value=', 'searchClause=', 'searchClause2='];

/** The SQL tab's form as sql.js submits it to /import. */
function sqlTab(id, query, db = DB, needs = []) {
	const goto = db ? 'index.php?route=/database/sql' : 'index.php?route=/server/sql';
	return {
		id,
		needs,
		args: ['--post', '--ajax', 'import', `db=${db}`, 'is_js_confirmed=0', 'pos=0', `goto=${goto}`, 'message_to_show=Your SQL query has been executed successfully.', 'prev_sql_query=', `sql_query=${query}`, 'sql_delimiter=;', 'show_query=1', 'fk_checks=0', 'fk_checks=1', 'SQL=Go'],
	};
}

/** A full page load and the ajax_page_request load the menu links make. */
function page(id, route, params = [], needs = []) {
	return [
		{ id, needs, args: [route, ...params] },
		{ id: `${id}~ajax`, needs, args: ['--ajax', route, ...params, 'ajax_page_request=true'] },
	];
}

const ajax = (id, route, params = [], needs = []) => { return { id, needs, args: ['--ajax', route, ...params] }; };
const post = (id, route, params = [], needs = []) => { return { id, needs, args: ['--post', '--ajax', route, ...params] }; };

function staticCases() {
	const db = `db=${DB}`;
	const parent = [db, 'table=pc_parent'];
	const dbPath = `${b64('root')}.${b64(DB)}`;
	const group = (key, label) => navParams(`${dbPath}.${b64(key)}`, `${dbPath}.${b64(label)}`);
	const tablePath = [`${dbPath}.${b64('tables')}.${b64('pc_parent')}`, `${dbPath}.${b64('Tables')}.${b64('pc_parent')}`];
	const browse = (id, params) => post(id, 'sql', [...parent, 'goto=', 'is_browse_distinct=', ...params]);
	return [
		// Server level.
		...page('home', '/'),
		...page('server-databases', 'server/databases'),
		...page('server-sql', 'server/sql'),
		...page('server-status', 'server/status'),
		...page('server-status-advisor', 'server/status/advisor'),
		...page('server-status-monitor', 'server/status/monitor'),
		...page('server-status-queries', 'server/status/queries'),
		...page('server-status-variables', 'server/status/variables'),
		...page('server-status-processes', 'server/status/processes'),
		...page('server-variables', 'server/variables'),
		...page('server-collations', 'server/collations'),
		...page('server-engines', 'server/engines'),
		...page('server-engine-innodb', 'server/engines/InnoDB'),
		...page('server-engine-innodb-status', 'server/engines/InnoDB/Status'),
		...page('server-plugins', 'server/plugins'),
		...page('server-privileges', 'server/privileges'),
		...page('server-replication', 'server/replication'),
		...page('server-binlog', 'server/binlog'),
		...page('server-user-groups', 'server/user-groups'),
		...page('server-export', 'server/export'),
		...page('server-import', 'server/import'),
		...page('user-password', 'user-password'),
		...page('preferences-manage', 'preferences/manage'),
		...page('preferences-two-factor', 'preferences/two-factor'),
		...page('preferences-features', 'preferences/features'),
		...page('preferences-sql', 'preferences/sql'),
		...page('preferences-navigation', 'preferences/navigation'),
		...page('preferences-main-panel', 'preferences/main-panel'),
		...page('preferences-export', 'preferences/export'),
		...page('preferences-import', 'preferences/import'),
		...page('transformation-overview', 'transformation/overview'),
		...page('check-relations', 'check-relations'),
		{ id: 'license', needs: [], args: ['license'] },
		{ id: 'changelog', needs: [], args: ['changelog'] },
		{ id: 'phpinfo', needs: [], args: ['phpinfo'] },
		{ id: 'themes', needs: [], args: ['themes'] },
		ajax('server-variable-get', 'server/variables/get/max_allowed_packet'),
		post('server-processes-refresh', 'server/status/processes/refresh', ['full=', 'column_name=', 'order_by_field=', 'sort_order=']),
		post('git-revision', 'git-revision'),
		ajax('export-check-time-out', 'export/check-time-out'),
		post('databases-list', 'databases'),
		post('recent-table', 'recent-table', ['recent_table=1']),
		post('lint', 'lint', ['sql_query=SELECT * FRM players', 'options[routeOrString]=']),

		// Navigation tree.
		post('nav-root', 'navigation'),
		post('nav-full', 'navigation', ['full=true']),
		post('nav-settings', 'navigation', ['getNaviSettings=true']),
		post('nav-db', 'navigation', navParams(dbPath, dbPath)),
		post('nav-tables', 'navigation', group('tables', 'Tables')),
		post('nav-views', 'navigation', group('views', 'Views'), ['view']),
		post('nav-procedures', 'navigation', group('procedures', 'Procedures'), ['procedure']),
		post('nav-functions', 'navigation', group('functions', 'Functions'), ['function']),
		post('nav-events', 'navigation', group('events', 'Events'), ['event']),
		post('nav-table', 'navigation', navParams(...tablePath)),
		post('nav-columns', 'navigation', navParams(`${tablePath[0]}.${b64('columns')}`, `${tablePath[1]}.${b64('Columns')}`)),
		post('nav-indexes', 'navigation', navParams(`${tablePath[0]}.${b64('indexes')}`, `${tablePath[1]}.${b64('Indexes')}`)),
		post('nav-db-filter', 'navigation', [...navParams(b64('root'), b64('root')), 'searchClause=cust']),
		post('nav-table-filter', 'navigation', [...group('tables', 'Tables'), 'searchClause2=pc_']),

		// Database level.
		...page('db-structure', 'database/structure', [db]),
		...page('db-sql', 'database/sql', [db]),
		...page('db-search', 'database/search', [db]),
		...page('db-qbe', 'database/qbe', [db]),
		...page('db-export', 'database/export', [db]),
		...page('db-import', 'database/import', [db]),
		...page('db-operations', 'database/operations', [db]),
		...page('db-routines', 'database/routines', [db], ['procedure']),
		...page('db-events', 'database/events', [db], ['event']),
		...page('db-triggers', 'database/triggers', [db], ['trigger']),
		...page('db-tracking', 'database/tracking', [db]),
		...page('db-designer', 'database/designer', [db]),
		...page('db-central-columns', 'database/central-columns', [db]),
		...page('db-data-dictionary', 'database/data-dictionary', [db]),
		...page('db-multi-table-query', 'database/multi-table-query', [db]),
		...page('table-create', 'table/create', [db]),
		...page('view-create', 'view/create', [db]),
		{ id: 'db-structure-sorted', needs: [], args: ['database/structure', db, 'sort=table', 'sort_order=DESC'] },
		post('db-real-row-count', 'database/structure/real-row-count', [...parent]),
		post('db-real-row-count-all', 'database/structure/real-row-count', [db, 'real_row_count_all=true']),
		post('db-show-create', 'database/structure/show-create', [db, 'selected_tbl[]=pc_parent', 'selected_tbl[]=pc_view'], ['view']),
		post('db-drop-form', 'database/structure/drop-form', [db, 'selected_tbl[]=pc_child'], ['fk']),
		post('db-empty-form', 'database/structure/empty-form', [db, 'selected_tbl[]=pc_child'], ['fk']),
		post('db-copy-form', 'database/structure/copy-form', [db, 'selected_tbl[]=pc_parent']),
		post('db-add-prefix-form', 'database/structure/add-prefix', [db, 'selected_tbl[]=pc_parent']),
		post('db-change-prefix-form', 'database/structure/change-prefix-form', [db, 'selected_tbl[]=pc_parent', 'submit_mult=replace_prefix_tbl']),
		post('db-tables-list', 'tables', [db]),
		post('db-sql-format', 'database/sql/format', [db, 'sql=select id,name from players where id=1 order by name']),
		post('db-sql-autocomplete', 'database/sql/autocomplete', [db]),
		post('db-search-run', 'database/search', [db, 'criteriaSearchString=row0', 'criteriaSearchType=1', 'criteriaTables[]=pc_parent', 'criteriaTables[]=players', 'criteriaColumnName=', 'submit_search=Go']),
		ajax('db-mtq-tables', 'database/multi-table-query/tables', [db, 'tables[]=pc_parent', 'tables[]=pc_child'], ['fk']),
		ajax('routine-add', 'database/routines', [db, 'add_item=1', 'item_type=PROCEDURE']),
		ajax('routine-edit', 'database/routines', [db, 'edit_item=1', 'item_name=pc_proc', 'item_type=PROCEDURE'], ['procedure']),
		ajax('routine-export', 'database/routines', [db, 'export_item=1', 'item_name=pc_proc', 'item_type=PROCEDURE'], ['procedure']),
		ajax('routine-execute-dialog', 'database/routines', [db, 'execute_dialog=1', 'item_name=pc_proc', 'item_type=PROCEDURE'], ['procedure']),
		post('routine-execute', 'database/routines', [db, 'execute_routine=1', 'item_name=pc_proc', 'item_type=PROCEDURE', 'params[n]=21'], ['procedure']),
		ajax('function-edit', 'database/routines', [db, 'edit_item=1', 'item_name=pc_func', 'item_type=FUNCTION'], ['function']),
		ajax('function-execute-dialog', 'database/routines', [db, 'execute_dialog=1', 'item_name=pc_func', 'item_type=FUNCTION'], ['function']),
		ajax('event-add', 'database/events', [db, 'add_item=1']),
		ajax('event-edit', 'database/events', [db, 'edit_item=1', 'item_name=pc_evt'], ['event']),
		ajax('event-export', 'database/events', [db, 'export_item=1', 'item_name=pc_evt'], ['event']),
		ajax('trigger-add', 'database/triggers', [db, 'add_item=1']),
		ajax('trigger-edit', 'database/triggers', [db, 'edit_item=1', 'item_name=pc_trg'], ['trigger']),
		ajax('trigger-export', 'database/triggers', [db, 'export_item=1', 'item_name=pc_trg'], ['trigger']),

		// Table level.
		...page('browse', 'sql', [...parent, 'pos=0']),
		...page('browse-players', 'sql', [db, 'table=players', 'pos=0']),
		...page('browse-view', 'sql', [db, 'table=pc_view', 'pos=0'], ['view']),
		...page('table-structure', 'table/structure', parent),
		...page('table-structure-players', 'table/structure', [db, 'table=players']),
		...page('table-structure-child', 'table/structure', [db, 'table=pc_child'], ['fk']),
		...page('table-structure-view', 'table/structure', [db, 'table=pc_view'], ['view']),
		...page('table-sql', 'table/sql', parent),
		...page('table-search', 'table/search', parent),
		...page('table-zoom-search', 'table/zoom-search', parent),
		...page('table-find-replace', 'table/find-replace', parent),
		...page('table-insert', 'table/change', parent),
		...page('table-edit-row', 'table/change', [...parent, 'where_clause=`pc_parent`.`id` = 1']),
		...page('table-export', 'table/export', parent),
		...page('table-import', 'table/import', parent),
		...page('table-operations', 'table/operations', parent),
		...page('table-relation', 'table/relation', [db, 'table=pc_child'], ['fk']),
		...page('table-triggers', 'table/triggers', [db, 'table=pc_child'], ['trigger']),
		...page('table-tracking', 'table/tracking', parent),
		...page('table-normalization', 'normalization', parent),
		...page('view-operations', 'view/operations', [db, 'table=pc_view'], ['view']),
		...page('view-edit', 'view/create', [db, 'table=pc_view'], ['view']),
		ajax('table-index-create', 'table/indexes', [...parent, 'create_index=1', 'added_fields=1']),
		ajax('table-index-edit', 'table/indexes', [...parent, 'index=pc_name_idx']),
		ajax('table-column-change', 'table/structure/change', [...parent, 'field=name', 'change_column=1']),
		ajax('table-add-field', 'table/add-field', [...parent, 'num_fields=1', 'after_field=name']),
		ajax('browse-foreigners', 'browse-foreigners', [db, 'table=pc_child', 'field=parent_id', 'fieldkey=0', 'data=1'], ['fk']),
		ajax('table-recent-favorite', 'table/recent-favorite', parent),
		post('columns-list', 'columns', parent),
		browse('browse-page-2', ['sql_query=SELECT * FROM `pc_parent`', 'pos=25']),
		browse('browse-sort-desc', ['sql_query=SELECT * FROM `pc_parent` ORDER BY `name` DESC', 'pos=0']),
		browse('browse-rows-10', ['sql_query=SELECT * FROM `pc_parent`', 'pos=0', 'session_max_rows=10']),
		post('enum-values', 'sql/get-enum-values', [...parent, 'column=kind', 'curr_value=alpha']),
		post('set-values', 'sql/get-set-values', [...parent, 'column=flags', 'curr_value=x']),
		post('relational-values', 'sql/get-relational-values', [db, 'table=pc_child', 'column=parent_id', 'curr_value=1', 'relation_key_or_display_column=1'], ['fk']),
		ajax('default-fk-check', 'sql/get-default-fk-check-value'),
		post('find-replace-preview', 'table/find-replace', [...parent, 'columnIndex=1', 'find=row1', 'replaceWith=line1', 'useRegex=false', 'ajax_request=true']),
		post('simulate-dml', 'import/simulate-dml', [db, 'sql_query=UPDATE `pc_parent` SET `amount` = 1 WHERE `id` = 1', 'sql_delimiter=;']),

		// SQL tab queries.
		sqlTab('sql-select-players', 'SELECT * FROM `players`'),
		sqlTab('sql-select-where', 'SELECT * FROM `pc_parent` WHERE `id` < 5'),
		sqlTab('sql-select-join', 'SELECT p.name, c.label FROM pc_parent p JOIN pc_child c ON c.parent_id = p.id', DB, ['fk']),
		sqlTab('sql-group-by', 'SELECT kind, COUNT(*) AS n, SUM(amount) FROM `pc_parent` GROUP BY kind'),
		sqlTab('sql-explain', 'EXPLAIN SELECT * FROM `pc_parent` WHERE `name` = \'row01\''),
		sqlTab('sql-show-tables', 'SHOW TABLES'),
		sqlTab('sql-show-create', 'SHOW CREATE TABLE `pc_parent`'),
		sqlTab('sql-show-index', 'SHOW INDEX FROM `pc_parent`'),
		sqlTab('sql-show-columns', 'SHOW FULL COLUMNS FROM `pc_parent`'),
		sqlTab('sql-view', 'SELECT * FROM `pc_view`', DB, ['view']),
		sqlTab('sql-multi', 'SELECT 1; SELECT 2 AS two'),
		sqlTab('sql-error', 'SELECT * FROM `pc_missing`'),
		sqlTab('sql-syntax-error', 'SELEC 1'),
		sqlTab('sql-call', 'CALL pc_proc(3)', DB, ['procedure']),
		sqlTab('sql-function', 'SELECT pc_func(1) AS f', DB, ['function']),
		sqlTab('sql-server-level', 'SELECT VERSION() IS NOT NULL AS ok', ''),
	];
}

/** Serialises a form the way a browser submits it, minus the per-session token. */
function formFields(html, selector) {
	const { window } = new JSDOM(html);
	const form = window.document.querySelector(selector);
	if (!form) {
		return null;
	}
	return [...new window.FormData(form)].filter(([key]) => key !== 'token').map(([key, value]) => [key, String(value)]);
}

const SCRATCH_TABLES = new Set(['pc_parent', 'pc_child', 'pc_view', 'players']);
const TABLE_LISTS = new Set(['table_select[]', 'table_structure[]', 'table_data[]']);

/** One sendit case per export format the oracle's export form offers, at each level, with the form's own defaults. */
async function exportCases(server) {
	const levels = [
		{ level: 'server', route: 'server/export', params: [] },
		{ level: 'db', route: 'database/export', params: [['db', DB]] },
		{ level: 'table', route: 'table/export', params: [['db', DB], ['table', 'pc_parent']] },
	];
	const cases = [];
	for (const { level, route, params } of levels) {
		const response = await fetchOracle({ method: 'GET', ajax: false, signedOut: false, server, user: persona, route: `/${route}`, params, before: [] });
		const fields = formFields(response.body, 'form[name="dump"]');
		if (!fields) {
			cases.push({ id: `export-${level}-form-missing`, needs: [], error: `No export form on ${route}` });
			continue;
		}
		// Other agents' tables in customer_db change while the crawl runs, so database exports cover the scratch tables only.
		const kept = fields.filter(([key, value]) => !TABLE_LISTS.has(key) || SCRATCH_TABLES.has(value));
		const formats = [...new JSDOM(response.body).window.document.querySelectorAll('#plugins option')].map(option => option.value);
		for (const format of formats) {
			const pairs = kept.filter(([key]) => key !== 'what' && key !== 'output_format');
			pairs.push(['what', format], ['output_format', 'sendit']);
			cases.push({ id: `export-${level}-${format}`, needs: [], args: ['--post', '--headers', 'export', ...pairs.map(([key, value]) => `${key}=${value}`)] });
		}
	}
	return cases;
}

async function diffOnce(server, testCase, outDir, renderUrl) {
	const script = path.join(ROOT, 'scripts', 'pma-diff.mjs');
	const env = { ...process.env, PMA_RENDER_URL: renderUrl };
	try {
		const { stdout } = await run(process.execPath, [script, '--server', server, ...userArgs(), '--out', outDir, ...testCase.args], { cwd: ROOT, env, maxBuffer: 256 * 1024 * 1024, timeout: DIFF_TIMEOUT_MS });
		return { status: 'identical', output: stdout };
	} catch (error) {
		if (error.code === 1 && typeof error.stdout === 'string' && error.stdout.startsWith('--- oracle')) {
			return { status: 'diff', output: error.stdout };
		}
		return { status: 'error', output: `${error.stdout ?? ''}${error.stderr ?? ''}${error.message}` };
	}
}

async function runCase(server, testCase, missing, renderUrl) {
	const blocked = testCase.needs.filter(object => missing.has(object));
	if (testCase.error) {
		return { status: 'error', output: testCase.error };
	}
	if (blocked.length > 0) {
		return { status: 'skipped', output: `missing ${blocked.join(', ')}: ${blocked.map(object => missing.get(object)).join('; ')}` };
	}
	const outDir = path.join(reportDir, ORACLE_SERVERS[server].name, testCase.id);
	let result = await diffOnce(server, testCase, outDir, renderUrl);
	if (result.status !== 'identical') {
		const retry = await diffOnce(server, testCase, outDir, renderUrl);
		if (retry.status === 'identical') {
			result = { status: 'flaky', output: result.output };
		} else {
			result = retry;
		}
	}
	if (result.status === 'identical') {
		rmSync(outDir, { recursive: true, force: true });
	} else {
		mkdirSync(outDir, { recursive: true });
		writeFileSync(path.join(outDir, 'result.diff'), result.output);
	}
	return result;
}

async function pool(items, jobs, worker) {
	const results = Array.from({ length: items.length });
	let next = 0;
	const lanes = Array.from({ length: Math.min(jobs, items.length) }, async (_, lane) => {
		while (next < items.length) {
			const index = next++;
			results[index] = await worker(items[index], lane);
		}
	});
	await Promise.all(lanes);
	return results;
}

async function warmUp(url, server) {
	const deadline = Date.now() + 120000;
	for (;;) {
		try {
			const response = await fetch(url, { method: 'POST', body: JSON.stringify(['--server', server, '/']) });
			await response.text();
			return;
		} catch (error) {
			if (Date.now() > deadline) {
				throw error;
			}
			await new Promise((resolve) => {
				setTimeout(resolve, 500);
			});
		}
	}
}

/** Starts one warm render-route process per lane, so each diff skips vite-node's start-up. */
async function startRenderers(server, count) {
	const viteNode = path.join(ROOT, 'node_modules', 'vite-node', 'vite-node.mjs');
	const renderers = [];
	for (let lane = 0; lane < count; lane++) {
		const port = RENDER_PORT_BASE + lane;
		const child = spawn(process.execPath, [viteNode, '--config', 'scripts/render-route.config.ts', 'scripts/render-route.ts'], { cwd: ROOT, env: { ...process.env, PMA_RENDER_SERVE: String(port) }, stdio: 'ignore' });
		renderers.push({ child, url: `http://127.0.0.1:${port}/` });
	}
	for (const { url } of renderers) {
		await warmUp(url, server);
	}
	return renderers;
}

// vite-node can leave esbuild children behind, so the whole tree is stopped.
function stopRenderers(renderers) {
	for (const { child } of renderers) {
		if (process.platform === 'win32') {
			spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
		} else {
			child.kill();
		}
	}
}

const reproduce = (server, testCase) => {
	const quoted = (testCase.args ?? []).map(arg => (/^[\w./=[\]-]+$/.test(arg) ? arg : `'${arg.replaceAll('\'', String.raw`'\''`)}'`));
	return `node scripts/pma-diff.mjs --server ${server} ${[...userArgs(), ...quoted].join(' ')}`;
};

/** Changed lines of a unified diff that do not pair up with an opposite line once digits are masked, so live counters and timings drop out. */
function nonNumericChanges(diff) {
	const mask = line => line.slice(1).replaceAll(/[\d.,]+/g, '#').replaceAll(/\s+/g, ' ');
	const removed = new Map();
	const added = [];
	for (const line of diff.split('\n')) {
		if (line.startsWith('--- ') || line.startsWith('+++ ')) {
			continue;
		}
		if (line.startsWith('-')) {
			removed.set(mask(line), (removed.get(mask(line)) ?? 0) + 1);
		} else if (line.startsWith('+')) {
			added.push(line);
		}
	}
	const unmatched = added.filter((line) => {
		const count = removed.get(mask(line)) ?? 0;
		if (count === 0) {
			return true;
		}
		removed.set(mask(line), count - 1);
		return false;
	});
	return unmatched.length + removed.values().reduce((sum, count) => sum + count, 0);
}

function writeReport(rows, missingByServer) {
	const statuses = ['identical', 'diff', 'flaky', 'error', 'skipped'];
	const lines = [
		'# Parity crawl',
		'',
		`Run at ${new Date().toISOString()}. Diffs, oracle.txt and ours.txt live in <server>/<case>/ for every case that was not identical.`,
		'',
		`| server | ${statuses.join(' | ')} |`,
		`| --- | ${statuses.map(() => '---').join(' | ')} |`,
	];
	for (const server of Object.keys(missingByServer)) {
		const mine = rows.filter(row => row.server === server);
		lines.push(`| ${ORACLE_SERVERS[server].name} | ${statuses.map(status => mine.filter(row => row.status === status).length).join(' | ')} |`);
	}
	for (const [server, missing] of Object.entries(missingByServer)) {
		for (const [object, message] of missing) {
			lines.push('', `- ${ORACLE_SERVERS[server].name}: could not create ${object}: ${message}`);
		}
	}
	for (const status of ['diff', 'error', 'flaky', 'skipped']) {
		const matching = rows.filter(row => row.status === status);
		if (matching.length === 0) {
			continue;
		}
		lines.push('', `## ${status} (${matching.length})`, '');
		for (const row of matching) {
			let note = '';
			if (status === 'diff' || status === 'flaky') {
				const real = nonNumericChanges(row.output);
				note = real === 0 ? ' (digits only)' : ` (${real} non-numeric changed lines)`;
			}
			lines.push(`- \`${ORACLE_SERVERS[row.server].name}/${row.id}\`${note}: \`${row.reproduce}\``);
		}
	}
	writeFileSync(path.join(reportDir, 'summary.md'), `${lines.join('\n')}\n`);
	writeFileSync(path.join(reportDir, 'summary.json'), `${JSON.stringify(rows.map(({ output, ...row }) => row), null, '\t')}\n`);
}

async function main() {
	const options = parseCli(process.argv.slice(2));
	persona = options.user;
	// Another persona's report goes beside the customer's instead of replacing it.
	if (persona !== undefined) {
		reportDir = path.join(REPORT_DIR, 'users', persona);
	}
	if (options.only) {
		reportDir = path.join(reportDir, 'partial');
	}
	rmSync(reportDir, { recursive: true, force: true });
	mkdirSync(reportDir, { recursive: true });
	const missingByServer = {};
	const rows = [];
	try {
		// Servers run one after another with fresh render processes, so no module-level cache carries over between them.
		for (const server of options.servers) {
			missingByServer[server] = options.setup ? await setupScratch(server) : new Map();
			const cases = [...staticCases(), ...await exportCases(server)].filter(testCase => testCase.id.includes(options.only));
			const renderers = await startRenderers(server, Math.min(options.jobs, cases.length));
			let done = 0;
			try {
				rows.push(...await pool(cases, options.jobs, async (testCase, lane) => {
					const result = await runCase(server, testCase, missingByServer[server], renderers[lane].url);
					done++;
					process.stdout.write(`[${done}/${cases.length}] ${ORACLE_SERVERS[server].name} ${testCase.id}: ${result.status}\n`);
					return { server, id: testCase.id, status: result.status, reproduce: reproduce(server, testCase), output: result.output };
				}));
			} finally {
				stopRenderers(renderers);
			}
		}
		writeReport(rows, missingByServer);
		process.stdout.write(`Report written to ${path.join(reportDir, 'summary.md')}\n`);
	} finally {
		if (options.setup && !options.keep) {
			for (const server of options.servers) {
				await dropScratch(server);
			}
		}
	}
}

await main();

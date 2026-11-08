// Helpers shared by the table structure family: DbTableExists, partitions and foreign key support.
import { escapeString } from '../../../../lib/pma/dbi-sql.ts';
import { Message } from '../../../../lib/pma/message.ts';
import { mysqlDieHtml } from '../../../../lib/pma/server/mysql-die.ts';
import { isForeignKeySupportedEngine } from '../../../../lib/pma/table-structure/column-spec.ts';
import { type Partition, partitionsFromRows } from '../../../../lib/pma/table-structure/partition.ts';
import { backquote } from '../../../../lib/twig/sanitize.ts';
import { getCommon } from '../../../../lib/twig/url.ts';
import { renderTemplate } from '../../../twig/render.ts';
import { generatorState } from '../../core/generator.ts';
import { getIndexesByChoice } from '../../core/index.ts';

import type { TemplateStateInput } from '../../../twig/state.ts';
import type { PmaContext } from '../../core/context.ts';
import type { DbiRow } from '../../core/dbi.ts';
import type { Controller, ControllerContext } from '../../dispatcher.ts';

/** RelationParameters without a configuration storage: every feature is null. */
export const RELATION_PARAMETERS = {
	user: null,
	db: null,
	bookmarkFeature: null,
	browserTransformationFeature: null,
	centralColumnsFeature: null,
	columnCommentsFeature: null,
	configurableMenusFeature: null,
	databaseDesignerSettingsFeature: null,
	displayFeature: null,
	exportTemplatesFeature: null,
	favoriteTablesFeature: null,
	navigationItemsHidingFeature: null,
	pdfFeature: null,
	recentlyUsedTablesFeature: null,
	relationFeature: null,
	savedQueryByExampleSearchesFeature: null,
	sqlHistoryFeature: null,
	trackingFeature: null,
	uiPreferencesFeature: null,
	userPreferencesFeature: null,
};

// Other families' controllers, loaded on demand so the modules do not import each other at startup.
const controllerModules = import.meta.glob<{ controllers?: Record<string, Controller>; }>(['../**/*.ts', '!../**/*.test.ts', '!./**/*.ts']);

/** Runs another family's controller in place, as upstream calls $containerBuilder->get(...)() and exits. */
export async function forwardTo(context: PmaContext, name: string): Promise<Response | null> {
	for (const load of Object.values(controllerModules)) {
		const module = await load();
		const controller = module.controllers?.[name];
		if (controller !== undefined) {
			return controller(context as ControllerContext);
		}
	}
	return null;
}

/** DbTableExists::check(): a response when the database or table is missing, else null; tableMayBeAbsent is define('TABLE_MAY_BE_ABSENT'). */
export async function checkDbTableExists(context: PmaContext, tableMayBeAbsent = false): Promise<Response | null> {
	const { dbi, response } = context;
	const isDb = context.db !== '' && await dbi.selectDb(context.db);
	if (!isDb) {
		if (response.isAjax) {
			response.setRequestStatus(false);
			response.addJSON('message', Message.error('No databases selected.'));
			return response.response();
		}
		const params: Record<string, unknown> = { reload: 1 };
		if (response.globals.sqlQuery !== '') {
			params.sql_query = response.globals.sqlQuery;
		}
		response.header('Location', `/index.php?route=/${getCommon(context.urlState(), params, '&')}`);
		response.disable();
		return response.response();
	}
	if (tableMayBeAbsent) {
		return null;
	}
	if (context.table !== '') {
		if (dbi.getCachedTableContent(context.db, context.table) !== undefined) {
			return null;
		}
		const shown = await dbi.tryQuery(`SHOW TABLES LIKE '${escapeString(context.table)}';`);
		if (shown !== false && shown.numRows() > 0) {
			return null;
		}
		// SHOW TABLES leaves out temporary tables.
		const counted = await dbi.tryQuery(`SELECT COUNT(*) FROM ${backquote(context.table)};`);
		if (counted !== false && counted.numRows() > 0) {
			return null;
		}
	}
	// Upstream DbTableExists imports the database SQL tab controller, not the query runner.
	const forwarded = await forwardTo(context, 'Database/SqlController');
	if (forwarded !== null) {
		return forwarded;
	}
	response.addHTML(Message.error(`Table ${context.table} does not exist.`).getDisplay());
	return response.response();
}

/** ForeignKey::isSupported(). */
export async function isForeignKeySupported(context: PmaContext, engine: string): Promise<boolean> {
	if (isForeignKeySupportedEngine(engine)) {
		return true;
	}
	const upper = engine.toUpperCase();
	if (upper !== 'NDBCLUSTER' && upper !== 'NDB') {
		return false;
	}
	const value = await context.dbi.fetchValue('SELECT @@ndb_version_string');
	let version = typeof value === 'string' ? value.toLowerCase() : '';
	if (version.startsWith('ndb-')) {
		version = version.slice(4);
	}
	const [major = 0, minor = 0] = version.split('.').map(Number);
	return major > 7 || (major === 7 && minor >= 3);
}

const partitioningSupport = new WeakMap<PmaContext, boolean>();

/** Partition::havePartitioning(). */
export async function havePartitioning(context: PmaContext): Promise<boolean> {
	const known = partitioningSupport.get(context);
	if (known !== undefined) {
		return known;
	}
	const { dbi } = context;
	await dbi.connect();
	let supported: boolean;
	if (dbi.getVersion() < 50600) {
		const value = await dbi.fetchValue('SELECT @@have_partitioning;');
		supported = value !== false && value !== null && value !== '' && value !== '0';
	} else if (dbi.getVersion() >= 80000) {
		supported = true;
	} else {
		const plugins = await dbi.fetchResult('SHOW PLUGINS') as DbiRow[];
		supported = plugins.some(plugin => plugin.Name === 'partition');
	}
	partitioningSupport.set(context, supported);
	return supported;
}

function partitionsWhere(db: string, table: string): string {
	return ` WHERE \`TABLE_SCHEMA\` = '${escapeString(db)}' AND \`TABLE_NAME\` = '${escapeString(table)}'`;
}

/** Partition::getPartitions(). */
export async function getPartitions(context: PmaContext, db: string, table: string): Promise<Partition[]> {
	if (!await havePartitioning(context)) {
		return [];
	}
	const rows = await context.dbi.fetchResult(`SELECT * FROM \`information_schema\`.\`PARTITIONS\`${partitionsWhere(db, table)}`) as DbiRow[];
	return partitionsFromRows(rows);
}

/** Partition::getPartitionNames(). */
export async function getPartitionNames(context: PmaContext, db: string, table: string): Promise<(string | null)[]> {
	if (!await havePartitioning(context)) {
		return [];
	}
	return await context.dbi.fetchResult(`SELECT DISTINCT \`PARTITION_NAME\` FROM \`information_schema\`.\`PARTITIONS\`${partitionsWhere(db, table)}`) as (string | null)[];
}

/** Partition::getPartitionMethod(). */
export async function getPartitionMethod(context: PmaContext, db: string, table: string): Promise<string | null> {
	if (!await havePartitioning(context)) {
		return null;
	}
	const methods = await context.dbi.fetchResult(`SELECT \`PARTITION_METHOD\` FROM \`information_schema\`.\`PARTITIONS\`${partitionsWhere(db, table)} LIMIT 1`) as (string | null)[];
	return methods[0] ?? null;
}

/** Table::getColumnsWithIndex(). */
export async function getColumnsWithIndex(context: PmaContext, table: string, db: string, choices: number): Promise<string[]> {
	const columns: string[] = [];
	for (const index of await getIndexesByChoice(context, table, db, choices)) {
		columns.push(...index.getColumns().keys());
	}
	return columns;
}

/** Template::render() with the request's template state. */
export async function render(context: PmaContext, name: string, variables: Record<string, unknown>, extraState: Partial<TemplateStateInput> = {}): Promise<string> {
	return renderTemplate(name, variables, { ...await context.templateState(), ...extraState });
}

/** Generator::mysqlDie($serverMessage, $sqlQuery, $isModifyLink, '', false), which falls back to the last error and $GLOBALS['sql_query']. */
export function mysqlDieHtmlFor(context: PmaContext, serverMessage: string, sqlQuery: string, isModifyLink = true): string {
	const empty = (value: string): boolean => value === '' || value === '0';
	return mysqlDieHtml({
		serverMessage: empty(serverMessage) ? context.dbi.getError() : serverMessage,
		sqlQuery: empty(sqlQuery) && !empty(context.response.globals.sqlQuery) ? context.response.globals.sqlQuery : sqlQuery,
		isModifyLink,
		db: context.db,
		table: context.table,
		url: context.urlState(),
		state: generatorState(context),
	});
}

/**
 * AbstractController::redirect(): Core::sendHeaderLocation() only adds the header, so PHP still renders the page
 * around it, unlike ResponseRenderer.redirect() here which sends an empty body.
 */
export function redirectWithPage(context: PmaContext, route: string, params: Record<string, unknown> = {}): void {
	context.response.header('Location', `/index.php?route=${route}${getCommon(context.urlState(), params, '&')}`);
}

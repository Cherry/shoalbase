// Port of Controllers\Database\StructureController (route /database/structure): the table list of a database.
import {
	type DbInfo,
	getDbInfo,
	hasDatabase,
	redirect,
	render,
} from './common.ts';
import {
	earliestTime,
	engineKind,
	mysqlDateToTimestamp,
	replicationStatus,
	rowCountApproximation,
} from '../../../../lib/pma/database/structure.ts';
import { FlashMessages } from '../../../../lib/pma/flash-messages.ts';
import { listNavigatorVariables } from '../../../../lib/pma/list-navigator.ts';
import { md5 } from '../../../../lib/pma/md5.ts';
import { twigVariables } from '../../../../lib/pma/server/twig-data.ts';
import { sprintf } from '../../../../lib/pma/sprintf.ts';
import { formatByteDown, localisedDate } from '../../../../lib/pma/util.ts';
import { htmlspecialchars, urlencode } from '../../../../lib/twig/php.ts';
import { backquote, sanitizeMessage } from '../../../../lib/twig/sanitize.ts';
import { getFromRoute } from '../../../../lib/twig/url.ts';
import { renderTemplate } from '../../../twig/render.ts';
import { findCollationByName } from '../../core/charsets.ts';
import { generatorState, showHint } from '../../core/generator.ts';
import { getPageSettings } from '../../core/page-settings.ts';
import { getTables } from '../../core/recent-favorite-table.ts';
import { hasMroongaEngine } from '../../core/storage-engine.ts';
import { Table } from '../../core/table.ts';
import { loadReplicationInfo } from '../server/replication-info.ts';

import type { Collation } from '../../../../lib/pma/charsets.ts';
import type { ReplicationSideInfo } from '../../../../lib/pma/server/replication-info.ts';
import type { PmaContext } from '../../core/context.ts';

type TableRow = Record<string, unknown>;

interface SizeInfo {
	formattedSize: string;
	unit: string;
	formattedOverhead: string;
	overheadUnit: string;
	tableIsView: boolean;
}

interface Totals {
	sumSize: number;
	overheadSize: number;
}

const toNumber = (value: unknown): number => {
	if ([null, undefined, false].includes(value as never)) {
		return 0;
	}
	return Number(value) || 0;
};

function byteDown(value: number): [string, string] {
	return formatByteDown(value, 3, value > 0 ? 1 : 0) ?? ['', ''];
}

/** StructureController::getValuesForCsvTable()'s size estimate (https://bugs.mysql.com/bug.php?id=53929). */
async function csvSize(context: PmaContext, table: TableRow): Promise<number> {
	const { db, dbi } = context;
	const name = String(table.TABLE_NAME);
	const where = `WHERE TABLE_SCHEMA = '${dbi.escapeString(db)}' AND TABLE_NAME = '${dbi.escapeString(name)}'`;
	const columnCount = toNumber(await dbi.fetchValue(`SELECT COUNT(COLUMN_NAME) FROM INFORMATION_SCHEMA.COLUMNS ${where} AND NUMERIC_SCALE IS NULL;`));
	const columnNames = await dbi.fetchValue(`SELECT GROUP_CONCAT(COLUMN_NAME) FROM INFORMATION_SCHEMA.COLUMNS ${where};`);
	await dbi.query('SET SESSION group_concat_max_len = 10 * 1024 * 1024');
	const dataLength = toNumber(await dbi.fetchValue(`
                SELECT SUM(CHAR_LENGTH(REPLACE(REPLACE(REPLACE(
                    CONCAT_WS(',', ${String(columnNames || '')}),
                    UNHEX('0A'), 'nn'), UNHEX('22'), 'nn'), UNHEX('5C'), 'nn'
                ))) FROM ${backquote(db)}.${backquote(name)}`));
	const rows = toNumber(table.TABLE_ROWS);
	return dataLength + rows * columnCount * 2 + rows;
}

/** StructureController::getStuffForEngineTypeTable(); changes the row and the totals in place. */
async function engineTypeStuff(context: PmaContext, info: DbInfo, table: TableRow, totals: Totals): Promise<SizeInfo> {
	const { db } = context;
	const stuff: SizeInfo = { formattedSize: '-', unit: '', formattedOverhead: '', overheadUnit: '', tableIsView: false };
	const name = String(table.TABLE_NAME);
	const addSize = (): void => {
		const size = toNumber(table.Data_length) + toNumber(table.Index_length);
		totals.sumSize += size;
		const [formatted, unit] = byteDown(size);
		stuff.formattedSize = formatted;
		stuff.unit = unit;
	};
	let kind = engineKind(table.ENGINE as string | null);
	if (kind === 'mroonga' && !await hasMroongaEngine(context)) {
		kind = 'unknown';
	}
	switch (kind) {
		case 'aria': {
			if (info.isSystemSchema) {
				table.Rows = await Table.get(context, String(table.Name), db).countRecords();
			}
			if (info.isShowStats) {
				addSize();
				const free = toNumber(table.Data_free);
				if (free > 0) {
					const [formatted, unit] = byteDown(free);
					stuff.formattedOverhead = formatted;
					stuff.overheadUnit = unit;
					totals.overheadSize += free;
				}
			}
			break;
		}
		case 'innodb': {
			stuff.formattedSize = '';
			if ((['InnoDB', 'TokuDB'].includes(String(table.ENGINE)) && toNumber(table.TABLE_ROWS) < context.config.MaxExactCount) || table.TABLE_ROWS === null || table.TABLE_ROWS === undefined) {
				table.COUNTED = true;
				table.TABLE_ROWS = await Table.get(context, name, db).countRecords(true);
			} else {
				table.COUNTED = false;
			}
			if (info.isShowStats) {
				addSize();
			}
			break;
		}
		case 'csv': {
			stuff.formattedSize = '';
			table.COUNTED = true;
			table.TABLE_ROWS = await Table.get(context, name, db).countRecords(true);
			if (info.isShowStats) {
				const size = await csvSize(context, table);
				totals.sumSize += size;
				const [formatted, unit] = byteDown(size);
				stuff.formattedSize = formatted;
				stuff.unit = unit;
			}
			break;
		}
		case 'merge': {
			if (info.isShowStats) {
				stuff.formattedSize = ' - ';
			}
			break;
		}
		case 'mroonga': {
			stuff.formattedSize = '';
			if (info.isShowStats) {
				addSize();
			}
			break;
		}
		case 'unknown': {
			if (info.isShowStats) {
				stuff.formattedSize = 'unknown';
			}
			break;
		}
		default: {
			break;
		}
	}
	if (table.TABLE_TYPE === 'VIEW' || table.TABLE_TYPE === 'SYSTEM VIEW') {
		table.TABLE_ROWS = await Table.get(context, name, db).countRecords(true);
		stuff.tableIsView = true;
	}
	return stuff;
}

function displayFlags(context: PmaContext) {
	const { config } = context;
	return {
		show_charset: config.ShowDbStructureCharset,
		show_comment: config.ShowDbStructureComment,
		show_creation: config.ShowDbStructureCreation,
		show_last_update: config.ShowDbStructureLastUpdate,
		show_last_check: config.ShowDbStructureLastCheck,
	};
}

function formatTime(time: string): string {
	if (!time) {
		return '-';
	}
	return localisedDate(mysqlDateToTimestamp(time));
}

/** StructureController::displayTableList(). */
async function displayTableList(context: PmaContext, info: DbInfo, replicaInfo: ReplicationSideInfo): Promise<string> {
	const { config, db, dbi } = context;
	const state = await context.templateState();
	const generator = generatorState(context);
	let html = await renderTemplate('filter', { filter_value: '' }, state);
	const flags = displayFlags(context);
	const totals: Totals = { sumSize: 0, overheadSize: 0 };
	const propertiesNumColumns = toNumber(config.PropertiesNumColumns);
	let numColumns = 0;
	if (propertiesNumColumns > 1) {
		numColumns = Math.ceil(info.numTables / propertiesNumColumns) + 1;
	}
	const favorites = getTables(context, 'favorite');
	let index = 0;
	let rowCount = 0;
	let sumEntries = 0;
	let overheadCheck = false;
	let createTimeAll = '';
	let updateTimeAll = '';
	let checkTimeAll = '';
	let overallApproxRows = false;
	let tableCollation: Collation | null | undefined;
	const hiddenFields: string[] = [];
	let structureTableRows: Record<string, unknown>[] = [];
	const tableHeader = (rows: Record<string, unknown>[], extra: Record<string, unknown> = {}) => {
		return {
			db,
			db_is_system_schema: info.isSystemSchema,
			replication: replicaInfo.status,
			properties_num_columns: config.PropertiesNumColumns,
			is_show_stats: info.isShowStats,
			...flags,
			num_favorite_tables: config.NumFavoriteTables,
			structure_table_rows: rows,
			...extra,
		};
	};

	for (const row of info.tables.values()) {
		const currentTable: TableRow = { ...row };
		const name = String(currentTable.TABLE_NAME);
		const inputClass = ['checkall'];
		const tableUrlParams = { db, table: name };
		const stuff = await engineTypeStuff(context, info, currentTable, totals);
		if (!await Table.get(context, name, db).isMerge()) {
			sumEntries += toNumber(currentTable.TABLE_ROWS);
		}

		let collationDefinition = '---';
		if (currentTable.Collation !== undefined && currentTable.Collation !== null) {
			tableCollation = await findCollationByName(context, String(currentTable.Collation));
			if (tableCollation !== null) {
				collationDefinition = await renderTemplate('database/structure/collation_definition', {
					valueTitle: tableCollation.getDescription(),
					value: tableCollation.getName(),
				}, state);
			}
		}

		let overhead = '';
		if (info.isShowStats) {
			overhead = '-';
			if (stuff.formattedOverhead !== '') {
				overhead = await renderTemplate('database/structure/overhead', {
					table_url_params: tableUrlParams,
					formatted_overhead: stuff.formattedOverhead,
					overhead_unit: stuff.overheadUnit,
				}, state);
				overheadCheck = true;
				inputClass.push('tbl-overhead');
			}
		}

		// The collation of an earlier table stays set for a view, which has none, as upstream reuses the variable.
		let charset = '';
		if (config.ShowDbStructureCharset && tableCollation) {
			charset = tableCollation.getCharset();
		}
		const createTime = config.ShowDbStructureCreation ? String(currentTable.Create_time ?? '') : '';
		createTimeAll = earliestTime(createTimeAll, createTime);
		const updateTime = config.ShowDbStructureLastUpdate ? String(currentTable.Update_time ?? '') : '';
		updateTimeAll = earliestTime(updateTimeAll, updateTime);
		const checkTime = config.ShowDbStructureLastCheck ? String(currentTable.Check_time ?? '') : '';
		checkTimeAll = earliestTime(checkTimeAll, checkTime);

		index++;
		rowCount++;
		if (stuff.tableIsView) {
			hiddenFields.push(`<input type="hidden" name="views[]" value="${htmlspecialchars(name)}">`);
		}
		const mayHaveRows = toNumber(currentTable.TABLE_ROWS) > 0 || stuff.tableIsView;

		let dropQuery = '';
		let dropMessage = '';
		if (!info.isSystemSchema) {
			dropQuery = `DROP ${stuff.tableIsView ? 'VIEW' : 'TABLE'} ${backquote(name)}`;
			let text = 'Table %s has been dropped.';
			if (stuff.tableIsView) {
				text = 'View %s has been dropped.';
			}
			dropMessage = sprintf(text, htmlspecialchars(name).replaceAll(' ', '&nbsp;'));
		}

		if (numColumns > 0 && info.numTables > numColumns && rowCount % numColumns === 0) {
			rowCount = 1;
			html += await renderTemplate('database/structure/table_header', twigVariables(tableHeader(structureTableRows)), state);
			structureTableRows = [];
		}

		const { approxRows, viewHint } = rowCountApproximation({
			tableRows: currentTable.TABLE_ROWS as number | string | false | null | undefined,
			engine: currentTable.ENGINE as string | null,
			counted: Boolean(currentTable.COUNTED),
			isView: stuff.tableIsView,
			maxExactCountViews: config.MaxExactCountViews,
		});
		let showSuperscript = '';
		if (viewHint) {
			const text = sprintf('This view has at least this number of rows. Please refer to %sdocumentation%s.', '[doc@cfg_MaxExactCountViews]', '[/doc]');
			showSuperscript = showHint(generator, sanitizeMessage(generator, text));
		}
		const replication = replicationStatus(replicaInfo, db, name);

		structureTableRows.push({
			table_name_hash: md5(name),
			db_table_name_hash: md5(`${db}.${name}`),
			db,
			curr: index,
			input_class: inputClass.join(' '),
			table_is_view: stuff.tableIsView,
			current_table: currentTable,
			may_have_rows: mayHaveRows,
			browse_table_label_title: htmlspecialchars(currentTable.TABLE_COMMENT ?? ''),
			browse_table_label_truename: name,
			empty_table_sql_query: `TRUNCATE ${backquote(name)}`,
			empty_table_message_to_show: urlencode(sprintf('Table %s has been emptied.', htmlspecialchars(name))),
			tracking_icon: '',
			server_replica_status: replicaInfo.status,
			table_url_params: tableUrlParams,
			db_is_system_schema: info.isSystemSchema,
			drop_query: dropQuery,
			drop_message: dropMessage,
			collation: collationDefinition,
			formatted_size: stuff.formattedSize,
			unit: stuff.unit,
			overhead,
			create_time: formatTime(createTime),
			update_time: formatTime(updateTime),
			check_time: formatTime(checkTime),
			charset,
			is_show_stats: info.isShowStats,
			ignored: replication.ignored,
			do: replication.do,
			approx_rows: approxRows,
			show_superscript: showSuperscript,
			already_favorite: favorites.some(item => item.db === db && item.table === name),
			num_favorite_tables: config.NumFavoriteTables,
			properties_num_columns: config.PropertiesNumColumns,
			limit_chars: config.LimitChars,
			...flags,
		});
		overallApproxRows ||= approxRows;
	}

	let databaseCollation: Record<string, string> | [] = [];
	let databaseCharset = '';
	const collation = await findCollationByName(context, await dbi.getDbCollation(db));
	if (collation !== null) {
		databaseCollation = { name: collation.getName(), description: collation.getDescription() };
		databaseCharset = collation.getCharset();
	}

	return html + await renderTemplate('database/structure/table_header', twigVariables(tableHeader(structureTableRows, {
		body_for_table_summary: {
			num_tables: info.numTables,
			server_replica_status: replicaInfo.status,
			db_is_system_schema: info.isSystemSchema,
			sum_entries: sumEntries,
			database_collation: databaseCollation,
			is_show_stats: info.isShowStats,
			database_charset: databaseCharset,
			sum_size: totals.sumSize,
			overhead_size: totals.overheadSize,
			create_time_all: formatTime(createTimeAll),
			update_time_all: formatTime(updateTimeAll),
			check_time_all: formatTime(checkTimeAll),
			approx_rows: overallApproxRows,
			num_favorite_tables: config.NumFavoriteTables,
			db: context.db,
			properties_num_columns: config.PropertiesNumColumns,
			// The summary template asks the server for its default storage engine itself.
			dbi: { fetchValue: async (sql: string) => dbi.fetchValue(sql) },
			...flags,
		},
		check_all_tables: {
			text_dir: 'ltr',
			overhead_check: overheadCheck,
			db_is_system_schema: info.isSystemSchema,
			hidden_fields: hiddenFields,
			disable_multi_table: config.DisableMultiTableMaintenance,
			central_columns_work: false,
		},
	})), state);
}

/** StructureController::__invoke() with the request's FlashMessages, which controllers that end on the list share. */
export async function renderStructure(context: PmaContext, flash: FlashMessages): Promise<Response> {
	const { config, dbi, response, request } = context;
	if (!await hasDatabase(context)) {
		return response.response();
	}
	response.addScriptFiles(['database/structure.js', 'table/change.js']);
	const info = await getDbInfo(context, '_structure');

	if (info.totalNumTables > 0 && info.position > info.totalNumTables) {
		redirect(context, '/database/structure', {
			db: context.db,
			pos: Math.max(0, info.totalNumTables - toNumber(config.MaxTableList)),
			reload: 1,
		});
	}

	const replication = await loadReplicationInfo(context, request.post.primary_connection);
	const pageSettings = await getPageSettings(context, 'DbStructure');
	if (pageSettings.saved) {
		return response.response();
	}
	response.addHTML(pageSettings.errorHtml);
	response.addHTML(pageSettings.html);

	let listNavigator = '';
	let tableList = '';
	if (info.numTables > 0) {
		const urlParams: Record<string, unknown> = { pos: info.position, db: context.db };
		if (request.params.sort !== undefined) {
			urlParams.sort = request.params.sort;
		}
		if (request.params.sort_order !== undefined) {
			urlParams.sort_order = request.params.sort_order;
		}
		listNavigator = await render(context, 'list_navigator', listNavigatorVariables({
			count: info.totalNumTables,
			pos: info.position,
			urlParams,
			script: getFromRoute(context.urlState(), '/database/structure'),
			frame: 'frame_content',
			maxCount: config.MaxTableList,
			name: 'pos',
			classes: [],
		}));
		tableList = await displayTableList(context, info, replication.replicaInfo);
	}

	let createTable = '';
	if (!info.isSystemSchema) {
		await dbi.getUserPrivileges();
		createTable = await render(context, 'database/create_table', { db: context.db });
	}

	const state = { ...await context.templateState(), flashMessages: flash.getMessages() };
	response.addHTML(await renderTemplate('database/structure/index', {
		database: context.db,
		has_tables: info.numTables > 0,
		list_navigator_html: listNavigator,
		table_list_html: tableList,
		is_system_schema: info.isSystemSchema,
		create_table_html: createTable,
	}, state));
	return response.response();
}

export async function structureController(context: PmaContext): Promise<Response> {
	return renderStructure(context, new FlashMessages(context.session.data));
}

export const controllers = {
	'Database/StructureController': structureController,
};

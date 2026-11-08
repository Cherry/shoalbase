// Ports of Server, Database and Table ExportController plus Export\Options: the export form for each level.
import {
	exportPlugins,
	optionRequest,
	render,
	singleTableParam,
} from './common.ts';
import { isSystemSchema } from '../../../../lib/pma/dbi-sql.ts';
import { getChoice, getDefault, getOptions } from '../../../../lib/pma/export-import/properties.ts';
import { tableExportQuery } from '../../../../lib/pma/export-import/sql-query.ts';
import { Message } from '../../../../lib/pma/message.ts';
import { phpEmpty } from '../../../../lib/pma/server/php.ts';
import { nestedParams, phpArray, phpValues } from '../../../../lib/pma/table-data/php-params.ts';
import { getPageSettings } from '../../core/page-settings.ts';
import { Table } from '../../core/table.ts';
import { getDbInfo, hasDatabase } from '../database/common.ts';
import { isValidGoto } from '../table-data/change.ts';

import type { PluginInfo } from '../../../../lib/pma/export-import/properties.ts';
import type { PmaContext } from '../../core/context.ts';
import type { Controller } from '../../dispatcher.ts';

type ExportType = 'database' | 'raw' | 'server' | 'table';

/** The globals a forwarding controller (ExportController, TablesController, ExportRowsController) leaves for the page. */
export interface ExportPageGlobals {
	message?: Message;
	/** $table_select from Export/TablesController. */
	tableSelect?: string[];
	/** $where_clause from Table/ExportRowsController. */
	whereClause?: string[];
	singleTable?: boolean;
}

function checkedClause(name: string, list: string[]): boolean {
	return list.includes(name);
}

// Config::checkboxCheck() in Export\Options: the $cfg['Export'] flag is set and truthy.
function exportFlag(context: PmaContext, name: string): boolean {
	return Boolean((context.config.Export as Record<string, unknown>)[name]);
}

/** Options::getDatabasesForSelectOptions(). */
async function databasesForSelect(context: PmaContext): Promise<{ name: string; is_selected: boolean; }[]> {
	let selected: string[] | null = null;
	const posted = context.request.post.db_select;
	if (typeof posted === 'string') {
		selected = decodeURIComponent(posted.replaceAll('+', ' ')).split(',');
	} else if (Array.isArray(posted)) {
		selected = posted;
	}
	const databases = await context.dbi.getDatabaseList();
	return databases.filter(name => !isSystemSchema(name, true)).map((name) => {
		return { name, is_selected: selected === null || selected.includes(name) };
	});
}

/** Export\Options::getFileNameTemplate(): Config::getUserValue() prefers the cookie of the same name. */
function fileNameTemplate(context: PmaContext, exportType: ExportType): string {
	const posted = context.request.post.filename_template;
	if (typeof posted === 'string') {
		return posted;
	}
	const { Export } = context.config;
	let cookie = 'pma_server_filename_template';
	let value = Export.file_template_server;
	if (exportType === 'database') {
		cookie = 'pma_db_filename_template';
		value = Export.file_template_database;
	} else if (exportType === 'table') {
		cookie = 'pma_table_filename_template';
		value = Export.file_template_table;
	}
	const stored = context.getCookie(cookie);
	if (stored !== undefined && !phpEmpty(stored)) {
		return stored;
	}
	return String(value);
}

/** Core::emptyRecursive(). */
function emptyRecursive(value: unknown): boolean {
	if (value !== null && typeof value === 'object') {
		return Object.values(value).every(item => emptyRecursive(item));
	}
	return phpEmpty(value);
}

/** Export\Options::getOptions(). */
async function getExportOptions(context: PmaContext, exportType: ExportType, sqlQuery: string, exportList: PluginInfo[], singleTable: boolean): Promise<Record<string, unknown>> {
	const { config, db, table, request } = context;
	const post = request.post;
	const what = request.query.what;
	const defaultFormat = typeof what === 'string' ? what : getDefault(optionRequest(context, 'Export'), 'format');

	let rows: Record<string, unknown> = {};
	if (table !== '' && exportType !== 'raw' && !await Table.get(context, table, db).isMerge()) {
		rows = {
			allrows: post.allrows ?? null,
			limit_to: post.limit_to ?? null,
			limit_from: post.limit_from ?? null,
			unlim_num_rows: 0,
			number_of_rows: await Table.get(context, table, db).countRecords(),
		};
	}

	const tmpval = context.session.data.tmpval;
	const aliases = tmpval?.aliases ?? {};
	const hasAliases = tmpval?.aliases !== undefined && !emptyRecursive(tmpval.aliases);
	if (tmpval?.aliases !== undefined) {
		delete tmpval.aliases;
	}

	let selectedCompression = post.compression ?? config.Export.compression;
	if (config.Export.as_separate_files) {
		selectedCompression = 'zip';
	}
	const hiddenInputs: Record<string, unknown> = {
		db,
		table,
		export_type: exportType,
		export_method: post.export_method ?? config.Export.method,
		template_id: post.template_id ?? '',
	};
	if (singleTable) {
		hiddenInputs.single_table = true;
	}
	if (sqlQuery !== '' && sqlQuery !== '0') {
		hiddenInputs.sql_query = sqlQuery;
	}

	return {
		export_type: exportType,
		db,
		table,
		templates: { is_enabled: false, templates: [], selected: post.template_id ?? null },
		sql_query: sqlQuery,
		hidden_inputs: hiddenInputs,
		export_method: post.quick_or_custom ?? config.Export.method,
		plugins_choice: getChoice(exportList, defaultFormat),
		options: getOptions(optionRequest(context, 'Export'), exportList),
		can_convert_kanji: false,
		exec_time_limit: config.ExecTimeLimit,
		rows,
		has_save_dir: false,
		save_dir: '/',
		export_is_checked: exportFlag(context, 'quick_export_onserver'),
		export_overwrite_is_checked: exportFlag(context, 'quick_export_onserver_overwrite'),
		has_aliases: hasAliases,
		aliases,
		is_checked_lock_tables: exportFlag(context, 'lock_tables'),
		is_checked_asfile: exportFlag(context, 'asfile'),
		is_checked_as_separate_files: exportFlag(context, 'as_separate_files'),
		is_checked_export: exportFlag(context, 'onserver'),
		is_checked_export_overwrite: exportFlag(context, 'onserver_overwrite'),
		is_checked_remember_file_template: exportFlag(context, 'remember_file_template'),
		repopulate: post.repopulate !== undefined,
		lock_tables: post.lock_tables !== undefined,
		is_encoding_supported: true,
		encodings: config.AvailableCharsets,
		export_charset: config.Export.charset,
		export_asfile: config.Export.asfile,
		has_zip: config.ZipDump,
		has_gzip: config.GZipDump,
		selected_compression: selectedCompression,
		filename_template: fileNameTemplate(context, exportType),
	};
}

/** Server\ExportController. */
export async function serverExportPage(context: PmaContext, globals: ExportPageGlobals = {}): Promise<Response> {
	const { dbi, response } = context;
	if (await dbi.isSuperUser()) {
		await dbi.selectDb('mysql');
	}
	const pageSettings = await getPageSettings(context, 'Export');
	if (pageSettings.saved) {
		return response.response();
	}
	response.addScriptFiles(['export.js']);
	const databases = await databasesForSelect(context);
	const singleTable = (globals.singleTable ?? false) || singleTableParam(context) !== undefined;
	const exportList = await exportPlugins(context, 'server', singleTable);
	const options = await getExportOptions(context, 'server', response.globals.sqlQuery, exportList, singleTable);
	response.addHTML(await render(context, 'server/export/index', {
		...options,
		page_settings_error_html: pageSettings.errorHtml,
		page_settings_html: pageSettings.html,
		databases,
	}));
	return response.response();
}

/** Database\ExportController. */
export async function databaseExportPage(context: PmaContext, globals: ExportPageGlobals = {}): Promise<Response> {
	const { response, request } = context;
	const post = request.post;
	const pageSettings = await getPageSettings(context, 'Export');
	if (pageSettings.saved) {
		return response.response();
	}
	response.addScriptFiles(['export.js']);
	if (globals.message !== undefined) {
		response.globals.message = globals.message;
	}
	if (!await hasDatabase(context)) {
		return response.response();
	}
	const info = await getDbInfo(context, '_export');
	if (info.numTables < 1) {
		response.addHTML(Message.error('No tables found in database.').getDisplay());
		return response.response();
	}
	let tableSelect = globals.tableSelect;
	if (!phpEmpty(post.selected_tbl) && tableSelect === undefined) {
		tableSelect = Array.isArray(post.selected_tbl) ? post.selected_tbl : [post.selected_tbl as string];
	}
	const tables = info.tables.values().map((row) => {
		const name = String(row.Name);
		let isChecked = true;
		if (Array.isArray(post.table_select)) {
			isChecked = checkedClause(name, post.table_select);
		} else if (tableSelect !== undefined) {
			isChecked = checkedClause(name, tableSelect);
		}
		let structureChecked = isChecked;
		if (Array.isArray(post.table_structure)) {
			structureChecked = checkedClause(name, post.table_structure);
		}
		let dataChecked = isChecked;
		if (Array.isArray(post.table_data)) {
			dataChecked = checkedClause(name, post.table_data);
		}
		return { name, is_checked_select: isChecked, is_checked_structure: structureChecked, is_checked_data: dataChecked };
	}).toArray();
	let exportType: ExportType = 'database';
	if (post.raw_query !== undefined || post.export_type === 'raw') {
		exportType = 'raw';
	}
	const singleTable = (globals.singleTable ?? false) || singleTableParam(context) !== undefined;
	const exportList = await exportPlugins(context, exportType, singleTable);
	const options = await getExportOptions(context, exportType, response.globals.sqlQuery, exportList, singleTable);
	response.addHTML(await render(context, 'database/export/index', {
		...options,
		page_settings_error_html: pageSettings.errorHtml,
		page_settings_html: pageSettings.html,
		structure_or_data_forced: post.structure_or_data_forced ?? 0,
		tables,
	}));
	return response.response();
}

/** Table\ExportController. */
export async function tableExportPage(context: PmaContext, globals: ExportPageGlobals = {}): Promise<Response> {
	const { response, request } = context;
	const post = request.post;
	const pageSettings = await getPageSettings(context, 'Export');
	if (pageSettings.saved) {
		return response.response();
	}
	response.addScriptFiles(['export.js']);
	if (globals.message !== undefined) {
		response.globals.message = globals.message;
	}
	let sqlQuery = response.globals.sqlQuery;
	if (sqlQuery !== '' && sqlQuery !== '0') {
		sqlQuery = tableExportQuery(sqlQuery, globals.whereClause ?? null);
		response.globals.sqlQuery = sqlQuery;
	}
	const singleTable = (globals.singleTable ?? false) || singleTableParam(context) !== undefined;
	const exportList = await exportPlugins(context, 'table', singleTable);
	let exportType: ExportType = 'table';
	if (post.raw_query !== undefined || post.export_type === 'raw') {
		exportType = 'raw';
	}
	const options = await getExportOptions(context, exportType, sqlQuery, exportList, singleTable);
	response.addHTML(await render(context, 'table/export/index', {
		...options,
		export_type: exportType,
		page_settings_error_html: pageSettings.errorHtml,
		page_settings_html: pageSettings.html,
	}));
	return response.response();
}

/** Export/TablesController: the database export form for the tables picked on the structure page. */
const exportTablesController: Controller = async (context) => {
	if (phpEmpty(context.request.post.selected_tbl)) {
		context.response.setRequestStatus(false);
		context.response.addJSON('message', 'No table selected.');
		return context.response.response();
	}
	return databaseExportPage(context);
};

/** Table/ExportRowsController: the table export form limited to the rows ticked in a result grid. */
const exportRowsController: Controller = async (context) => {
	const rows = phpArray(nestedParams(context.request.post).rows_to_delete);
	// Common::run() drops a goto that fails Core::checkPageValidity().
	if (isValidGoto(context.request.post.goto) && rows === undefined) {
		context.response.setRequestStatus(false);
		context.response.addJSON('message', 'No row selected.');
		return context.response.response();
	}
	const whereClause = phpValues(rows ?? {}).filter(value => typeof value === 'string');
	return tableExportPage(context, { singleTable: true, whereClause });
};

export const controllers: Record<string, Controller> = {
	'Server/ExportController': async context => serverExportPage(context),
	'Database/ExportController': async context => databaseExportPage(context),
	'Table/ExportController': async context => tableExportPage(context),
	'Export/TablesController': exportTablesController,
	'Table/ExportRowsController': exportRowsController,
};

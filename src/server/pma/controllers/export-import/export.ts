// Port of Controllers\Export\ExportController and the Export class: runs one export and sends it as a file or as text.
import { exportPluginParam, stringParam } from './common.ts';
import { databaseExportPage, serverExportPage, tableExportPage } from './export-page.ts';
import { noCacheHeaders } from '../../../../lib/pma/ajax-response.ts';
import { encodeOutput } from '../../../../lib/pma/export-import/bytes.ts';
import { createZip, gzencode, separateFileNames } from '../../../../lib/pma/export-import/compress.ts';
import { getExportPlugin } from '../../../../lib/pma/export-import/export-plugins.ts';
import {
	expandUserString,
	finalFilenameAndMimetype,
	phpContentType,
	sanitizeFilename,
} from '../../../../lib/pma/export-import/filename.ts';
import { Message } from '../../../../lib/pma/message.ts';
import { phpEmpty } from '../../../../lib/pma/server/php.ts';
import { setUserValue } from '../../../../lib/pma/user-preferences.ts';
import { getDocumentationLink, showDocumentationLink } from '../../../../lib/twig/html.ts';
import { htmlspecialchars, urlencode } from '../../../../lib/twig/php.ts';
import { backquote, sanitizeMessage } from '../../../../lib/twig/sanitize.ts';
import { getCommon, getFromRoute } from '../../../../lib/twig/url.ts';
import { Misc, Parser, SelectStatement } from '../../../../sql-parser/index.ts';
import { renderTemplate } from '../../../twig/render.ts';
import { DbiQueryError } from '../../core/dbi.ts';
import { generatorState } from '../../core/generator.ts';
import { Table } from '../../core/table.ts';
import {
	type ExportAliases,
	ExportOutput,
	type ExportPlugin,
	ExportRun,
	PhpError,
	type StructureOptions,
	loadParserContext,
} from '../../plugins/export/engine.ts';
import { createExportPlugin } from '../../plugins/export/index.ts';
import { setConfigCookie } from '../home-actions.ts';
import { mysqlDieMessage } from '../server/mysql-die.ts';

import type { PmaContext } from '../../core/context.ts';
import type { Controller } from '../../dispatcher.ts';

// ExportController's $allowedPostParams, copied into $GLOBALS.
const ALLOWED_POST_PARAMS = [
	'db',
	'table',
	'what',
	'single_table',
	'export_type',
	'export_method',
	'quick_or_custom',
	'db_select',
	'table_select',
	'table_structure',
	'table_data',
	'limit_to',
	'limit_from',
	'allrows',
	'lock_tables',
	'output_format',
	'filename_template',
	'maxsize',
	'remember_template',
	'charset',
	'compression',
	'as_separate_files',
	'knjenc',
	'xkana',
	'htmlword_structure_or_data',
	'htmlword_null',
	'htmlword_columns',
	'mediawiki_headers',
	'mediawiki_structure_or_data',
	'mediawiki_caption',
	'pdf_structure_or_data',
	'odt_structure_or_data',
	'odt_relation',
	'odt_comments',
	'odt_mime',
	'odt_columns',
	'odt_null',
	'codegen_structure_or_data',
	'codegen_format',
	'excel_null',
	'excel_removeCRLF',
	'excel_columns',
	'excel_edition',
	'excel_structure_or_data',
	'yaml_structure_or_data',
	'ods_null',
	'ods_structure_or_data',
	'ods_columns',
	'json_structure_or_data',
	'json_pretty_print',
	'json_unicode',
	'xml_structure_or_data',
	'xml_export_events',
	'xml_export_functions',
	'xml_export_procedures',
	'xml_export_tables',
	'xml_export_triggers',
	'xml_export_views',
	'xml_export_contents',
	'texytext_structure_or_data',
	'texytext_columns',
	'texytext_null',
	'phparray_structure_or_data',
	'sql_include_comments',
	'sql_header_comment',
	'sql_dates',
	'sql_relation',
	'sql_mime',
	'sql_use_transaction',
	'sql_disable_fk',
	'sql_compatibility',
	'sql_structure_or_data',
	'sql_create_database',
	'sql_drop_table',
	'sql_procedure_function',
	'sql_create_table',
	'sql_create_view',
	'sql_create_trigger',
	'sql_view_current_user',
	'sql_simple_view_export',
	'sql_if_not_exists',
	'sql_or_replace_view',
	'sql_auto_increment',
	'sql_backquotes',
	'sql_truncate',
	'sql_delayed',
	'sql_ignore',
	'sql_type',
	'sql_insert_syntax',
	'sql_max_query_size',
	'sql_hex_for_binary',
	'sql_utc_time',
	'sql_drop_database',
	'sql_views_as_tables',
	'sql_metadata',
	'csv_separator',
	'csv_enclosed',
	'csv_escaped',
	'csv_terminated',
	'csv_null',
	'csv_removeCRLF',
	'csv_columns',
	'csv_structure_or_data',
	'latex_caption',
	'latex_structure_or_data',
	'latex_structure_caption',
	'latex_structure_continued_caption',
	'latex_structure_label',
	'latex_relation',
	'latex_comments',
	'latex_mime',
	'latex_columns',
	'latex_data_caption',
	'latex_data_continued_caption',
	'latex_data_label',
	'latex_null',
	'aliases',
];

const STRUCTURE_OR_DATA = new Set(['structure', 'data', 'structure_and_data']);

/** Core::fatalError(): the JSON error for AJAX, else the generic error page inside the normal one. */
export async function fatalError(context: PmaContext, message: string): Promise<Response> {
	const { response } = context;
	if (response.isAjax) {
		response.setRequestStatus(false);
		response.addJSON('message', Message.error(message));
		return response.response();
	}
	const errorMessage = sanitizeMessage(generatorState(context), message);
	response.addHTML(await renderTemplate('error/generic', { lang: context.lang, dir: 'ltr', error_message: errorMessage }, await context.templateState()));
	return response.response();
}

/** Util::checkParameters(): the fatal error naming each missing parameter. */
export async function missingParameters(context: PmaContext, missing: string[]): Promise<Response> {
	const docs = getDocumentationLink(generatorState(context), 'faq', 'faqmissingparameters');
	const link = showDocumentationLink(generatorState(context), docs, 'documentation', true);
	return fatalError(context, missing.map(param => `index.php: Missing parameter: ${param}${link}[br]`).join(''));
}

/** The posted aliases[db][alias], aliases[db][tables][table][alias] and ...[columns][column] fields as a tree. */
export function postedAliases(post: Record<string, unknown>): ExportAliases | null {
	const aliases: ExportAliases = {};
	let found = false;
	for (const [key, value] of Object.entries(post)) {
		const parts = /^aliases\[([^\]]*)\](.*)$/.exec(key);
		if (parts === null || typeof value !== 'string') {
			continue;
		}
		found = true;
		const path = parts[2].matchAll(/\[([^\]]*)\]/g).map(match => match[1]).toArray();
		const entry = aliases[parts[1]] ??= {};
		if (path.length === 1 && path[0] === 'alias') {
			entry.alias = value;
		} else if (path.length >= 3 && path[0] === 'tables') {
			const table = (entry.tables ??= {})[path[1]] ??= {};
			if (path[2] === 'alias') {
				table.alias = value;
			} else if (path[2] === 'columns' && path.length === 4) {
				(table.columns ??= {})[path[3]] = value;
			}
		}
	}
	return found ? aliases : null;
}

/** Export::mergeAliases(): the second set wins wherever it has a non-empty alias. */
export function mergeAliases(first: ExportAliases, second: ExportAliases): ExportAliases {
	const merged: ExportAliases = structuredClone(first);
	for (const [db, entry] of Object.entries(second)) {
		const target = merged[db] ??= {};
		if (entry.alias !== undefined) {
			target.alias = phpEmpty(entry.alias) && target.alias !== undefined ? target.alias : entry.alias;
		}
		for (const [table, tableEntry] of Object.entries(entry.tables ?? {})) {
			const tableTarget = (target.tables ??= {})[table] ??= {};
			if (tableEntry.alias !== undefined) {
				tableTarget.alias = phpEmpty(tableEntry.alias) && tableTarget.alias !== undefined ? tableTarget.alias : tableEntry.alias;
			}
			for (const [column, alias] of Object.entries(tableEntry.columns ?? {})) {
				const columns = tableTarget.columns ??= {};
				columns[column] = phpEmpty(alias) && columns[column] !== undefined ? columns[column] : alias;
			}
		}
	}
	return merged;
}

/** Misc::getAliases() of a SELECT, in the shape Export uses. */
function queryAliases(context: PmaContext, sqlQuery: string): ExportAliases {
	loadParserContext(context);
	const statement = new Parser(sqlQuery).statements[0];
	if (!(statement instanceof SelectStatement)) {
		return {};
	}
	return Misc.getAliases(statement, context.db) as unknown as ExportAliases;
}

const LATIN1_ENTITIES = [
	'nbsp',
	'iexcl',
	'cent',
	'pound',
	'curren',
	'yen',
	'brvbar',
	'sect',
	'uml',
	'copy',
	'ordf',
	'laquo',
	'not',
	'shy',
	'reg',
	'macr',
	'deg',
	'plusmn',
	'sup2',
	'sup3',
	'acute',
	'micro',
	'para',
	'middot',
	'cedil',
	'sup1',
	'ordm',
	'raquo',
	'frac14',
	'frac12',
	'frac34',
	'iquest',
	'Agrave',
	'Aacute',
	'Acirc',
	'Atilde',
	'Auml',
	'Aring',
	'AElig',
	'Ccedil',
	'Egrave',
	'Eacute',
	'Ecirc',
	'Euml',
	'Igrave',
	'Iacute',
	'Icirc',
	'Iuml',
	'ETH',
	'Ntilde',
	'Ograve',
	'Oacute',
	'Ocirc',
	'Otilde',
	'Ouml',
	'times',
	'Oslash',
	'Ugrave',
	'Uacute',
	'Ucirc',
	'Uuml',
	'Yacute',
	'THORN',
	'szlig',
	'agrave',
	'aacute',
	'acirc',
	'atilde',
	'auml',
	'aring',
	'aelig',
	'ccedil',
	'egrave',
	'eacute',
	'ecirc',
	'euml',
	'igrave',
	'iacute',
	'icirc',
	'iuml',
	'eth',
	'ntilde',
	'ograve',
	'oacute',
	'ocirc',
	'otilde',
	'ouml',
	'divide',
	'oslash',
	'ugrave',
	'uacute',
	'ucirc',
	'uuml',
	'yacute',
	'thorn',
	'yuml',
];

// htmlentities() for ASCII and UTF-8 text matches htmlspecialchars() except for named Latin-1 and symbol entities.
function htmlentities(value: unknown): string {
	return htmlspecialchars(value).replaceAll(/[\u{A0}-\u{FF}]/gu, character => `&${LATIN1_ENTITIES[(character.codePointAt(0) as number) - 0xA0]};`);
}

/** Export::getHtmlForDisplayedExportHeader(): the back link and refresh form around "View output as text". */
function displayedExportHeader(context: PmaContext, exportType: string): { html: string; backButton: string; refreshButton: string; } {
	const url = context.urlState();
	const { db, table } = context;
	let backButton = '<p>[ <a href="';
	if (exportType === 'server') {
		backButton += `${getFromRoute(url, '/server/export')}" data-post="${getCommon(url, {}, '')}`;
	} else if (exportType === 'database') {
		backButton += `${getFromRoute(url, '/database/export')}" data-post="${getCommon(url, { db }, '')}`;
	} else {
		backButton += `${getFromRoute(url, '/table/export')}" data-post="${getCommon(url, { db, table }, '')}`;
	}
	const postParams: Record<string, unknown> = { ...context.request.post };
	if (exportType === 'database' && phpEmpty(postParams.structure_or_data_forced)) {
		postParams.table_structure ??= [];
		postParams.table_data ??= [];
	}
	for (const [name, value] of Object.entries(postParams)) {
		if (!Array.isArray(value)) {
			backButton += `&amp;${urlencode(name)}=${urlencode(value)}`;
		}
	}
	backButton += '&amp;repopulate=1">Back</a> ]</p>';
	let refreshButton = `<form id="export_refresh_form" method="POST" action="${getFromRoute(url, '/export')}" class="disableAjax">`;
	refreshButton += '[ <a class="disableAjax export_refresh_btn">Refresh</a> ]';
	for (const [name, value] of Object.entries(postParams)) {
		if (Array.isArray(value)) {
			for (const item of value) {
				refreshButton += `<input type="hidden" name="${htmlentities(name)}[]" value="${htmlentities(item)}">`;
			}
		} else {
			refreshButton += `<input type="hidden" name="${htmlentities(name)}" value="${htmlentities(value)}">`;
		}
	}
	refreshButton += '</form>';
	const html = `<div><br>${backButton}${refreshButton}<br><form name="nofunction"><textarea name="sqldump" cols="50" rows="30" id="textSQLDUMP" wrap="OFF">`;
	return { html, backButton, refreshButton };
}

/** Export::getHtmlForDisplayedExportFooter(). */
function displayedExportFooter(backButton: string, refreshButton: string): string {
	return `</textarea>    </form><br>${backButton}${refreshButton}</div><script type="text/javascript">\n//<![CDATA[\nvar $body = $("body");\n$("#textSQLDUMP")\n.width($body.width() - 50)\n.height($body.height() - 100);\n//]]>\n</script>\n`;
}

/** Export::getFilenameAndMimetype(), including remembering the file name template. */
function filenameAndMimetype(context: PmaContext, exportType: string, rememberTemplate: boolean, extension: string, mimeType: string, compression: string, template: string): [string, string] {
	const paths: Record<string, [string, string]> = {
		server: ['pma_server_filename_template', 'Export/file_template_server'],
		database: ['pma_db_filename_template', 'Export/file_template_database'],
		raw: ['pma_raw_filename_template', 'Export/file_template_raw'],
	};
	if (rememberTemplate) {
		const [cookie, path] = paths[exportType] ?? ['pma_table_filename_template', 'Export/file_template_table'];
		const defaults = context.baseConfig.Export as unknown as Record<string, unknown>;
		const defaultValue = defaults[path.slice('Export/'.length)];
		setUserValue(context.session, context.config as unknown as Record<string, unknown>, path, template, defaultValue ?? null, Math.floor(Date.now() / 1000));
		setConfigCookie(context, cookie, template, typeof defaultValue === 'string' ? defaultValue : '\0');
	}
	const { config } = context;
	const filename = sanitizeFilename(expandUserString(template, {
		httpHost: context.httpHost,
		serverName: config.Server.host,
		serverVerbose: config.Server.verbose,
		database: context.db,
		table: context.table,
	}, new Date()), true);
	return finalFilenameAndMimetype(extension, mimeType, compression, filename);
}

/** Export::exportDatabase(). */
async function exportDatabase(run: ExportRun, plugin: ExportPlugin, db: string, tables: string[], whatStrucOrData: string, tableStructure: string[], tableData: string[], exportType: string, options: StructureOptions, aliases: ExportAliases, separateFiles: string): Promise<void> {
	const { context, out } = run;
	const { dbi } = context;
	const dbAlias = aliases[db]?.alias || '';
	if (!(await plugin.exportDBHeader?.(db, dbAlias) ?? true) || !(await plugin.exportDBCreate?.(db, exportType, dbAlias) ?? true)) {
		return;
	}
	if (separateFiles === 'database') {
		out.saveObjectInBuffer('database', true);
	}
	const sqlStructureOrData = run.globals.sql_structure_or_data;
	const structureWanted = whatStrucOrData === 'structure' || whatStrucOrData === 'structure_and_data';
	if ((sqlStructureOrData === 'structure' || sqlStructureOrData === 'structure_and_data') && run.has('sql_procedure_function')) {
		await plugin.exportRoutines?.(db, aliases);
		if (separateFiles === 'database') {
			out.saveObjectInBuffer('routines');
		}
	}
	const views: string[] = [];
	if (tables.length > 0) {
		await dbi.getTablesFull(db, tables);
	}
	for (const table of tables) {
		const isView = await Table.get(context, table, db).isView();
		if (isView) {
			views.push(table);
		}
		if (structureWanted && tableStructure.includes(table)) {
			if (isView) {
				if (separateFiles === '' && run.has('sql_create_view') && !(await plugin.exportStructure?.(db, table, 'stand_in', exportType, options, aliases) ?? true)) {
					break;
				}
			} else if (run.has('sql_create_table')) {
				const maxSize = run.str('maxsize');
				if (maxSize !== '' && /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?\s*$/i.test(maxSize)) {
					const size = Number(await dbi.fetchValue(`SELECT data_length + index_length\n                              from information_schema.TABLES\n                              WHERE table_schema = "${dbi.escapeString(db)}"\n                              AND table_name = "${dbi.escapeString(table)}"`)) || 0;
					if (size / (1024 * 1024) > Number(maxSize)) {
						continue;
					}
				}
				if (!(await plugin.exportStructure?.(db, table, 'create_table', exportType, options, aliases) ?? true)) {
					break;
				}
			}
		}
		if ((whatStrucOrData === 'data' || whatStrucOrData === 'structure_and_data') && tableData.includes(table) && !isView) {
			const columns = await Table.get(context, table, db).getNonGeneratedColumns(true);
			const query = `SELECT ${columns.join(', ')} FROM ${backquote(db)}.${backquote(table)}`;
			if (!await plugin.exportData(db, table, query, aliases)) {
				break;
			}
		}
		if (separateFiles === 'database') {
			out.saveObjectInBuffer(`table_${table}`);
		}
		if (!run.has('sql_create_trigger') || !structureWanted || !tableStructure.includes(table)) {
			continue;
		}
		if (!(await plugin.exportStructure?.(db, table, 'triggers', exportType, options, aliases) ?? true)) {
			break;
		}
		if (separateFiles === 'database') {
			out.saveObjectInBuffer(`table_${table}`, true);
		}
	}
	if (run.has('sql_create_view')) {
		for (const view of views) {
			if (!structureWanted) {
				continue;
			}
			if (!(await plugin.exportStructure?.(db, view, 'create_view', exportType, options, aliases) ?? true)) {
				break;
			}
			if (separateFiles === 'database') {
				out.saveObjectInBuffer(`view_${view}`);
			}
		}
	}
	if (!(await plugin.exportDBFooter?.(db) ?? true)) {
		return;
	}
	if (separateFiles === 'database') {
		out.saveObjectInBuffer('extra');
	}
	if ((sqlStructureOrData !== 'structure' && sqlStructureOrData !== 'structure_and_data') || !run.has('sql_procedure_function')) {
		return;
	}
	await plugin.exportEvents?.(db);
	if (separateFiles === 'database') {
		out.saveObjectInBuffer('events');
	}
}

/** Export::exportTable(). */
async function exportTable(run: ExportRun, plugin: ExportPlugin, db: string, table: string, whatStrucOrData: string, exportType: string, options: StructureOptions, sqlQuery: string, aliases: ExportAliases): Promise<void> {
	const { context } = run;
	const dbAlias = aliases[db]?.alias || '';
	if (!(await plugin.exportDBHeader?.(db, dbAlias) ?? true)) {
		return;
	}
	const allrows = run.str('allrows');
	const limitTo = Number(run.str('limit_to')) || 0;
	const limitFrom = Number(run.str('limit_from')) || 0;
	let addQuery = '';
	if (run.has('allrows') && allrows === '0' && limitTo > 0 && limitFrom >= 0) {
		addQuery = ` LIMIT ${limitFrom > 0 ? `${run.str('limit_from')}, ` : ''}${run.str('limit_to')}`;
	}
	const isView = await Table.get(context, table, db).isView();
	const structureWanted = whatStrucOrData === 'structure' || whatStrucOrData === 'structure_and_data';
	if (structureWanted) {
		if (isView) {
			if (run.has('sql_create_view') && !(await plugin.exportStructure?.(db, table, 'create_view', exportType, options, aliases) ?? true)) {
				return;
			}
		} else if (run.has('sql_create_table') && !(await plugin.exportStructure?.(db, table, 'create_table', exportType, options, aliases) ?? true)) {
			return;
		}
	}
	if (whatStrucOrData === 'data' || whatStrucOrData === 'structure_and_data') {
		let query: string;
		if (sqlQuery !== '' && sqlQuery !== '0') {
			query = (addQuery === '' ? sqlQuery : sqlQuery.replace(/;\s*$/, '')) + addQuery;
			await context.dbi.selectDb(db);
		} else {
			const columns = await Table.get(context, table, db).getNonGeneratedColumns(true);
			query = `SELECT ${columns.join(', ')} FROM ${backquote(db)}.${backquote(table)}${addQuery}`;
		}
		if (!await plugin.exportData(db, table, query, aliases)) {
			return;
		}
	}
	if (run.has('sql_create_trigger') && structureWanted && !(await plugin.exportStructure?.(db, table, 'triggers', exportType, options, aliases) ?? true)) {
		return;
	}
	await plugin.exportDBFooter?.(db);
}

/** Core::downloadHeader() on a disabled response. */
function downloadHeaders(context: PmaContext, filename: string, mimeType: string): void {
	const { response } = context;
	response.disable();
	for (const [name, value] of noCacheHeaders(new Date())) {
		response.header(name, value);
	}
	const safeName = sanitizeFilename(filename);
	if (safeName !== '') {
		response.header('Content-Description', 'File Transfer');
		response.header('Content-Disposition', `attachment; filename="${safeName}"`);
	}
	response.header('Content-Type', phpContentType(mimeType));
	response.header('Content-Transfer-Encoding', 'binary');
}

/** The forwarded export form, as Export::showPage() and the "No tables found" branch run it. */
async function showPage(context: PmaContext, exportType: string, message?: Message): Promise<Response> {
	if (exportType === 'server') {
		return serverExportPage(context, { message });
	}
	if (exportType === 'database') {
		return databaseExportPage(context, { message });
	}
	return tableExportPage(context, { message });
}

/** The try block of ExportController::__invoke(): header, the export for the type, footer. */
async function runExport(run: ExportRun, plugin: ExportPlugin, what: string, exportType: string, tables: string[], aliases: ExportAliases, separateFiles: string, sqlQuery: string): Promise<void> {
	const { context, globals } = run;
	if (!await plugin.exportHeader()) {
		return;
	}
	const options: StructureOptions = {
		relation: run.has(`${what}_relation`),
		comments: run.has(`${what}_include_comments`) || run.has(`${what}_comments`),
		mime: run.has(`${what}_mime`),
		dates: run.has(`${what}_dates`),
	};
	let whatStrucOrData = run.str(`${what}_structure_or_data`);
	if (!STRUCTURE_OR_DATA.has(whatStrucOrData)) {
		whatStrucOrData = 'data';
		const configured = (context.config.Export as unknown as Record<string, unknown>)[`${what}_structure_or_data`];
		if (typeof configured === 'string' && STRUCTURE_OR_DATA.has(configured)) {
			whatStrucOrData = configured;
		}
		globals[`${what}_structure_or_data`] = whatStrucOrData;
	}
	if (exportType === 'raw') {
		whatStrucOrData = 'raw';
	}
	const { db, table, dbi } = context;
	if (exportType === 'server') {
		const selected = Array.isArray(globals.db_select) ? globals.db_select as string[] : [];
		for (const current of await dbi.getDatabaseList()) {
			if (!selected.includes(current)) {
				continue;
			}
			const dbTables = await dbi.getTables(current);
			await exportDatabase(run, plugin, current, dbTables, whatStrucOrData, dbTables, dbTables, exportType, options, aliases, separateFiles === 'database' ? separateFiles : '');
			if (separateFiles === 'server') {
				run.out.saveObjectInBuffer(current);
			}
		}
	} else if (exportType === 'database') {
		let tableStructure = Array.isArray(globals.table_structure) ? globals.table_structure as string[] : [];
		let tableData = Array.isArray(globals.table_data) ? globals.table_data as string[] : [];
		if (!phpEmpty(context.request.post.structure_or_data_forced)) {
			tableStructure = tables;
			tableData = tables;
		}
		const lock = run.has('lock_tables');
		if (lock) {
			await dbi.tryQuery(`LOCK TABLES ${tables.map(name => `${backquote(db)}.${backquote(name)} READ`).join(', ')}`);
		}
		try {
			await exportDatabase(run, plugin, db, tables, whatStrucOrData, tableStructure, tableData, exportType, options, aliases, separateFiles);
		} finally {
			if (lock) {
				await dbi.tryQuery('UNLOCK TABLES');
			}
		}
	} else if (exportType === 'raw') {
		if (!await plugin.exportRawQuery(db, sqlQuery)) {
			run.context.response.globals.message = Message.error('Exporting a raw query is not supported for this export method.');
		}
	} else {
		const lock = run.has('lock_tables');
		if (lock) {
			await dbi.tryQuery(`LOCK TABLES ${backquote(db)}.${backquote(table)} READ`);
		}
		try {
			await exportTable(run, plugin, db, table, whatStrucOrData, exportType, options, sqlQuery, aliases);
		} finally {
			if (lock) {
				await dbi.tryQuery('UNLOCK TABLES');
			}
		}
	}
	await plugin.exportFooter();
}

const exportController: Controller = async (context) => {
	const { config, response, request } = context;
	const post = request.post;
	response.addScriptFiles(['export_output.js']);
	const globals: Record<string, unknown> = {};
	for (const param of ALLOWED_POST_PARAMS) {
		if (post[param] !== undefined) {
			globals[param] = post[param];
		}
	}
	const missing = ['what', 'export_type'].filter(param => globals[param] === undefined);
	if (missing.length > 0) {
		return missingParameters(context, missing);
	}
	const what = String(stringParam(post.what) ?? '').replaceAll('..', '');
	const exportType = String(stringParam(globals.export_type) ?? '');
	const singleTable = globals.single_table !== undefined;
	const pluginInfo = what === '' ? null : getExportPlugin(what, await exportPluginParam(context, exportType, singleTable));
	if (pluginInfo === null) {
		return fatalError(context, 'Bad type!');
	}

	const compressionMethods: string[] = [];
	if (config.ZipDump) {
		compressionMethods.push('zip');
	}
	if (config.GZipDump) {
		compressionMethods.push('gzip');
	}
	const outputFormat = post.output_format;
	const compressionParam = stringParam(post.compression) ?? '';
	let asfile = true;
	let compression = '';
	let separateFiles = '';
	let bufferNeeded = false;
	if (outputFormat === 'astext') {
		asfile = false;
	} else {
		if (!phpEmpty(post.as_separate_files) && compressionParam === 'zip') {
			separateFiles = String(post.as_separate_files);
		}
		if (compressionMethods.includes(compressionParam)) {
			compression = compressionParam;
			bufferNeeded = true;
		}
	}
	globals.asfile = asfile;
	const out = new ExportOutput(bufferNeeded, asfile);
	// PHP_EOL, which is also what the SQL plugin asks for.
	const run = new ExportRun(context, globals, out, '\n', pluginInfo.properties);
	const plugin = createExportPlugin(what.toLowerCase(), run);
	// A listed format without a port answers like an unknown one.
	if (plugin === null) {
		return fatalError(context, 'Bad type!');
	}

	let tables: string[] = [];
	const { db, table } = context;
	if (exportType === 'database' && db !== '') {
		tables = Array.isArray(globals.table_select) ? globals.table_select as string[] : [];
	} else if (exportType === 'table' && db !== '' && table !== '') {
		// Nothing extra: the table export reads the request's db and table.
	} else if (exportType !== 'server' && exportType !== 'raw') {
		return fatalError(context, 'Bad parameters!');
	}
	globals.tables = tables;
	const sqlQuery = response.globals.sqlQuery;
	await context.dbi.connect();

	let aliases: ExportAliases = queryAliases(context, sqlQuery);
	const posted = postedAliases(post);
	if (posted !== null) {
		aliases = mergeAliases(aliases, posted);
		context.session.tmpval.aliases = posted;
	}

	const { extension, mimeType } = pluginInfo.properties;
	let filename = '';
	let mediaType = '';
	if (asfile) {
		[filename, mediaType] = filenameAndMimetype(context, exportType, !phpEmpty(globals.remember_template), extension, mimeType, compression, stringParam(globals.filename_template) ?? '');
	}
	if (exportType === 'raw') {
		[filename] = finalFilenameAndMimetype(extension, mimeType, compression, 'export');
	}

	let page: { html: string; backButton: string; refreshButton: string; } | null = null;
	if (asfile) {
		downloadHeaders(context, sanitizeFilename(filename), mediaType);
	} else {
		if (exportType === 'database' && tables.length === 0) {
			return showPage(context, 'database', Message.error('No tables found in database.'));
		}
		page = displayedExportHeader(context, exportType);
	}

	try {
		await runExport(run, plugin, what.toLowerCase(), exportType, tables, aliases, separateFiles, sqlQuery);
	} catch (error) {
		let errorHtml: string;
		if (error instanceof PhpError) {
			// ErrorHandler::handleException(): the bare error page.
			const box = `<div class="alert alert-danger" role="alert"><img src="themes/dot.gif" title="" alt="" class="icon ic_s_error"> ${error.errorClass}</div>`;
			// The page head is only printed when nothing was output before the error.
			const head = out.echoed.length === 0 || bufferNeeded ? `<html><head><title>Internal error: ${error.errorClass}</title></head>\n` : '';
			errorHtml = `${head}${box}</body></html>`;
		} else if (error instanceof DbiQueryError) {
			errorHtml = mysqlDieMessage(context, error.formatted, error.query);
		} else {
			throw error;
		}
		// PHP prints the error after what was already echoed; a compressed dump still in its buffer is lost.
		if (page !== null) {
			response.addHTML(page.html + out.echoed.join('') + errorHtml);
			return response.response();
		}
		const rendered = await response.response();
		const echoed = bufferNeeded ? '' : out.echoed.join('');
		return new Response(encodeOutput(echoed + errorHtml) as Uint8Array<ArrayBuffer>, { status: rendered.status, headers: rendered.headers });
	}

	if (page !== null) {
		response.addHTML(page.html + out.echoed.join('') + displayedExportFooter(page.backButton, page.refreshButton));
		return response.response();
	}
	let body: Uint8Array = encodeOutput(out.echoed.join(''));
	if (compression === 'zip') {
		const entries = separateFiles === ''
			? [[filename.slice(0, -4), encodeOutput(out.dumpBuffer)] as [string, Uint8Array]]
			: separateFileNames(filename.slice(0, -4), out.dumpBufferObjects.keys().toArray()).map((name, index): [string, Uint8Array] => [name, encodeOutput(out.dumpBufferObjects.values().toArray()[index])]);
		body = createZip(entries, new Date());
	} else if (compression === 'gzip') {
		body = gzencode(encodeOutput(out.dumpBuffer));
	}
	const rendered = await response.response();
	return new Response(body as Uint8Array<ArrayBuffer>, { status: rendered.status, headers: rendered.headers });
};

export const controllers: Record<string, Controller> = {
	'Export/ExportController': exportController,
	'Export/CheckTimeOutController': async (context) => {
		const { response, session } = context;
		response.isAjax = true;
		if (session.data.pma_export_error !== undefined) {
			delete session.data.pma_export_error;
			response.addJSON('message', 'timeout');
			return response.response();
		}
		response.addJSON('message', 'success');
		return response.response();
	},
};


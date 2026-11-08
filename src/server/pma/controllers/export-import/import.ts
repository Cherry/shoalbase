// Port of Controllers\Import\ImportController: runs an uploaded file or the SQL query box through an import plugin.
import { fatalError, missingParameters } from './export.ts';
import { MAX_UPLOAD_SIZE, UPLOAD_HANDLER } from './import-page.ts';
import { finishedUpload } from './import-status.ts';
import { unQuote } from '../../../../lib/pma/database/routines.ts';
import { bunzip2 } from '../../../../lib/pma/export-import/bzip2.ts';
import {
	decodeImport,
	detectCompression,
	gunzip,
	zipContents,
} from '../../../../lib/pma/export-import/import-file.ts';
import { Message } from '../../../../lib/pma/message.ts';
import { isNumericString } from '../../../../lib/pma/php-compare.ts';
import { mysqlDieHtml } from '../../../../lib/pma/server/mysql-die.ts';
import { MAX_SESSION_BYTES, sessionBytes } from '../../../../lib/pma/session.ts';
import { hasNoRightsToDropDatabase } from '../../../../lib/pma/sql/sql.ts';
import { nestedParams, phpArray, phpEntries } from '../../../../lib/pma/table-data/php-params.ts';
import { backquote } from '../../../../lib/twig/sanitize.ts';
import { getCommon, getFromRoute } from '../../../../lib/twig/url.ts';
import {
	DeleteStatement,
	InsertStatement,
	Parser,
	Query,
	ReplaceStatement,
	UpdateStatement,
} from '../../../../sql-parser/index.ts';
import { generatorState, getMessage } from '../../core/generator.ts';
import {
	Sql,
	SqlExit,
	SqlValueError,
	handleDisableCheckCleanup,
	handleDisableCheckInit,
	parseAnalyze,
	requestGoto,
} from '../../display/sql.ts';
import { loadParserContext } from '../../plugins/export/engine.ts';
import {
	ImportDie,
	type ImportPlugin,
	ImportRun,
	type ImportSource,
} from '../../plugins/import/engine.ts';
import { createImportPlugin } from '../../plugins/import/index.ts';

import type { PmaContext } from '../../core/context.ts';
import type { Controller } from '../../dispatcher.ts';

const FORMATS = new Set(['csv', 'ldi', 'mediawiki', 'ods', 'shp', 'sql', 'xml']);

const isEmpty = (value: unknown): boolean => ([undefined, null, '', '0', false] as unknown[]).includes(value);

/** $_SESSION['Import_message'], which /import-status shows once the upload frame is done. */
export interface ImportMessage {
	message: string | null;
	go_back_url: string | null;
}

function importMessage(context: PmaContext): ImportMessage {
	const data = context.session.data;
	data.Import_message ??= { message: null, go_back_url: null };
	return data.Import_message as ImportMessage;
}

/** Marks this upload as done for /import-status, keeping only the latest upload so the session stays small. */
function recordFinishedUpload(context: PmaContext): void {
	const id = context.request.post.UPLOAD_IDENTIFIER;
	if (typeof id !== 'string' || id.trim() === '') {
		return;
	}
	const status = (context.session.data.__upload_status ?? {}) as Record<string, unknown>;
	context.session.data.__upload_status = { handler: status.handler ?? UPLOAD_HANDLER, [id]: finishedUpload(id) };
}

// Whether the session can still be stored, as one that outgrows MAX_SESSION_BYTES is not saved.
function sessionFits(context: PmaContext): boolean {
	return sessionBytes(context.session.data) <= MAX_SESSION_BYTES;
}

/** Stores the message /import-status shows, falling back to a shorter one when the full text would make the session too large to store. */
function storeMessage(context: PmaContext, html: string, shorter: () => string): void {
	const message = importMessage(context);
	message.message = html;
	if (!sessionFits(context)) {
		message.message = shorter();
	}
}

/** What PHP prints when the whole request is over post_max_size: a startup warning, then the session start failure page. */
function postTooLargePage(length: number): Response {
	const body = `<br />\n<b>Warning</b>:  POST Content-Length of ${length} bytes exceeds the limit of ${MAX_UPLOAD_SIZE} bytes in <b>Unknown</b> on line <b>0</b><br />\n`
		+ '<!DOCTYPE HTML>\n<html lang="en" dir="ltr">\n<head>\n    <link rel="icon" href="favicon.ico" type="image/x-icon">\n'
		+ '    <link rel="shortcut icon" href="favicon.ico" type="image/x-icon">\n    <title>phpMyAdmin</title>\n    <meta charset="utf-8">\n'
		+ '    <style type="text/css">\n        html {\n            padding: 0;\n            margin: 0;\n        }\n        body  {\n'
		+ '            font-family: sans-serif;\n            font-size: small;\n            color: #000000;\n            background-color: #F5F5F5;\n'
		+ '            margin: 1em;\n        }\n        h1 {\n            margin: 0;\n            padding: 0.3em;\n            font-size: 1.4em;\n'
		+ '            font-weight: bold;\n            color: #ffffff;\n            background-color: #ff0000;\n        }\n        p {\n'
		+ '            margin: 0;\n            padding: 0.5em;\n            border: 0.1em solid red;\n            background-color: #ffeeee;\n        }\n'
		+ '    </style>\n</head>\n<body>\n<h1>phpMyAdmin - Error</h1>\n'
		+ '<p>Error during session start; please check your PHP and/or webserver log file and configure your PHP installation properly. '
		+ 'Also ensure that cookies are enabled in your browser.<br><br>session_start(): Session cannot be started after headers have already been sent'
		+ '<br><br>Cannot modify header information - headers already sent</p>\n</body>\n</html>\n';
	return new Response(body, { status: 200, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
}

/** Import::isTableTransactional(). */
async function isTableTransactional(context: PmaContext, name: string): Promise<boolean> {
	const { dbi } = context;
	const parts = name.split('.');
	let db = context.db;
	let table = unQuote(parts[0]);
	if (parts.length === 2) {
		db = unQuote(parts[0]);
		table = unQuote(parts[1]);
	}
	if (await dbi.tryQuery(`SELECT * FROM ${backquote(db)}.${backquote(table)} LIMIT 1`) === false) {
		return false;
	}
	const engines = ['INNODB', 'FALCON', 'NDB', 'INFINIDB', 'TOKUDB', 'XTRADB', 'SEQUENCE', 'BDB', 'ROCKSDB'];
	const result = await dbi.tryQuery('SELECT `ENGINE` FROM `information_schema`.`tables` '
		+ `WHERE \`table_name\` = "${dbi.escapeString(table)}" AND \`table_schema\` = "${dbi.escapeString(db)}" `
		+ `AND UPPER(\`engine\`) IN ("${engines.join('", "')}")`);
	return result !== false && result.numRows() === 1;
}

/** Import::checkIfRollbackPossible(). */
async function checkIfRollbackPossible(context: PmaContext, sqlQuery: string): Promise<boolean> {
	loadParserContext(context);
	const statement = new Parser(sqlQuery).statements[0];
	if (statement === undefined) {
		return true;
	}
	if (!(statement instanceof InsertStatement || statement instanceof UpdateStatement || statement instanceof DeleteStatement || statement instanceof ReplaceStatement)) {
		return false;
	}
	for (const table of Query.getTables(statement)) {
		if (!await isTableTransactional(context, table)) {
			return false;
		}
	}
	return true;
}

/** Import::handleRollbackRequest(): true when the response is already final, as upstream exits there. */
async function handleRollbackRequest(context: PmaContext, sqlQuery: string): Promise<boolean> {
	const { dbi, response, request } = context;
	const delimiter = typeof request.post.sql_delimiter === 'string' ? request.post.sql_delimiter : '';
	let error = '';
	for (const query of (delimiter === '' ? [sqlQuery] : sqlQuery.split(delimiter))) {
		if (isEmpty(query)) {
			continue;
		}
		if (await checkIfRollbackPossible(context, query)) {
			continue;
		}
		error = dbi.getError() || 'Only INSERT, UPDATE, DELETE and REPLACE SQL queries containing transactional engine tables can be rolled back.';
		break;
	}
	if (error !== '') {
		response.addJSON('message', Message.rawError(error));
		return true;
	}
	await dbi.query('START TRANSACTION');
	return false;
}

/**
 * The new name in "RENAME TABLE a TO b", which upstream matches with /^RENAME\s+TABLE\s+(.*?)\s+TO\s+(.*?)($|;|\s)/i;
 * the steps below give the same second group without that pattern's backtracking.
 */
function renamedTable(sqlQuery: string): string | null {
	const head = /^RENAME\s+TABLE\s/i.exec(sqlQuery);
	if (head === null) {
		return null;
	}
	const rest = sqlQuery.slice(head[0].length);
	const to = /\sTO\s/i.exec(rest);
	if (to === null) {
		return null;
	}
	return (/^\s*([^;\s]*)/.exec(rest.slice(to.index + to[0].length)) as RegExpExecArray)[1];
}

/** Applies the query box's :parameter values, as ImportController does before running the query. */
function applyParameters(context: PmaContext, sqlQuery: string): string {
	const post = nestedParams(context.request.post);
	const parameters = phpArray(post.parameters);
	if (isEmpty(post.parameterized) || parameters === undefined || phpEntries(parameters).length === 0) {
		return sqlQuery;
	}
	let query = sqlQuery;
	for (const [parameter, value] of phpEntries(parameters)) {
		let replacement = String(value);
		if (!isNumericString(replacement)) {
			replacement = `'${context.dbi.escapeString(replacement)}'`;
		}
		const quoted = parameter.replaceAll(/[.\\+*?[^\]$(){}=!<>|:#/-]/g, String.raw`\$&`);
		query = query.replaceAll(new RegExp(`${quoted}([^a-zA-Z0-9_])`, 'g'), (_, next: string) => replacement + next);
		query = query.replace(new RegExp(`${quoted}$`), () => replacement);
	}
	return query;
}

/** File::open() on the upload: the decompressed bytes, or the error message to show. */
async function openUpload(context: PmaContext, bytes: Uint8Array): Promise<Uint8Array | Message | 'ValueError'> {
	const compression = detectCompression(bytes);
	const { config } = context;
	if (compression === 'application/gzip' && config.GZipDump) {
		return gunzip(bytes);
	}
	if (compression === 'application/zip' && config.ZipDump) {
		const result = await zipContents(bytes);
		if (result.unreadable) {
			return 'ValueError';
		}
		if (result.error !== '') {
			return Message.rawError(result.error);
		}
		return result.data;
	}
	if (compression === 'none') {
		return bytes;
	}
	if (compression === 'application/bzip2' && config.BZipDump) {
		return bunzip2(bytes);
	}
	return Message.error(`You attempted to load file with unsupported compression (${compression}). Either support for it is not implemented or disabled by your configuration.`);
}

/** ErrorHandler::handleException() for a PHP ValueError: the bare page, with the session's cache headers. */
function valueErrorPage(context: PmaContext): Promise<Response> {
	const { response } = context;
	response.disable();
	response.header('Content-Type', 'text/html; charset=utf-8');
	response.header('Cache-Control', 'private, max-age=10800');
	response.header('Expires', 'Thu, 19 Nov 1981 08:52:00 GMT');
	response.header('Last-Modified', new Date().toUTCString());
	response.addHTML('<html><head><title>Internal error: ValueError</title></head>\n<div class="alert alert-danger" role="alert"><img src="themes/dot.gif" title="" alt="" class="icon ic_s_error"> ValueError</div></body></html>');
	return response.response();
}

/** Sends a final error both ways, as ImportController does when the file or plugin cannot be used. */
function importError(context: PmaContext, message: Message, isGlobal = true): Promise<Response> {
	const display = message.getDisplay();
	// Only the errors kept in the global $message also show above the page.
	if (isGlobal) {
		context.response.globals.message = message;
	}
	importMessage(context).message = display;
	context.response.setRequestStatus(false);
	context.response.addJSON('message', display);
	context.response.addHTML(display);
	return context.response.response();
}

/** Generator::mysqlDie($error, $sql, false, $backUrl, $exit) for the errors the import collected. */
function importMysqlDie(context: PmaContext, serverMessage: string, sqlQuery: string, backUrl: string, exit: boolean): string | null {
	const { response } = context;
	const errorHtml = (query: string): string => mysqlDieHtml({ serverMessage, sqlQuery: query, isModifyLink: false, db: context.db, table: context.table, url: context.urlState(), state: generatorState(context) });
	let html = errorHtml(sqlQuery);
	storeMessage(context, html, () => errorHtml(`${[...sqlQuery].slice(0, 1000).join('')}[...]`));
	if (!exit) {
		return null;
	}
	if (response.isAjax) {
		response.setRequestStatus(false);
		response.addJSON('message', html);
		return '';
	}
	if (backUrl !== '') {
		const message = importMessage(context);
		const url = backUrl.includes('?') ? `${backUrl}&amp;no_history=true` : `${backUrl}?no_history=true`;
		message.go_back_url = url;
		html += `<fieldset class="pma-fieldset tblFooters">[ <a href="${url}">Back</a> ]</fieldset>\n\n`;
	}
	return html;
}

const importController: Controller = async (context) => {
	const { request, response, dbi, config } = context;
	const length = Number(context.astro?.request.headers.get('content-length') ?? 0);
	if (request.method === 'POST' && length > MAX_UPLOAD_SIZE) {
		return postTooLargePage(length);
	}
	if (request.query.console_bookmark_refresh !== undefined) {
		// Console::getBookmarkContent() is empty without the bookmark feature.
		response.addJSON('console_message_bookmark', '');
		return response.response();
	}
	const post = request.post;
	if (post.console_bookmark_add !== undefined) {
		if (post.label === undefined || post.db === undefined || post.bookmark_query === undefined || post.shared === undefined) {
			response.addJSON('message', 'Incomplete params');
			return response.response();
		}
		response.addJSON('message', 'Failed');
		return response.response();
	}

	let format = typeof post.format === 'string' ? post.format : '';
	let importType = typeof post.import_type === 'string' ? post.import_type : undefined;
	const charsetOfFile = typeof post.charset_of_file === 'string' ? post.charset_of_file : null;

	const message = importMessage(context);
	message.message = null;
	message.go_back_url = null;
	context.session.data.is_multi_query ??= false;
	recordFinishedUpload(context);

	const ajaxReload: Record<string, unknown> = {};
	let importText = '';
	let sqlQuery = response.globals.sqlQuery;
	const idBookmark = post.id_bookmark;
	if (!isEmpty(sqlQuery)) {
		sqlQuery = applyParameters(context, sqlQuery);
		importText = sqlQuery;
		importType = 'query';
		format = 'sql';
		context.session.data.sql_from_query_box = true;
		if (post.rollback_query !== undefined && await handleRollbackRequest(context, importText)) {
			return response.response();
		}
		if (/^DROP\s+(?:VIEW|TABLE|DATABASE|SCHEMA)\s+/i.test(sqlQuery)) {
			response.globals.reload = true;
			ajaxReload.reload = true;
		}
		if (/^(?:CREATE|ALTER)\s+(?:VIEW|TABLE|DATABASE|SCHEMA)\s+/i.test(sqlQuery)) {
			ajaxReload.reload = true;
		}
		const renamed = renamedTable(sqlQuery);
		if (renamed !== null) {
			ajaxReload.reload = true;
			ajaxReload.table_name = unQuote(renamed);
		}
		sqlQuery = '';
	} else if (!isEmpty(idBookmark)) {
		importType = 'query';
		format = 'sql';
	}
	response.globals.sqlQuery = sqlQuery;

	if (Object.keys(post).length === 0 && Object.keys(request.query).length === 0) {
		const error = Message.error('You probably tried to upload a file that is too large. Please refer to %sdocumentation%s for a workaround for this limit.');
		error.addParam('[doc@faq1-16]');
		error.addParam('[/doc]');
		message.message = error.getDisplay();
		message.go_back_url = requestGoto(context);
		response.setRequestStatus(false);
		response.addJSON('message', error);
		return response.response();
	}
	if (post.console_message_id !== undefined) {
		response.addJSON('console_message_id', post.console_message_id);
	}
	if (!FORMATS.has(format)) {
		return fatalError(context, 'Incorrect format parameter');
	}
	if (importType === undefined) {
		return missingParameters(context, ['import_type']);
	}

	const { db, table } = context;
	let urlParams: Record<string, unknown> = {};
	if (table !== '' && db !== '') {
		urlParams = { db, table };
	} else if (db !== '') {
		urlParams = { db };
	}
	const url = context.urlState();
	let goto = requestGoto(context);
	if (importType === 'table') {
		goto = getFromRoute(url, '/table/import');
	} else if (importType === 'database') {
		goto = getFromRoute(url, '/database/import');
	} else if (importType === 'server') {
		goto = getFromRoute(url, '/server/import');
	} else if (isEmpty(goto) || !/^index\.php$/i.test(goto)) {
		if (table !== '' && db !== '') {
			goto = getFromRoute(url, '/table/structure');
		} else if (db !== '') {
			goto = getFromRoute(url, '/database/structure');
		} else {
			goto = getFromRoute(url, '/server/sql');
		}
	}
	const errorUrl = goto + getCommon(url, urlParams, '&');
	message.go_back_url = errorUrl;
	if (db !== '') {
		await dbi.selectDb(db);
	}
	// Import::__construct() loads the privileges.
	await dbi.getUserPrivileges();

	const file = context.files.import_file;
	let source: ImportSource | null = null;
	const error = false;
	let runQueryEnabled = true;
	// Bookmark::get() finds nothing without the bookmark feature, so a bookmark action never skips the import.
	if (post.show_as_php !== undefined) {
		runQueryEnabled = false;
	}
	// Encoding::isSupported() holds, so a known charset other than UTF-8 is converted.
	// eslint-disable-next-line unicorn/text-encoding-identifier-case -- the form posts this exact charset name.
	const conversion = charsetOfFile !== null && charsetOfFile !== 'utf-8' && config.AvailableCharsets.includes(charsetOfFile);
	let compression = 'none';
	// A form submitted without a file still sends the field, with an empty file name.
	if (file !== undefined && file.name !== '' && !error) {
		const raw = new Uint8Array(await file.arrayBuffer());
		const opened = await openUpload(context, raw);
		if (opened === 'ValueError') {
			return valueErrorPage(context);
		}
		if (opened instanceof Message) {
			return importError(context, opened, false);
		}
		source = { bytes: opened, raw, text: decodeImport(opened, conversion ? charsetOfFile : null) };
		compression = detectCompression(raw);
	} else if (!error && isEmpty(importText)) {
		return importError(context, Message.error('No data was received to import. Either no file name was submitted, or the file size exceeded the maximum size permitted by your PHP configuration. See [doc@faq1-16]FAQ 1.16[/doc].'));
	}

	const run = new ImportRun(context, source, importText, {
		importType: importType ?? '',
		fileName: file?.name ?? '',
		errorUrl,
		compression: source === null ? '' : compression,
		charsetConversion: conversion,
	});
	run.runQueryEnabled = runQueryEnabled;
	run.goSql = post.show_as_php !== undefined;
	run.error = error;
	run.skipQueries = Math.trunc(Number(post.skip_queries)) || 0;
	if (!error) {
		const plugin: ImportPlugin | null = createImportPlugin(format, importType ?? '');
		if (plugin === null) {
			return importError(context, Message.error('Could not load import plugins, please check your installation!'));
		}
		const previousFkCheck = await handleDisableCheckInit(context);
		try {
			await plugin.doImport(run);
		} catch (caught) {
			if (!(caught instanceof ImportDie)) {
				throw caught;
			}
			response.globals.message = caught.pageMessage;
			const html = importMysqlDie(context, caught.serverMessage, caught.sqlQuery, caught.backUrl, true);
			if (html !== '') {
				response.addHTML(html ?? '');
			}
			return response.response();
		} finally {
			await handleDisableCheckCleanup(context, previousFkCheck);
		}
	}
	// The import worked on the global $sql_query, which the response's reloadQuerywindow reports.
	response.globals.sqlQuery = run.sqlQuery;

	const successMessage = (withNotice: boolean): Message => {
		const success = Message.success(`<em>${run.executedQueries === 1 ? 'Import has been successfully finished, %d query executed.' : 'Import has been successfully finished, %d queries executed.'}</em>`);
		success.addParam(run.executedQueries);
		if (withNotice && !isEmpty(run.importNotice)) {
			success.addHtml(run.importNotice as string);
		}
		if (file !== undefined) {
			success.addText(`(${file.name})`);
		}
		return success;
	};
	// $message, which a plugin may have set, is also the global Header::getMessage() shows above the page.
	let pageMessage = run.message;
	let shorterMessage = (): string => pageMessage?.getDisplay() ?? '';
	if (!isEmpty(idBookmark) && post.action_bookmark === '2') {
		pageMessage = Message.success('The bookmark has been deleted.');
		response.globals.displayQuery = importText;
		run.error = false;
	} else if (!isEmpty(idBookmark) && post.action_bookmark === '1') {
		pageMessage = Message.notice('Showing bookmark');
	} else if (run.finished && !run.error) {
		// The query is shown separately, so the message must not repeat it.
		response.globals.displayQuery = ';';
		if (importType !== 'query') {
			pageMessage = successMessage(true);
			shorterMessage = () => successMessage(false).getDisplay();
		}
	}
	if (pageMessage !== undefined) {
		response.globals.message = pageMessage;
		storeMessage(context, pageMessage.getDisplay(), shorterMessage);
	}

	if ([...run.sqlQuery].length <= config.MaxCharactersInDisplayedSQL) {
		const [analyzed, targetDb, tableFromSql] = parseAnalyze(context, run.sqlQuery, context.db);
		context.db = targetDb;
		response.globals.reload = Boolean(analyzed.reload);
		if (tableFromSql !== '' && tableFromSql !== context.table) {
			context.table = tableFromSql;
		}
	}

	for (const die of run.myDie) {
		const html = importMysqlDie(context, die.error, die.sql, errorUrl, run.error);
		if (html === '') {
			return response.response();
		}
		if (html !== null) {
			response.addHTML(html);
			return response.response();
		}
	}

	if (run.goSql) {
		let queries = [run.sqlQuery];
		if (run.sqlData.valid_queries > 1) {
			context.session.data.is_multi_query = true;
			queries = run.sqlData.valid_sql;
		}
		const sql = new Sql(context);
		let output = '';
		let failedQuery = '';
		try {
			for (const query of queries) {
				failedQuery = query;
				response.globals.sqlQuery = query;
				const [analyzed, targetDb, tableFromSql] = parseAnalyze(context, query, context.db);
				context.db = targetDb;
				response.globals.reload = Boolean(analyzed.reload);
				if (hasNoRightsToDropDatabase(analyzed, config.AllowUserDropDatabase, await dbi.isSuperUser())) {
					const html = importMysqlDie(context, '"DROP DATABASE" statements are disabled.', '', message.go_back_url ?? '', true);
					if (html !== '') {
						response.addHTML(html ?? '');
					}
					return response.response();
				}
				if (tableFromSql !== '' && tableFromSql !== context.table) {
					context.table = tableFromSql;
				}
				output += await sql.executeQueryAndGetQueryResponse({
					analyzed,
					isGotoFile: false,
					db: context.db,
					table: context.table,
					findRealEnd: null,
					extraData: null,
					messageToShow: null,
					sqlData: null,
					goto,
					dispQuery: null,
					dispMessage: null,
					sqlQuery: query,
					completeQuery: null,
				});
			}
		} catch (caught) {
			if (caught instanceof SqlValueError) {
				return valueErrorPage(context);
			}
			if (!(caught instanceof SqlExit)) {
				throw caught;
			}
			// Sql::handleQueryExecuteError() calls mysqlDie(), which also becomes the import message; outside AJAX it is the page.
			const failed = dbi.getError();
			if (failed !== '') {
				const html = mysqlDieHtml({ serverMessage: failed, sqlQuery: failedQuery, isModifyLink: false, db: context.db, table: context.table, url: context.urlState(), state: generatorState(context) });
				storeMessage(context, html, () => html);
				if (!response.isAjax) {
					response.addHTML(html);
				}
			}
			return response.response();
		}
		// An empty PHP array encodes as a JSON list.
		response.addJSON('ajax_reload', Object.keys(ajaxReload).length === 0 ? [] : ajaxReload);
		response.addHTML(output);
		return response.response();
	}

	if (run.result !== false) {
		response.setRequestStatus(true);
		response.addJSON('message', Message.success(run.msg));
		response.addJSON('sql_query', await getMessage(context, run.msg, { sqlQuery: run.sqlQuery, type: 'success' }));
	} else {
		response.setRequestStatus(false);
		response.addJSON('message', Message.error(run.msg));
	}
	// ResponseRenderer::response() uses the echoed output when no HTML was added.
	response.addHTML(run.echoed);
	if (post.rollback_query !== undefined) {
		await dbi.query('ROLLBACK');
	}
	return response.response();
};


export const controllers: Record<string, Controller> = {
	'Import/ImportController': importController,
};

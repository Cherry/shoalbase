// Ports of LintController, Database\SqlFormatController, Database\SqlAutoCompleteController and the browse grid's
// Table\DeleteConfirmController, Table\DeleteRowsController and Table\GetFieldController.
import { jsonHttpHeaders, noCacheHeaders } from '../../../../lib/pma/ajax-response.ts';
import { sanitizeFilename } from '../../../../lib/pma/export-import/filename.ts';
import { phpJsonEncode } from '../../../../lib/pma/json.ts';
import { Message } from '../../../../lib/pma/message.ts';
import { lintForEditor } from '../../../../lib/pma/sql/linter.ts';
import { type PhpValue, nestedParams } from '../../../../lib/pma/table-data/php-params.ts';
import { htmlspecialchars } from '../../../../lib/twig/php.ts';
import { backquote, sanitizeMessage } from '../../../../lib/twig/sanitize.ts';
import { Formatter } from '../../../../sql-parser/index.ts';
import { renderTemplate } from '../../../twig/render.ts';
import { DbiQueryError } from '../../core/dbi.ts';
import { generatorState } from '../../core/generator.ts';
import { checkSqlQuerySignature } from '../../core/sql-signature.ts';
import {
	Sql,
	SqlExit,
	handleDisableCheckCleanup,
	handleDisableCheckInit,
	isForeignKeyCheckEnabled,
} from '../../display/sql.ts';
import { requestGoto } from '../../display/sql.ts';
import { disableResponse } from '../database/common.ts';
import { mysqlDieMessage } from '../server/mysql-die.ts';
import { loadParserContext } from '../table-data/relation.ts';
import { checkDbTableExists } from '../table-structure/common.ts';

import type { PmaContext } from '../../core/context.ts';
import type { ControllerContext } from '../../dispatcher.ts';

const scalar = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** LintController: the lint markers as a bare JSON array. */
async function lintController(context: ControllerContext): Promise<Response> {
	const { response, request } = context;
	const sqlQuery = scalar(request.post.sql_query) ?? '';
	const options = nestedParams(request.post).options;
	const editorType = typeof options === 'object' ? options.editorType : undefined;
	await context.dbi.connect();
	loadParserContext(context);
	const lints = lintForEditor(sqlQuery, editorType);
	response.disable();
	for (const [name, value] of jsonHttpHeaders(new Date())) {
		response.header(name, value);
	}
	response.addHTML(phpJsonEncode(lints));
	return response.response();
}

/** Database\SqlFormatController. */
async function sqlFormatController(context: ControllerContext): Promise<Response> {
	const sql = scalar(context.request.post.sql) ?? '';
	await context.dbi.connect();
	loadParserContext(context);
	context.response.addJSON({ sql: Formatter.format(sql) });
	return context.response.response();
}

/** Database\SqlAutoCompleteController: every table's SHOW COLUMNS rows, json_encode()d into the "tables" key. */
async function sqlAutoCompleteController(context: ControllerContext): Promise<Response> {
	const { dbi, config, request } = context;
	let tables = 'true';
	if (config.EnableAutocompleteForTablesAndColumns) {
		const db = scalar(request.post.db) ?? context.db;
		const entries: string[] = [];
		if (db !== '' && db !== '0') {
			for (const table of await dbi.getTables(db)) {
				const tableColumns = await dbi.getColumns(db, table);
				const columns = tableColumns.entries().map(([name, row]) => `${phpJsonEncode(name)}:${phpJsonEncode(row)}`).toArray();
				entries.push(`${phpJsonEncode(table)}:${columns.length === 0 ? '[]' : `{${columns.join(',')}}`}`);
			}
		}
		tables = entries.length === 0 ? '[]' : `{${entries.join(',')}}`;
	}
	context.response.addJSON({ tables });
	return context.response.response();
}

/** Table\DeleteConfirmController: asks before deleting the rows ticked in the browse grid. */
async function deleteConfirmController(context: ControllerContext): Promise<Response> {
	const { response } = context;
	const selected = nestedParams(context.request.post).rows_to_delete;
	if (typeof selected !== 'object') {
		response.setRequestStatus(false);
		response.addJSON('message', 'No row selected.');
		return response.response();
	}
	const missing = await checkDbTableExists(context);
	if (missing !== null) {
		return missing;
	}
	response.addHTML(await renderTemplate('table/delete/confirm', {
		db: context.db,
		table: context.table,
		selected,
		sql_query: response.globals.sqlQuery,
		is_foreign_key_check: await isForeignKeyCheckEnabled(context),
	}, await context.templateState()));
	return response.response();
}

/** Generator::mysqlDie() with exit: the AJAX error, while a page keeps only what was rendered before. */
function dieWith(context: PmaContext, error: DbiQueryError): Response | Promise<Response> {
	const { response } = context;
	if (response.isAjax) {
		response.setRequestStatus(false);
		response.addJSON('message', mysqlDieMessage(context, error.formatted, error.query));
	}
	return response.response();
}

/** Table\DeleteRowsController: deletes the confirmed rows, then shows the browse query again. */
async function deleteRowsController(context: ControllerContext): Promise<Response> {
	const { response, request, dbi } = context;
	const post = nestedParams(request.post);
	const selected: PhpValue = post.selected ?? {};
	const sql = new Sql(context);
	if (scalar(post.mult_btn) === 'Yes') {
		const previousFkCheck = await handleDisableCheckInit(context);
		for (const row of typeof selected === 'object' ? Object.values(selected) : []) {
			const query = `DELETE FROM ${backquote(context.table)} WHERE ${typeof row === 'string' ? row : ''} LIMIT 1;`;
			await dbi.selectDb(context.db);
			try {
				await dbi.query(query);
			} catch (error) {
				if (error instanceof DbiQueryError) {
					return dieWith(context, error);
				}
				throw error;
			}
		}
		const pos = request.params.pos;
		if (pos !== undefined && pos !== '' && pos !== '0') {
			request.params.pos = String(await sql.calculatePosForLastPage(context.db, context.table, Math.trunc(Number(pos)) || 0));
		}
		await handleDisableCheckCleanup(context, previousFkCheck);
	}
	const sqlQuery = scalar(post.original_sql_query) ?? '';
	response.globals.sqlQuery = sqlQuery;
	try {
		response.addHTML(await sql.executeQueryAndSendQueryResponse({
			analyzed: null,
			isGotoFile: false,
			db: context.db,
			table: context.table,
			findRealEnd: null,
			extraData: null,
			messageToShow: null,
			sqlData: null,
			goto: requestGoto(context),
			dispQuery: null,
			dispMessage: null,
			sqlQuery,
			completeQuery: null,
		}));
	} catch (error) {
		if (!(error instanceof SqlExit)) {
			throw error;
		}
	}
	return response.response();
}

/** Mime::detect(): the media type of a downloaded field from its first bytes. */
function detectMime(bytes: string): string {
	const length = bytes.length;
	if (length >= 2 && bytes.startsWith('ÿØ')) {
		return 'image/jpeg';
	}
	if (length >= 3 && bytes.startsWith('GIF')) {
		return 'image/gif';
	}
	if (length >= 4 && bytes.startsWith('PNG')) {
		return 'image/png';
	}
	return 'application/octet-stream';
}

/** Core::fatalError() on the already disabled get-field response: the bare error document instead of the phpMyAdmin page. */
async function fatalErrorPage(context: PmaContext, message: string): Promise<Response> {
	const { response } = context;
	if (response.isAjax) {
		response.setRequestStatus(false);
		response.addJSON('message', Message.error(message));
		return response.response();
	}
	const state = await context.templateState();
	response.addHTML(await renderTemplate('error/generic', { lang: 'en', dir: 'ltr', error_message: sanitizeMessage(generatorState(context), message) }, state));
	return response.response();
}

/** Table\GetFieldController: downloads one field of one row, as linked from BLOB cells. */
async function getFieldController(context: ControllerContext): Promise<Response> {
	const { response, dbi, request } = context;
	const { db, table } = context;
	disableResponse(context);
	if (!await dbi.selectDb(db)) {
		response.addHTML(mysqlDieMessage(context, `'${htmlspecialchars(db)}' database does not exist.`, '', false));
		return response.response();
	}
	const columns = await dbi.getColumns(db, table);
	if (columns.size === 0) {
		response.addHTML(mysqlDieMessage(context, 'Invalid table name', ''));
		return response.response();
	}
	const where = scalar(request.query.where_clause);
	if (where === undefined || request.query.where_clause_sign === undefined || !checkSqlQuerySignature(context.session, where, scalar(request.query.where_clause_sign))) {
		return fatalErrorPage(context, 'There is an issue with your request.');
	}
	const key = scalar(request.query.transform_key) ?? '';
	const sql = `SELECT ${backquote(key)} FROM ${backquote(table)} WHERE ${where};`;
	const queried = await dbi.tryQuery(sql, false);
	const value = queried === false ? false : queried.fetchValue();
	if (value === false || queried === false) {
		response.addHTML(mysqlDieMessage(context, 'MySQL returned an empty result set (i.e. zero rows).', sql));
		return response.response();
	}
	// Binary columns arrive one char per byte; text columns go back to their UTF-8 bytes.
	const isBinary = queried.getFieldsMeta()[0]?.charsetnr === 63;
	// A NULL field downloads as an empty file, as PHP echoes null as "".
	const body = new Uint8Array(Buffer.from(value ?? '', isBinary ? 'latin1' : 'utf8'));
	const headers: [string, string][] = [
		...noCacheHeaders(new Date()),
		['Content-Description', 'File Transfer'],
		['Content-Disposition', `attachment; filename="${sanitizeFilename(`${table}-${key}.bin`)}"`],
		['Content-Type', detectMime(Buffer.from(body).toString('latin1'))],
		['Content-Transfer-Encoding', 'binary'],
	];
	if (body.length > 0) {
		headers.push(['Content-Length', String(body.length)]);
	}
	return new Response(body, { status: 200, headers });
}

export const controllers = {
	'LintController': lintController,
	'Database/SqlFormatController': sqlFormatController,
	'Database/SqlAutoCompleteController': sqlAutoCompleteController,
	'Table/DeleteConfirmController': deleteConfirmController,
	'Table/DeleteRowsController': deleteRowsController,
	'Table/GetFieldController': getFieldController,
};

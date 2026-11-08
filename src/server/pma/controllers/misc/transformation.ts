// Transformation\OverviewController and WrapperController; without pmadb no column has a MIME type or transformation.
import { noCacheHeaders } from '../../../../lib/pma/ajax-response.ts';
import { shellConfig } from '../../../../lib/pma/config.ts';
import { pageHttpHeaders } from '../../../../lib/pma/header.ts';
import { Message } from '../../../../lib/pma/message.ts';
import { getAvailableMimeTypes, getDescription } from '../../../../lib/pma/transformations.ts';
import { htmlspecialchars } from '../../../../lib/twig/php.ts';
import { backquote, sanitizeMessage } from '../../../../lib/twig/sanitize.ts';
import { renderTemplate } from '../../../twig/render.ts';
import { generatorState } from '../../core/generator.ts';
import { checkSqlQuerySignature } from '../../core/sql-signature.ts';

import type { PmaContext } from '../../core/context.ts';

export async function overviewController(context: PmaContext): Promise<Response> {
	const { response } = context;
	response.disableMenuAndConsole();
	const types = getAvailableMimeTypes();
	const mimeTypes = Object.values(types.mimetype).map((name) => { return { name, is_empty: types.empty_mimetype?.[name] !== undefined }; });
	const transformations = {
		transformation: types.transformation.map((name, index) => { return { name, description: getDescription(types.transformation_file[index]) }; }),
		input_transformation: types.input_transformation.map((name, index) => { return { name, description: getDescription(types.input_transformation_file[index]) }; }),
	};
	response.addHTML(await renderTemplate('transformation_overview', { mime_types: mimeTypes, transformations }, await context.templateState()));
	return response.response();
}

/** Core::fatalError(): the JSON error for AJAX, else the generic error page inside the normal one. */
async function fatalError(context: PmaContext, message: string): Promise<Response> {
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

/** PHP's header(): a header replaces any earlier one of the same name. */
function setHeaders(target: Map<string, [string, string]>, headers: [string, string][]): void {
	for (const [name, value] of headers) {
		target.set(name.toLowerCase(), [name, value]);
	}
}

/**
 * The column value of the first row (or the signed where_clause row) as a download. Without pmadb no column has a
 * MIME type, so the content type is the ct parameter or application/octet-stream; image resizing is not ported.
 */
export async function wrapperController(context: PmaContext): Promise<Response> {
	const { dbi, request, response } = context;
	const { params } = request;
	await dbi.connect();
	// DbTableExists::check() with IS_TRANSFORMATION_WRAPPER: a missing table ends the request with an empty page.
	await dbi.selectDb(context.db);
	const tables = context.table === '' ? false : await dbi.tryQuery(`SHOW TABLES LIKE '${dbi.escapeString(context.table)}';`);
	if (tables === false || tables.numRows() === 0) {
		return response.response();
	}
	const whereClause = typeof params.where_clause === 'string' ? params.where_clause : null;
	let sql = `SELECT * FROM ${backquote(context.table)} LIMIT 1;`;
	if (whereClause !== null) {
		if (!checkSqlQuerySignature(context.session, whereClause, request.query.where_clause_sign ?? '')) {
			return fatalError(context, 'There is an issue with your request.');
		}
		sql = `SELECT * FROM ${backquote(context.table)} WHERE ${whereClause};`;
	}
	const result = await dbi.query(sql);
	const row = result.fetchAssoc();
	if (row === null) {
		return response.response();
	}
	const transformKey = typeof params.transform_key === 'string' ? params.transform_key : '';
	const ct = typeof params.ct === 'string' ? params.ct : '';
	let mimeType = ct === '' ? 'application/octet-stream' : ct;
	// PHP adds the default charset to text types without one.
	if (mimeType.toLowerCase().startsWith('text/') && !mimeType.toLowerCase().includes('charset')) {
		mimeType += ';charset=utf-8';
	}
	const headers = new Map<string, [string, string]>();
	setHeaders(headers, pageHttpHeaders(shellConfig(context.config), new Date()));
	setHeaders(headers, noCacheHeaders(new Date()));
	const filename = (typeof params.cn === 'string' ? params.cn : '').replaceAll(/[^\w.-]/g, '_');
	if (filename !== '') {
		setHeaders(headers, [['Content-Description', 'File Transfer'], ['Content-Disposition', `attachment; filename="${filename}"`]]);
	}
	setHeaders(headers, [['Content-Type', mimeType], ['Content-Transfer-Encoding', 'binary']]);
	if (params.resize !== undefined) {
		return new Response(null, { headers: headers.values().toArray() });
	}
	const value = row[transformKey] ?? '';
	const field = result.getFieldsMeta().find(meta => meta.name === transformKey);
	// Binary columns arrive as latin1 strings that hold the raw bytes.
	let body = new Uint8Array(Buffer.from(value, field?.charsetnr === 63 ? 'latin1' : 'utf8'));
	if (mimeType.toLowerCase().includes('html')) {
		body = new TextEncoder().encode(htmlspecialchars(value));
	}
	return new Response(body, { headers: headers.values().toArray() });
}

export const controllers = {
	'Transformation/OverviewController': overviewController,
	'Transformation/WrapperController': wrapperController,
};

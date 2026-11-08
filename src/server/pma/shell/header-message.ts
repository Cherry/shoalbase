// Port of Html\Generator::getMessage(): a message box, followed by the SQL query box when a query was run.
import { Message } from '../../../lib/pma/message.ts';
import { htmlspecialchars } from '../../../lib/twig/php.ts';
import { sanitizeMessage } from '../../../lib/twig/sanitize.ts';
import { getFromRoute, getHiddenInputs } from '../../../lib/twig/url.ts';
import { createTemplateState, toGeneratorState } from '../../twig/state.ts';
import { isProfilingEnabled, isProfilingSupported } from '../core/profiling.ts';

import type { PmaContext } from '../core/context.ts';

export type GeneratorMessageType = 'notice' | 'error' | 'success';

export interface GeneratorMessageOptions {
	/** Defaults to $GLOBALS['sql_query'], which Common::run() takes from the POSTed sql_query. */
	sqlQuery?: string;
	type?: GeneratorMessageType;
	/** $GLOBALS['show_as_php']; undefined when it is not set at all, which only the Refresh link tells apart from false. */
	showAsPhp?: boolean;
}

// PCRE's [[:space:]] without the u modifier.
const SELECT_PATTERN = /^SELECT[ \t\n\v\f\r]+/i;
const EXPLAIN_SELECT_PATTERN = /^EXPLAIN[ \t\n\v\f\r]+SELECT[ \t\n\v\f\r]+/i;
const REFRESH_PATTERN = /^(?:SELECT|SHOW)[ \t\n\v\f\r]+/i;

const CONTEXTS: Record<GeneratorMessageType, string> = { notice: 'primary', error: 'danger', success: 'success' };

/** htmlspecialchars($value, ENT_COMPAT): single quotes stay as they are. */
function escapeCompat(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;');
}

/** PHP's addslashes(). */
function addSlashes(value: string): string {
	return value.replaceAll(/[\\'"\0]/g, character => (character === '\0' ? String.raw`\0` : `\\${character}`));
}

/** Generator::linkOrButton() for a ready-made URL; long URLs and unsigned queries are sent with data-post instead. */
export function linkOrButton(url: string, message: string, linkLengthLimit: number, tagParams: Record<string, string> = {}): string {
	const attributes: string[] = [];
	let href = url;
	const needsPost = url.length > linkLengthLimit
		|| (url.includes('sql_query=') && !url.includes('sql_signature='))
		|| url.includes('view[as]=');
	if (needsPost) {
		const separator = url.indexOf('?');
		if (separator === -1) {
			attributes.push('data-post=""');
		} else {
			attributes.push(`data-post="${url.slice(separator + 1)}"`);
			href = url.slice(0, separator);
		}
	}
	for (const [name, value] of Object.entries(tagParams)) {
		attributes.push(`${name}="${htmlspecialchars(value)}"`);
	}
	return `<a href="${href}" ${attributes.join(' ')}>${message}</a>`;
}

interface QueryLinks {
	explain: string;
	edit: string;
	php: string;
	refresh: string;
	inlineEdit: string;
}

function queryLinks(context: PmaContext, sqlQuery: string, queryTooBig: boolean, showAsPhp: boolean | undefined): QueryLinks {
	const sqlConfig = context.config.SQLQuery;
	const limit = context.config.LinkLengthLimit;
	const url = context.urlState();
	const link = (route: string, params: Record<string, unknown>, label: string): string => linkOrButton(getFromRoute(url, route, params), label, limit);
	const asPhp = showAsPhp === true;

	const urlParams: Record<string, unknown> = {};
	let editRoute = '/server/sql';
	if (context.db !== '') {
		urlParams.db = context.db;
		editRoute = '/database/sql';
		if (context.table !== '') {
			urlParams.table = context.table;
			editRoute = '/table/sql';
		}
	}

	let explain = '';
	if (sqlConfig.Explain && !queryTooBig) {
		if (SELECT_PATTERN.test(sqlQuery)) {
			explain = ` [&nbsp;${link('/import', { ...urlParams, sql_query: `EXPLAIN ${sqlQuery}` }, 'Explain SQL')}&nbsp;]`;
		} else if (EXPLAIN_SELECT_PATTERN.test(sqlQuery)) {
			// Upstream leaves out the closing &nbsp; on this link.
			explain = ` [&nbsp;${link('/import', { ...urlParams, sql_query: [...sqlQuery].slice(8).join('') }, 'Skip Explain SQL')}]`;
		}
	}

	const queryParams = { ...urlParams, sql_query: sqlQuery, show_query: 1 };
	let edit = '';
	if (sqlConfig.Edit && !asPhp) {
		edit = ` [&nbsp;${link(editRoute, queryParams, 'Edit')}&nbsp;]`;
	}

	let php = '';
	if (sqlConfig.ShowAsPHP && !queryTooBig) {
		if (asPhp) {
			php = ` [&nbsp;${link('/import', queryParams, 'Without PHP code')}&nbsp;]`;
			php += ` [&nbsp;${link('/import', queryParams, 'Submit query')}&nbsp;]`;
		} else {
			php = ` [&nbsp;${link('/import', { ...queryParams, show_as_php: 1 }, 'Create PHP code')}&nbsp;]`;
		}
	}

	let refresh = '';
	if (sqlConfig.Refresh && showAsPhp === undefined && REFRESH_PATTERN.test(sqlQuery)) {
		refresh = ` [&nbsp;${link('/sql', queryParams, 'Refresh')}&nbsp;]`;
	}

	let inlineEdit = '';
	if (sqlConfig.Edit && !queryTooBig && !asPhp) {
		inlineEdit = ` [&nbsp;${linkOrButton('#', 'Edit inline', limit, { class: 'inline_edit_sql' })}&nbsp;]`;
	}
	return { explain, edit, php, refresh, inlineEdit };
}

function formatQuery(sqlQuery: string, maxCharacters: number, showAsPhp: boolean): { html: string; tooBig: boolean; } {
	const characters = [...sqlQuery];
	const tooBig = characters.length > maxCharacters;
	let query = sqlQuery;
	if (tooBig) {
		query = `${characters.slice(0, maxCharacters).join('')}[...]`;
	}
	if (showAsPhp) {
		const newLine = '\\n"<br>\n&nbsp;&nbsp;&nbsp;&nbsp;. "';
		const body = htmlspecialchars(addSlashes(query)).replaceAll(/\r\n|\r|\n/g, () => newLine);
		return { html: `<code class="php" dir="ltr"><pre>\n$sql = "${body}";\n</pre></code>`, tooBig };
	}
	if (tooBig) {
		return { html: `<code class="sql" dir="ltr"><pre>\n${escapeCompat(query)}</pre></code>`, tooBig };
	}
	// Generator::formatSql() without truncation.
	return { html: `<code class="sql" dir="ltr"><pre>\n${escapeCompat(query)}\n</pre></code>`, tooBig };
}

/** Generator::getMessage(). Bookmark and special messages are not ported because prod has no bookmark storage. */
export async function getGeneratorMessage(context: PmaContext, message: Message | string, options: GeneratorMessageOptions = {}): Promise<string> {
	const { config } = context;
	// Upstream prefers a non-empty $GLOBALS['display_query'] over $GLOBALS['sql_query'].
	const displayQuery = context.response.globals.displayQuery;
	const sqlQuery = options.sqlQuery ?? (displayQuery !== undefined && displayQuery !== '' && displayQuery !== '0' ? displayQuery : context.response.globals.sqlQuery);
	const renderSql = config.ShowSQL && sqlQuery !== '' && sqlQuery !== ';';
	const generatorState = toGeneratorState(createTemplateState({ config }));

	let html = '';
	if (renderSql) {
		html += '<div class="result_query">\n';
	}
	if (message instanceof Message) {
		html += message.getDisplay(generatorState);
	} else {
		html += `<div class="alert alert-${CONTEXTS[options.type ?? 'notice']}" role="alert">${sanitizeMessage(generatorState, message)}</div>`;
	}
	if (!renderSql) {
		return html;
	}

	const query = formatQuery(sqlQuery, config.MaxCharactersInDisplayedSQL, options.showAsPhp === true);
	const links = queryLinks(context, sqlQuery, query.tooBig, options.showAsPhp);
	const url = context.urlState();
	html += `<div class="sqlOuter">${query.html}</div>`;
	html += '<div class="tools d-print-none">';
	html += `<form action="${getFromRoute(url, '/sql', { db: context.db, table: context.table })}" method="post" class="disableAjax">`;
	html += getHiddenInputs(url, context.db, context.table);
	html += `<input type="hidden" name="sql_query" value="${htmlspecialchars(sqlQuery)}">`;
	// Only offered with a Refresh link, so ticking it cannot re-run an INSERT.
	if (links.refresh !== '' && await isProfilingSupported(context)) {
		html += '<input type="hidden" name="profiling_form" value="1">';
		html += `<input type="checkbox" name="profiling" id="profilingCheckbox" class="autosubmit"${isProfilingEnabled(context) ? ' checked' : ''}> <label for="profilingCheckbox">Profiling</label>`;
	}
	html += '</form>';
	html += links.inlineEdit + links.edit + links.explain + links.php + links.refresh;
	html += '</div></div>';
	return html;
}

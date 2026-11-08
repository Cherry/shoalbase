// The error box of Html\Generator::mysqlDie(): the failed query, its static analysis and the server's message.
import { Lexer, Parser, ParserError } from '../../../sql-parser/index.ts';
import { type GeneratorState, getIcon, showMySQLDocumentation } from '../../twig/html.ts';
import { htmlspecialchars } from '../../twig/php.ts';
import { type UrlState, getFromRoute } from '../../twig/url.ts';
import { sprintf } from '../sprintf.ts';

export interface MysqlDieInput {
	serverMessage: string;
	sqlQuery: string;
	isModifyLink?: boolean;
	db: string;
	table: string;
	url: UrlState;
	state: GeneratorState;
}

/** htmlspecialchars($value, ENT_COMPAT), which Generator::formatSql() uses. */
function escapeCompat(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;');
}

function editLink(input: MysqlDieInput, sqlQuery: string): string {
	const params: Record<string, unknown> = { sql_query: sqlQuery, show_query: 1 };
	let route = '/server/sql';
	if (input.table !== '') {
		params.db = input.db;
		params.table = input.table;
		route = '/table/sql';
	} else if (input.db !== '') {
		params.db = input.db;
		route = '/database/sql';
	}
	return `<a href="${getFromRoute(input.url, route, params)}">${getIcon(input.state, 'b_edit', 'Edit')}</a>`;
}

/** Formats the server message like upstream: collapsed blank lines, kept spacing and nl2br(). */
function formatServerMessage(message: string): string {
	return message
		.replaceAll(/(?:\r\n|\r|\n){3,}/g, '\n\n')
		.replaceAll('  ', '&nbsp;&nbsp;')
		.replaceAll('\t', '&nbsp;&nbsp;&nbsp;&nbsp;')
		.replaceAll(/\r\n|\n\r|\r|\n/g, line => `<br />${line}`);
}

/** Generator::mysqlDie($serverMessage, $sqlQuery, $isModifyLink, '', false). */
export function mysqlDieHtml(input: MysqlDieInput): string {
	const sqlQuery = input.sqlQuery.trim();
	const lexer = new Lexer(sqlQuery);
	const parser = new Parser(lexer.list);
	const errors = ParserError.get([lexer, parser]);
	let formattedSql = '';
	if (sqlQuery !== '' && errors.length > 0) {
		formattedSql = htmlspecialchars(sqlQuery);
	} else if (sqlQuery !== '') {
		formattedSql = `<code class="sql" dir="ltr"><pre>\n${escapeCompat(sqlQuery)}\n</pre></code>`;
	}

	let html = '<div class="alert alert-danger" role="alert"><h1>Error</h1>';
	// A refused connection hides the query so no details are revealed.
	if (sqlQuery !== '' && sqlQuery !== '0' && !sqlQuery.includes('connect')) {
		if (errors.length > 0) {
			html += '<p><strong>Static analysis:</strong></p>';
			html += `<p>${sprintf('%d errors were found during analysis.', errors.length)}</p>`;
			html += `<p><ol>${ParserError.format(errors, '<li>%2$s (near "%4$s" at position %5$d)</li>').join('')}</ol></p>`;
		}
		html += `<p><strong>SQL query:</strong>  <a href="#" class="copyQueryBtn" data-text="${htmlspecialchars(sqlQuery)}">Copy</a>\n`;
		if (formattedSql.toLowerCase().includes('select')) {
			html += showMySQLDocumentation(input.state, 'SELECT');
		}
		if (input.isModifyLink ?? true) {
			html += editLink(input, sqlQuery);
		}
		html += `    </p>\n<p>\n${formattedSql}\n</p>\n`;
	}
	if (input.serverMessage !== '') {
		html += `<p>\n    <strong>MySQL said: </strong>${showMySQLDocumentation(input.state, 'server-error-reference')}\n</p>\n`;
		html += `<code>${formatServerMessage(input.serverMessage)}</code><br>`;
	}
	return `${html}</div>`;
}

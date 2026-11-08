// Ports of Server\SqlController, Database\SqlController and Table\SqlController: the SQL tab with SqlQueryForm.
import { expandUserString } from '../../../../lib/pma/export-import/filename.ts';
import { getScriptNameForOption } from '../../../../lib/pma/util.ts';
import { htmlspecialchars } from '../../../../lib/twig/php.ts';
import { backquote } from '../../../../lib/twig/sanitize.ts';
import { getCommon, getFromRoute } from '../../../../lib/twig/url.ts';
import { renderTemplate } from '../../../twig/render.ts';
import { generatorState, showMySQLDocumentation } from '../../core/generator.ts';
import { getPageSettings } from '../../core/page-settings.ts';
import { isForeignKeyCheckEnabled } from '../../display/sql.ts';
import { requestGoto } from '../../display/sql.ts';
import { hasDatabase } from '../database/common.ts';
import { checkDbTableExists } from '../table-structure/common.ts';

import type { PmaContext } from '../../core/context.ts';
import type { ControllerContext } from '../../dispatcher.ts';

const SCRIPTS = ['makegrid.js', 'vendor/jquery/jquery.uitablefilter.js', 'sql.js'];

const scalar = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** SqlQueryForm::init(): the legend, the default query and the column list of the form's level. */
async function initForm(context: PmaContext, queryInput: string): Promise<{ legend: string; query: string; columns: unknown[]; }> {
	const { config, db, table } = context;
	const url = context.urlState();
	let query = queryInput;
	let legend: string;
	let columns: unknown[] = [];
	const vars = { httpHost: context.httpHost, serverName: config.Server.host, serverVerbose: config.Server.verbose, database: db, table };
	if (db === '') {
		legend = `Run SQL query/queries on server “${htmlspecialchars(config.Server.verbose === '' ? config.Server.host : config.Server.verbose)}”`;
	} else if (table === '') {
		const script = getScriptNameForOption(url, config.DefaultTabDatabase, 'database');
		const link = `<a href="${script}${getCommon(url, { db }, script.includes('?') ? '&' : '?')}">${htmlspecialchars(db)}</a>`;
		legend = `Run SQL query/queries on database ${link}`;
		if (query === '') {
			query = expandUserString(config.DefaultQueryDatabase, vars, new Date(), backquote);
		}
	} else {
		const tableColumns = await context.dbi.getColumns(db, table, true);
		columns = tableColumns.values().toArray();
		const script = getScriptNameForOption(url, config.DefaultTabTable, 'table');
		const link = `<a href="${script}${getCommon(url, { db, table }, '&')}">${htmlspecialchars(db)}.${htmlspecialchars(table)}</a>`;
		legend = `Run SQL query/queries on table ${link}`;
		if (query === '') {
			query = expandUserString(config.DefaultQueryTable, vars, new Date(), backquote);
		}
	}
	legend += `: ${showMySQLDocumentation(generatorState(context), 'SELECT')}`;
	return { legend, query, columns };
}

/**
 * SqlQueryForm::getHtml(); `query` true shows $GLOBALS['sql_query'] or the show_query request, and `goto` is
 * $GLOBALS['goto'], which the database and table tabs set to themselves.
 */
export async function sqlQueryFormHtml(context: PmaContext, db: string, table: string, query: string | true, delimiter: string, globalGoto: string): Promise<string> {
	const { config, request, response } = context;
	let shown: string;
	if (query === true) {
		shown = response.globals.sqlQuery;
		if (shown === '' && (request.query.show_query !== undefined || request.post.show_query !== undefined)) {
			shown = scalar(request.query.sql_query) ?? scalar(request.post.sql_query) ?? '';
		}
	} else {
		shown = query;
	}
	const url = context.urlState();
	let goto = globalGoto;
	if (goto === '') {
		let route = '/table/sql';
		if (db === '') {
			route = '/server/sql';
		} else if (table === '') {
			route = '/database/sql';
		}
		goto = getFromRoute(url, route);
	}
	const form = await initForm(context, shown);
	return renderTemplate('sql/query', {
		legend: form.legend,
		textarea_cols: config.TextareaCols,
		textarea_rows: config.TextareaRows,
		textarea_auto_select: config.TextareaAutoSelect,
		columns_list: form.columns,
		codemirror_enable: config.CodemirrorEnable,
		has_bookmark: false,
		delimiter,
		retain_query_box: config.RetainQueryBox !== false,
		is_upload: true,
		db,
		table,
		goto,
		query: form.query,
		display_tab: 'full',
		bookmarks: [],
		can_convert_kanji: false,
		is_foreign_key_check: await isForeignKeyCheckEnabled(context),
	}, await context.templateState());
}

/** The page settings dialog the SQL tabs start with; null when a saved form already redirected. */
async function addPageSettings(context: PmaContext): Promise<boolean> {
	const settings = await getPageSettings(context, 'Sql');
	if (settings.saved) {
		return false;
	}
	context.response.addHTML(settings.errorHtml);
	context.response.addHTML(settings.html);
	return true;
}

// $_POST['delimiter'] escaped, as the database and table SQL tabs keep a typed delimiter after an error.
const postedDelimiter = (context: PmaContext): string => {
	const delimiter = context.request.post.delimiter;
	return typeof delimiter === 'string' ? htmlspecialchars(delimiter) : ';';
};

async function serverSqlController(context: ControllerContext): Promise<Response> {
	const { response, dbi } = context;
	response.addScriptFiles(SCRIPTS);
	if (!await addPageSettings(context)) {
		return response.response();
	}
	if (await dbi.isSuperUser()) {
		await dbi.selectDb('mysql');
	}
	response.addHTML(await sqlQueryFormHtml(context, '', '', true, ';', requestGoto(context)));
	return response.response();
}

async function databaseSqlController(context: ControllerContext): Promise<Response> {
	const { response } = context;
	response.addScriptFiles(SCRIPTS);
	if (!await addPageSettings(context)) {
		return response.response();
	}
	if (!await hasDatabase(context)) {
		return response.response();
	}
	response.addHTML(await sqlQueryFormHtml(context, context.db, '', true, postedDelimiter(context), getFromRoute(context.urlState(), '/database/sql')));
	return response.response();
}

async function tableSqlController(context: ControllerContext): Promise<Response> {
	const { response, request } = context;
	response.addScriptFiles(SCRIPTS);
	if (!await addPageSettings(context)) {
		return response.response();
	}
	const missing = await checkDbTableExists(context);
	if (missing !== null) {
		return missing;
	}
	const query = scalar(request.query.sql_query) ?? true;
	response.addHTML(await sqlQueryFormHtml(context, context.db, context.table, query, postedDelimiter(context), getFromRoute(context.urlState(), '/table/sql')));
	return response.response();
}

export const controllers = {
	'Server/SqlController': serverSqlController,
	'Database/SqlController': databaseSqlController,
	'Table/SqlController': tableSqlController,
};

// Port of PhpMyAdmin\Sql: runs a query from /sql (or a caller like delete rows) and renders its result or message.
import { Results } from './results.ts';
import { isSystemSchema } from '../../../lib/pma/dbi-sql.ts';
import { Message } from '../../../lib/pma/message.ts';
import { sprintf } from '../../../lib/pma/sprintf.ts';
import {
	DELETE_ROW,
	type DisplayParts,
	NO_EDIT_OR_DELETE,
	UPDATE_ROW,
	bin2hex,
} from '../../../lib/pma/sql/results.ts';
import {
	detailedProfilingStats,
	isAppendLimitClause,
	isJustBrowsing,
	isRememberSortingOrder,
	resultSetHasJustOneTable,
	startPosToDisplayRow,
} from '../../../lib/pma/sql/sql.ts';
import { htmlspecialchars } from '../../../lib/twig/php.ts';
import { backquote } from '../../../lib/twig/sanitize.ts';
import {
	type AnalyzedQuery,
	Expression,
	Query,
	SelectStatement,
} from '../../../sql-parser/index.ts';
import { renderTemplate } from '../../twig/render.ts';
import { mysqlDieMessage } from '../controllers/server/mysql-die.ts';
import { loadParserContext } from '../controllers/table-data/relation.ts';
import {
	generatorState,
	getDocumentationLink,
	getMessage,
	showDocumentationLink,
} from '../core/generator.ts';
import { findDuplicates, getIndexesFromTable } from '../core/index.ts';
import { enableProfiling, getProfilingInformation } from '../core/profiling.ts';
import { PROP_SORTED_COLUMN, Table } from '../core/table.ts';
import { setMenuTable } from '../shell/menu.ts';

import type { FieldMetadata } from '../../../lib/pma/field-metadata.ts';
import type { PmaContext } from '../core/context.ts';
import type { DbiResult, DbiRow } from '../core/dbi.ts';

/** PHP's exit inside Sql: the controller sends what the response holds so far. */
export class SqlExit extends Error {
	constructor() {
		super('exit');
	}
}

/** mysqli::query('') throws a ValueError, which PHP turns into its bare fatal error page. */
export class SqlValueError extends Error {
	constructor() {
		super('ValueError');
	}
}

export interface QueryResponseInput {
	analyzed: AnalyzedQuery | null;
	isGotoFile: boolean;
	db: string;
	table: string | null;
	findRealEnd: boolean | null;
	extraData: Record<string, unknown> | null;
	messageToShow: string | null;
	sqlData: unknown[] | null;
	goto: string;
	dispQuery: string | null;
	dispMessage: Message | string | null;
	sqlQuery: string;
	completeQuery: string | null;
}

const isEmpty = (value: unknown): boolean => ([undefined, null, '', '0', 0, false] as unknown[]).includes(value);

/** Common::setGotoAndBackGlobals(): $goto when it points into index.php, else ''. */
export function requestGoto(context: PmaContext): string {
	const goto = context.request.params.goto;
	if (typeof goto !== 'string' || goto === '') {
		return '';
	}
	const page = (value: string): string => value.slice(0, value.includes('?') ? value.indexOf('?') : value.length);
	if (goto === 'index.php' || page(goto) === 'index.php') {
		return goto;
	}
	let decoded: string;
	try {
		decoded = decodeURIComponent(goto.replaceAll('+', ' '));
	} catch {
		decoded = goto;
	}
	return page(decoded) === 'index.php' ? goto : '';
}

/** $GLOBALS['urlParams'] as Common::run() leaves it: goto, then the requested db and table, then the server. */
function commonUrlParams(context: PmaContext): Record<string, unknown> {
	const { params } = context.request;
	const urlParams: Record<string, unknown> = {};
	const goto = requestGoto(context);
	if (goto !== '') {
		urlParams.goto = goto;
	}
	urlParams.db = typeof params.db === 'string' ? params.db : '';
	urlParams.table = typeof params.table === 'string' && urlParams.db !== '' ? params.table : '';
	urlParams.server = context.server;
	return urlParams;
}

/** ParseAnalyze::sqlQuery(): the analysis plus the db and table the query targets. */
export function parseAnalyze(context: PmaContext, sqlQuery: string, db: string): [AnalyzedQuery, string, string] {
	loadParserContext(context);
	const analyzed = Query.getAll(sqlQuery);
	let table = '';
	let targetDb = db;
	const selectTables = analyzed.select_tables ?? [];
	if (selectTables.length > 0) {
		const previousDb = db;
		if (selectTables.length === 1) {
			table = String(selectTables[0][0] ?? '');
			if (!isEmpty(selectTables[0][1])) {
				targetDb = String(selectTables[0][1]);
			}
		}
		if (!analyzed.reload && !context.response.isAjax) {
			analyzed.reload = targetDb.toLowerCase() !== previousDb.toLowerCase();
		}
	}
	return [analyzed, targetDb, table];
}

/** ForeignKey::isCheckEnabled(). */
export async function isForeignKeyCheckEnabled(context: PmaContext): Promise<boolean> {
	const setting = context.config.DefaultForeignKeyChecks;
	if (setting === 'enable') {
		return true;
	}
	if (setting === 'disable') {
		return false;
	}
	return await context.dbi.getVariable('FOREIGN_KEY_CHECKS') === 'ON';
}

/** DatabaseInterface::setVariable() for the session. */
async function setVariable(context: PmaContext, name: string, value: string): Promise<void> {
	if (await context.dbi.getVariable(name) === value) {
		return;
	}
	await context.dbi.query(`SET ${name} = ${value};`);
}

/** ForeignKey::handleDisableCheckInit(): applies the posted fk_checks and returns the previous setting. */
export async function handleDisableCheckInit(context: PmaContext): Promise<boolean> {
	const previous = await context.dbi.getVariable('FOREIGN_KEY_CHECKS') === 'ON';
	const requested = context.request.params.fk_checks;
	if (requested !== undefined) {
		await setVariable(context, 'FOREIGN_KEY_CHECKS', isEmpty(requested) ? 'OFF' : 'ON');
	}
	return previous;
}

/** ForeignKey::handleDisableCheckCleanup(). */
export async function handleDisableCheckCleanup(context: PmaContext, previous: boolean): Promise<void> {
	await setVariable(context, 'FOREIGN_KEY_CHECKS', previous ? 'ON' : 'OFF');
}

/** Sql::getDefaultSqlQueryForBrowse(); there are no bookmarks without pmadb. */
export async function defaultSqlQueryForBrowse(context: PmaContext, db: string, table: string): Promise<string> {
	let orderBy = '';
	const order = context.config.TablePrimaryKeyOrder;
	if (order !== 'NONE') {
		const indexes = await getIndexesFromTable(context, table, db);
		const primary = indexes.values().find(index => index.getName() === 'PRIMARY');
		const first = primary?.getColumns().keys().next().value;
		if (first !== undefined) {
			orderBy = ` ORDER BY ${backquote(table)}.${backquote(first)} ${order}`;
		}
	}
	return `SELECT * FROM ${backquote(table)}${orderBy}`;
}

export class Sql {
	private queryTime = 0;

	constructor(private readonly context: PmaContext) {}

	private get tmpval() {
		return this.context.session.tmpval;
	}

	/** Sql::handleSortOrder(): applies or remembers the sort of a single-table browse. */
	private async handleSortOrder(db: string, table: string, analyzed: AnalyzedQuery, sqlQuery: string): Promise<[AnalyzedQuery, string]> {
		const tableObject = Table.get(this.context, table, db);
		const statement = analyzed.statement;
		const list = analyzed.parser?.list;
		if (statement === undefined || list === undefined) {
			return [analyzed, sqlQuery];
		}
		if (!analyzed.order) {
			const sortCol = await tableObject.getUiProp(PROP_SORTED_COLUMN);
			if (isEmpty(sortCol)) {
				return [analyzed, sqlQuery];
			}
			const column = String(sortCol).replaceAll(`${backquote(table)}.`, '');
			loadParserContext(this.context);
			const fullSqlQuery = Query.replaceClause(statement, list, `ORDER BY ${column}`);
			return [Query.getAll(fullSqlQuery), fullSqlQuery];
		}
		loadParserContext(this.context);
		await tableObject.setUiProp(PROP_SORTED_COLUMN, Query.getClause(statement, list, 'ORDER BY'));
		return [analyzed, sqlQuery];
	}

	/** Sql::resultSetContainsUniqueKey(). */
	private async resultSetContainsUniqueKey(db: string, table: string, fieldsMeta: FieldMetadata[]): Promise<boolean> {
		if (table === '') {
			return false;
		}
		const columns = await this.context.dbi.getColumns(db, table);
		const names = new Set(fieldsMeta.map(meta => meta.name));
		const indexes = await getIndexesFromTable(this.context, table, db);
		for (const index of indexes.values()) {
			if (!index.isUnique()) {
				continue;
			}
			const indexColumns = index.getColumns().keys().toArray();
			const found = indexColumns.filter((name) => {
				const column = columns.get(name);
				return names.has(name) || column === undefined || (column.Extra ?? '').includes('INVISIBLE');
			});
			if (found.length === indexColumns.length) {
				return true;
			}
		}
		return false;
	}

	/** Sql::countQueryResults(). */
	private async countQueryResults(numRows: number, justBrowsing: boolean, db: string, table: string, analyzed: AnalyzedQuery): Promise<number | false> {
		const maxRows = this.tmpval.max_rows;
		if (!isAppendLimitClause(analyzed, maxRows)) {
			return numRows;
		}
		if (Number(maxRows) > numRows) {
			return Number(this.tmpval.pos ?? 0) + numRows;
		}
		if (analyzed.querytype !== 'SELECT' && !analyzed.is_subquery) {
			return 0;
		}
		if (justBrowsing) {
			const tableObject = Table.get(this.context, table, db);
			let count = await tableObject.countRecords();
			if (Number(count) < this.context.config.MaxExactCount) {
				count = await tableObject.countRecords(true);
			}
			return count;
		}
		const original = analyzed.statement as SelectStatement;
		const options = original.options;
		let noCacheKey: number | null = null;
		for (const [key, value] of options?.options ?? []) {
			if (typeof value === 'string' && value.toUpperCase() === 'SQL_NO_CACHE') {
				noCacheKey = key;
				break;
			}
		}
		const changeOrder = analyzed.order;
		const changeLimit = analyzed.limit;
		const changeExpression = !analyzed.is_group && !analyzed.distinct && !analyzed.union && original.expr.length === 1;
		let statement = original;
		if (changeOrder || changeLimit || changeExpression || noCacheKey !== null) {
			statement = Object.assign(Object.create(Object.getPrototypeOf(original) as object) as SelectStatement, original);
			statement.expr = [...original.expr];
			if (noCacheKey !== null && options !== null) {
				statement.options = options.clone();
				statement.options.options.delete(noCacheKey);
			}
		}
		statement.order = null;
		statement.limit = null;
		if (changeExpression) {
			const one = new Expression();
			one.expr = '1';
			statement.expr[0] = one;
		}
		loadParserContext(this.context);
		const value = await this.context.dbi.fetchValue(`SELECT COUNT(*) FROM (${statement.build()} ) as cnt`);
		return value === false ? 0 : Number(value);
	}

	/** Sql::executeTheQuery(). Throws SqlExit once the error response is set, like upstream's exit. */
	private async executeTheQuery(analyzed: AnalyzedQuery, fullSqlQuery: string, isGotoFile: boolean, db: string, table: string | null, findRealEnd: boolean | null, extraDataInput: Record<string, unknown> | null): Promise<{ result: DbiResult | false; numRows: number; unlimNumRows: number | false; profiling: DbiRow[] | null; extraData: Record<string, unknown> | null; }> {
		const { dbi, response, config } = this.context;
		let extraData = extraDataInput;
		setMenuTable(this.context, table ?? '');
		await enableProfiling(this.context);
		if (fullSqlQuery === '') {
			throw new SqlValueError();
		}
		const started = performance.now();
		const result = await dbi.tryQuery(fullSqlQuery);
		this.queryTime = (performance.now() - started) / 1000;
		const error = dbi.getError();
		if (error !== '' && config.IgnoreMultiSubmitErrors) {
			extraData = { ...extraData, error };
		} else if (error !== '') {
			if (isGotoFile) {
				response.setRequestStatus(false);
				response.addJSON('message', Message.rawError(error));
			} else if (response.isAjax) {
				response.setRequestStatus(false);
				response.addJSON('message', mysqlDieMessage(this.context, error, fullSqlQuery, false));
			}
			throw new SqlExit();
		}
		let numRows = 0;
		if (analyzed.is_affected) {
			numRows = dbi.affectedRows();
		} else if (result !== false) {
			numRows = result.numRows();
		}
		const profiling = await getProfilingInformation(this.context);
		const justBrowsing = isJustBrowsing(analyzed, findRealEnd);
		const unlimNumRows = await this.countQueryResults(numRows, justBrowsing, db, table ?? '', analyzed);
		if (this.context.request.post.dropped_column !== undefined && db !== '' && table !== null && table !== '') {
			// The structure page swaps in the refreshed index list after dropping a column.
			const indexesList = await renderTemplate('indexes', {
				url_params: commonUrlParams(this.context),
				indexes: await getIndexesFromTable(this.context, table, db),
				indexes_duplicates: await findDuplicates(this.context, table, db),
			}, await this.context.templateState());
			extraData = { ...extraData, indexes_list: indexesList };
		}
		return { result, numRows, unlimNumRows, profiling, extraData };
	}

	/** Sql::getMessageForNoRowsReturned(). */
	private async messageForNoRowsReturned(messageToShow: string | null, analyzed: AnalyzedQuery, numRows: number): Promise<Message> {
		let message: Message;
		if (analyzed.querytype === 'DELETE') {
			message = Message.getMessageForDeletedRows(numRows);
		} else if (analyzed.is_insert) {
			message = analyzed.querytype === 'REPLACE' ? Message.getMessageForAffectedRows(numRows) : Message.getMessageForInsertedRows(numRows);
			const insertId = await this.context.dbi.insertId();
			if (insertId !== 0) {
				message.addText('[br]');
				const inserted = Message.notice('Inserted row id: %1$d');
				inserted.addParam(insertId + numRows - 1);
				message.addMessage(inserted);
			}
		} else if (analyzed.is_affected) {
			message = Message.getMessageForAffectedRows(numRows);
		} else if (!isEmpty(messageToShow) && analyzed.querytype !== 'SELECT') {
			message = Message.rawSuccess(htmlspecialchars(messageToShow));
		} else {
			message = Message.success('MySQL returned an empty result set (i.e. zero rows).');
		}
		const time = Message.notice('(Query took %01.4f seconds.)');
		time.addParam(this.queryTime);
		message.addMessage(time);
		if (this.context.request.post.rollback_query !== undefined) {
			message.addText('[ROLLBACK occurred.]');
		}
		return message;
	}

	private async profilingChart(rows: DbiRow[]): Promise<string> {
		const stats = detailedProfilingStats(rows.map((row) => {
			return { Status: row.Status ?? null, Duration: row.Duration ?? null };
		}));
		return renderTemplate('sql/profiling_chart', {
			profiling: {
				total_time: stats.total_time,
				states: Object.fromEntries(stats.states),
				chart: Object.fromEntries(stats.chart),
				profile: stats.profile,
			},
		}, await this.context.templateState());
	}

	/** Sql::getHtmlForSqlQueryResultsTable() for a single result set. */
	private async sqlQueryResultsTable(display: Results, parts: DisplayParts, editable: boolean, unlimNumRows: number | false, numRows: number, result: DbiResult | false, analyzed: AnalyzedQuery, isLimitedDisplay = false): Promise<string> {
		const { post } = this.context.request;
		const printView = post.printview === '1' ? '1' : null;
		const fieldsMeta = result === false ? [] : result.getFieldsMeta();
		this.context.session.data.is_multi_query = false;
		display.setProperties({
			unlimNumRows,
			fieldsMeta,
			isCount: analyzed.is_count,
			isExport: analyzed.is_export,
			isFunc: analyzed.is_func,
			isAnalyse: analyzed.is_analyse,
			numRows,
			queryTime: this.queryTime,
			isMaint: analyzed.is_maint,
			isExplain: analyzed.is_explain,
			isShow: analyzed.is_show,
			showTable: null,
			printView,
			editable,
			isBrowseDistinct: !isEmpty(post.is_browse_distinct),
		});
		if (result === false) {
			return '';
		}
		return display.getTable(result, parts, analyzed, isLimitedDisplay);
	}

	/** Sql::getQueryResponseForNoResultsReturned(). */
	private async noResultsResponse(analyzed: AnalyzedQuery, db: string, table: string | null, messageToShow: string | null, numRows: number, display: Results, extraDataInput: Record<string, unknown> | null, profiling: DbiRow[] | null, result: DbiResult | false, sqlQuery: string): Promise<string> {
		const { response, config } = this.context;
		const extraData: Record<string, unknown> = { ...extraDataInput };
		const message = typeof extraData.error === 'string' ? Message.rawError(extraData.error) : await this.messageForNoRowsReturned(messageToShow, analyzed, numRows);
		const queryMessage = await getMessage(this.context, message, { sqlQuery, type: 'success' });
		if (response.globals.reload) {
			extraData.reload = 1;
			extraData.db = this.context.db;
		}
		if (isEmpty(this.context.request.params.ajax_page_request)) {
			extraData.message = message;
			if (config.ShowSQL) {
				extraData.sql_query = queryMessage;
			}
		}
		response.addJSON(extraData);
		if ((result !== false && result.numFields() === 0) || extraData.error !== undefined) {
			return queryMessage;
		}
		const parts: DisplayParts = { edit_lnk: null, del_lnk: null, sort_lnk: '1', nav_bar: '0', bkm_form: '1', text_btn: '1', pview_lnk: '1' };
		const tableHtml = await this.sqlQueryResultsTable(display, parts, false, 0, numRows, result, analyzed, true);
		let chart = '';
		if (profiling !== null) {
			response.addScriptFiles(['sql.js']);
			chart = await this.profilingChart(profiling);
		}
		return renderTemplate('sql/no_results_returned', {
			message: queryMessage,
			sql_query_results_table: tableHtml,
			profiling_chart: chart,
			bookmark: '',
			db,
			table,
			sql_query: sqlQuery,
			is_procedure: analyzed.is_procedure,
		}, await this.context.templateState());
	}

	/** Sql::getMessageIfMissingColumnIndex(). */
	private missingColumnIndexMessage(table: string | null, db: string, editable: boolean, hasUniqueKey: boolean): string {
		if (table === null) {
			return '';
		}
		const state = generatorState(this.context);
		const docs = showDocumentationLink(state, getDocumentationLink(state, 'config', 'cfg_RowActionLinksWithoutUnique'));
		let text = '';
		if (isSystemSchema(db) || !editable) {
			text = 'Current selection does not contain a unique column. Grid edit, checkbox, Edit, Copy and Delete features are not available. %s';
		} else if (!hasUniqueKey) {
			text = 'Current selection does not contain a unique column. Grid edit, Edit, Copy and Delete features may result in undesired behavior. %s';
		}
		if (text === '') {
			return '';
		}
		return Message.notice(sprintf(text, docs)).getDisplay(state);
	}

	/** Sql::getQueryResponseForResultsReturned(). */
	private async resultsResponse(result: DbiResult | false, analyzed: AnalyzedQuery, db: string, table: string | null, sqlData: unknown[] | null, display: Results, unlimNumRows: number | false, numRows: number, dispQuery: string | null, dispMessage: Message | string | null, profiling: DbiRow[] | null): Promise<string> {
		const { response, config, request } = this.context;
		const gridEdit = request.post.grid_edit;
		if (gridEdit !== undefined && !isEmpty(gridEdit) && result !== false) {
			const row = result.fetchRow() ?? [];
			let value = row[0] ?? null;
			if (result.getFieldsMeta()[0]?.isBinary && value !== null) {
				value = bin2hex(value);
			}
			response.addJSON('value', value);
			throw new SqlExit();
		}
		const fieldsMeta = result === false ? [] : result.getFieldsMeta();
		let justOneTable = resultSetHasJustOneTable(fieldsMeta);
		let updatableView = false;
		const statement = analyzed.statement;
		if (statement instanceof SelectStatement) {
			if (statement.expr.length > 0 && statement.expr[0].expr === '*' && !isEmpty(table)) {
				updatableView = await Table.get(this.context, table ?? '', db).isUpdatableView();
			}
			if (analyzed.join || analyzed.is_subquery || (analyzed.select_tables ?? []).length !== 1) {
				justOneTable = false;
			}
		}
		const hasUnique = table !== null && await this.resultSetContainsUniqueKey(db, table, fieldsMeta);
		const editable = (hasUnique || config.RowActionLinksWithoutUnique || updatableView) && justOneTable && !isSystemSchema(db);
		this.tmpval.possible_as_geometry = editable;
		let parts: DisplayParts = { edit_lnk: UPDATE_ROW, del_lnk: DELETE_ROW, sort_lnk: '1', nav_bar: '1', bkm_form: '1', text_btn: '0', pview_lnk: '1' };
		if (!editable) {
			parts = { edit_lnk: NO_EDIT_OR_DELETE, del_lnk: NO_EDIT_OR_DELETE, sort_lnk: '1', nav_bar: '1', bkm_form: '1', text_btn: '1', pview_lnk: '1' };
		}
		const isPrintView = request.post.printview === '1';
		if (isPrintView) {
			parts = { edit_lnk: NO_EDIT_OR_DELETE, del_lnk: NO_EDIT_OR_DELETE, sort_lnk: '0', nav_bar: '0', bkm_form: '0', text_btn: '0', pview_lnk: '0' };
		} else {
			response.addScriptFiles(['makegrid.js', 'sql.js']);
			delete response.globals.message;
		}
		let previous = '';
		if (dispQuery !== null && config.ShowSQL && (sqlData === null || sqlData.length === 0)) {
			previous = await getMessage(this.context, dispMessage ?? '', { sqlQuery: dispQuery, type: 'success' });
		}
		const chart = profiling !== null && profiling.length > 0 ? await this.profilingChart(profiling) : '';
		const missing = this.missingColumnIndexMessage(table, db, editable, hasUnique);
		let bookmarkCreated = '';
		const label = request.query.label;
		if (label !== undefined) {
			const created = Message.success('Bookmark %s has been created.');
			created.addParam(String(label));
			bookmarkCreated = created.getDisplay(generatorState(this.context));
		}
		const tableHtml = await this.sqlQueryResultsTable(display, parts, editable, unlimNumRows, numRows, result, analyzed);
		return renderTemplate('sql/sql_query_results', {
			previous_update_query: previous,
			profiling_chart: chart,
			missing_unique_column_message: missing,
			bookmark_created_message: bookmarkCreated,
			table: tableHtml,
			bookmark_support: '',
		}, await this.context.templateState());
	}

	/** Operations::getWarningMessagesArray(): SHOW WARNINGS as "Level: #code message" lines. */
	private async warningMessages(): Promise<string[]> {
		const isMyIsam = this.context.request.post.new_tbl_storage_engine === 'MyISAM';
		const rows = await this.context.dbi.getWarnings();
		return rows.filter(row => !(isMyIsam && row.Code === '1478' && row.Level === 'Error')).map((row) => {
			const message = row.Message ?? '';
			return `${row.Level ?? ''}: #${Number(row.Code ?? 0)}${message === '' ? '' : ` ${message}`}`;
		});
	}

	/** Sql::hasCurrentDbChanged(): a USE statement switched the database. */
	private async hasCurrentDbChanged(db: string): Promise<boolean> {
		if (db === '') {
			return false;
		}
		const current = await this.context.dbi.fetchValue('SELECT DATABASE()');
		return !isEmpty(current) && db !== current;
	}

	/** Sql::executeQueryAndSendQueryResponse(): parses the query first when no analysis is given. */
	async executeQueryAndSendQueryResponse(input: QueryResponseInput): Promise<string> {
		let { analyzed, db, table } = input;
		if (analyzed === null) {
			let tableFromSql: string;
			[analyzed, db, tableFromSql] = parseAnalyze(this.context, input.sqlQuery, db);
			table = tableFromSql === '' ? table : tableFromSql;
		}
		return this.executeQueryAndGetQueryResponse({ ...input, analyzed, db, table });
	}

	/** Sql::executeQueryAndGetQueryResponse(). */
	async executeQueryAndGetQueryResponse(input: QueryResponseInput & { analyzed: AnalyzedQuery; }): Promise<string> {
		const { context } = this;
		const { db, table, findRealEnd } = input;
		let { analyzed, sqlQuery } = input;
		const defaultFkCheck = await handleDisableCheckInit(context);
		if (isRememberSortingOrder(analyzed, context.config.RememberSorting) && !analyzed.union && context.request.post.sort_by_key === undefined) {
			if (context.session.data.sql_from_query_box === undefined) {
				[analyzed, sqlQuery] = await this.handleSortOrder(db, table ?? '', analyzed, sqlQuery);
			} else {
				delete context.session.data.sql_from_query_box;
			}
		}
		const display = new Results(context, context.db, context.table, context.server, input.goto, sqlQuery);
		display.setConfigParamsForDisplayTable(analyzed);
		let fullSqlQuery = sqlQuery;
		if (isAppendLimitClause(analyzed, this.tmpval.max_rows) && analyzed.statement !== undefined && analyzed.parser !== undefined) {
			loadParserContext(context);
			fullSqlQuery = Query.replaceClause(analyzed.statement, analyzed.parser.list, `LIMIT ${this.tmpval.pos}, ${this.tmpval.max_rows}`);
		}
		context.response.globals.reload = await this.hasCurrentDbChanged(db);
		await context.dbi.selectDb(db);
		const executed = await this.executeTheQuery(analyzed, fullSqlQuery, input.isGotoFile, db, table, findRealEnd, input.extraData);
		const warnings = await this.warningMessages();
		let html: string;
		if ((executed.numRows === 0 && Number(executed.unlimNumRows) === 0) || analyzed.is_affected) {
			html = await this.noResultsResponse(analyzed, db, table, input.messageToShow, executed.numRows, display, executed.extraData, executed.profiling, executed.result, sqlQuery);
		} else {
			html = await this.resultsResponse(executed.result, analyzed, db, table, input.sqlData, display, executed.unlimNumRows, executed.numRows, input.dispQuery, input.dispMessage, executed.profiling);
		}
		await handleDisableCheckCleanup(context, defaultFkCheck);
		const state = generatorState(context);
		for (const warning of warnings) {
			html += Message.notice(htmlspecialchars(warning)).getDisplay(state);
		}
		return html;
	}

	/** Sql::findRealEndOfRows(). */
	async findRealEndOfRows(db: string, table: string): Promise<number> {
		const count = Number(await Table.get(this.context, table, db).countRecords(true));
		this.tmpval.pos = startPosToDisplayRow(count, this.tmpval.max_rows ?? 0);
		return count;
	}

	/** Sql::calculatePosForLastPage(). */
	async calculatePosForLastPage(db: string, table: string, posInput: number | null): Promise<number> {
		const pos = posInput ?? Number(this.tmpval.pos ?? 0);
		const count = Number(await Table.get(this.context, table, db).countRecords(true));
		if (count <= pos && pos !== 0) {
			return startPosToDisplayRow(count, this.tmpval.max_rows ?? 0);
		}
		return pos;
	}
}

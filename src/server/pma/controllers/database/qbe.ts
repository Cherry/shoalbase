// Ports of Controllers\Database\QueryByExampleController and Database\Qbe without saved searches (no configuration storage).
import {
	commonUrlParams,
	dbLink,
	getDbInfo,
	hasDatabase,
	internalErrorPage,
	render,
} from './common.ts';
import {
	type IndexedValues,
	type Relations,
	StrictNullError,
	criteriaCounts,
	fillJoinClauses,
	joinClause,
	orderByClause,
	selectClause,
	unfinalizedTables,
	whereClause,
	whereClauseTablesAndColumns,
} from '../../../../lib/pma/database/qbe.ts';
import { Message } from '../../../../lib/pma/message.ts';
import {
	type PhpArray,
	type PhpValue,
	nestedParams,
	phpGet,
} from '../../../../lib/pma/table-data/php-params.ts';
import { looseEquals } from '../../../../lib/pma/table-data/relation.ts';
import { htmlspecialchars } from '../../../../lib/twig/php.ts';
import { backquote } from '../../../../lib/twig/sanitize.ts';
import { getFromRoute } from '../../../../lib/twig/url.ts';
import { Table } from '../../core/table.ts';
import { Sql, SqlExit } from '../../display/sql.ts';
import { getForeigners } from '../table-data/relation.ts';

import type { PmaContext } from '../../core/context.ts';

const SELECTED = ' selected="selected"';

/** A posted value as a string, as the form fields always send one. */
function text(value: PhpValue | undefined): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

/** PHP's empty() for a value read from the posted arrays. */
function isEmpty(value: PhpValue | undefined): boolean {
	if (value === undefined) {
		return true;
	}
	if (typeof value === 'string') {
		return value === '' || value === '0';
	}
	return Object.keys(value).length === 0;
}

/** A posted array, or null where upstream falls back to a list of '' (handled where it differs). */
function postedArray(value: PhpValue | undefined): PhpArray | null {
	return typeof value === 'object' ? value : null;
}

/** Port of PhpMyAdmin\Database\Qbe; loadTables() does the database work of upstream's constructor. */
class Qbe {
	private readonly post: PhpArray;
	private readonly columnCount: number;
	private readonly rowCount: number;
	private readonly baseColumnCount: number;
	private readonly columnInsert: PhpArray | null;
	private readonly columnDelete: PhpArray | null;
	private readonly criteria: PhpArray | null;
	private readonly prevCriteria: PhpArray | null;
	private readonly rowInsert: PhpArray | null;
	private readonly rowDelete: PhpArray | null;
	private readonly andOrRow: PhpArray | null;
	private readonly andOrColumn: PhpArray | null;
	private readonly criteriaTables = new Map<string, string>();
	private readonly columnNames: string[] = [];
	private realWidth = '';
	private readonly formColumns: IndexedValues = new Map();
	private readonly formAliases: IndexedValues = new Map();
	private readonly formSorts: IndexedValues = new Map();
	private readonly formSortOrders: IndexedValues = new Map();
	private readonly formShows: IndexedValues = new Map();
	private readonly formCriterions: IndexedValues = new Map();
	private readonly formAndOrCols: IndexedValues = new Map();
	private readonly formAndOrRows: IndexedValues = new Map();
	private newColumnCount = 0;
	private newRowCount = 0;

	constructor(private readonly context: PmaContext) {
		this.post = nestedParams(context.request.post);
		const counts = criteriaCounts(context.request.post);
		this.columnCount = counts.columns;
		this.rowCount = counts.rows;
		this.baseColumnCount = counts.posted;
		this.columnInsert = postedArray(this.post.criteriaColumnInsert);
		this.columnDelete = postedArray(this.post.criteriaColumnDelete);
		this.prevCriteria = postedArray(this.post.prev_criteria);
		this.criteria = postedArray(this.post.criteria);
		this.rowInsert = postedArray(this.post.criteriaRowInsert);
		this.rowDelete = postedArray(this.post.criteriaRowDelete);
		this.andOrRow = postedArray(this.post.criteriaAndOrRow);
		this.andOrColumn = postedArray(this.post.criteriaAndOrColumn);
	}

	private flag(array: PhpArray | null, index: number): boolean {
		return text(phpGet(array ?? {}, index)) === 'on';
	}

	private inserted(index: number): boolean {
		return this.flag(this.columnInsert, index);
	}

	private deleted(index: number): boolean {
		return this.flag(this.columnDelete, index);
	}

	private postValue(name: string, index: number): string | undefined {
		return text(phpGet(this.post, name, index));
	}

	private columnSelectCell(columnNumber: number, selected = ''): Promise<string> {
		return render(this.context, 'database/qbe/column_select_cell', { column_number: columnNumber, column_names: this.columnNames, selected });
	}

	private sortSelectCell(columnNumber: number, selected = ''): Promise<string> {
		return render(this.context, 'database/qbe/sort_select_cell', { real_width: this.realWidth, column_number: columnNumber, selected });
	}

	private sortOrderSelectCell(columnNumber: number, sortOrder: string | null): Promise<string> {
		let total = this.columnCount;
		if (!isEmpty(this.columnInsert ?? undefined)) {
			total += Object.keys(this.columnInsert ?? {}).length;
		}
		if (!isEmpty(this.columnDelete ?? undefined)) {
			total -= Object.keys(this.columnDelete ?? {}).length;
		}
		return render(this.context, 'database/qbe/sort_order_select_cell', { total_column_count: total, column_number: columnNumber, sort_order: sortOrder });
	}

	/** Walks the columns the way every row builder does: inserted columns get an empty cell, deleted ones are skipped. */
	private async eachColumn(insertedCell: (column: number) => Promise<string> | string, cell: (index: number, column: number) => Promise<string> | string): Promise<string> {
		let html = '';
		let column = 0;
		for (let index = 0; index < this.columnCount; index++) {
			if (this.inserted(index)) {
				html += await insertedCell(column);
				column++;
			}
			if (this.deleted(index)) {
				continue;
			}
			html += await cell(index, column);
			column++;
		}
		this.newColumnCount = column;
		return html;
	}

	private columnNamesRow(): Promise<string> {
		return this.eachColumn(column => this.columnSelectCell(column), (index, column) => {
			const selected = this.postValue('criteriaColumn', index);
			if (selected !== undefined) {
				this.formColumns.set(column, selected);
			}
			return this.columnSelectCell(column, selected ?? '');
		});
	}

	private columnAliasRow(): Promise<string> {
		return this.eachColumn(column => `<td class="text-center"><input type="text" name="criteriaAlias[${column}]"></td>`, (index, column) => {
			let alias = '';
			const posted = this.postValue('criteriaAlias', index);
			if (!isEmpty(posted)) {
				alias = posted as string;
				this.formAliases.set(column, alias);
			}
			return `<td class="text-center"><input type="text" name="criteriaAlias[${column}]" value="${htmlspecialchars(alias)}"></td>`;
		});
	}

	private showRow(): Promise<string> {
		return this.eachColumn(column => `<td class="text-center"><input type="checkbox" name="criteriaShow[${column}]"></td>`, (index, column) => {
			let checked = '';
			const posted = this.postValue('criteriaShow', index);
			if (posted !== undefined) {
				checked = ' checked="checked"';
				this.formShows.set(column, posted);
			}
			return `<td class="text-center"><input type="checkbox" name="criteriaShow[${column}]"${checked}></td>`;
		});
	}

	private sortRow(): Promise<string> {
		return this.eachColumn(column => this.sortSelectCell(column), (index, column) => {
			let sort = this.postValue('criteriaSort', index);
			// Sorting is not available for the * selector (bug #570698).
			if (sort !== undefined && (this.postValue('criteriaColumn', index) ?? '').endsWith('.*')) {
				sort = '';
			}
			let selected = '';
			this.formSorts.set(column, sort ?? '');
			if (sort === 'ASC' || sort === 'DESC') {
				selected = sort;
			}
			return this.sortSelectCell(column, selected);
		});
	}

	private sortOrderRow(): Promise<string> {
		return this.eachColumn(column => this.sortOrderSelectCell(column, null), (index, column) => {
			let sortOrder: string | null = null;
			const posted = this.postValue('criteriaSortOrder', index);
			if (!isEmpty(posted)) {
				sortOrder = posted as string;
				this.formSortOrders.set(column, sortOrder);
			}
			return this.sortOrderSelectCell(column, sortOrder);
		});
	}

	private criteriaInputboxRow(): Promise<string> {
		const style = `class="textfield" style="width: ${this.realWidth}" size="20"`;
		return this.eachColumn(column => `<td class="text-center"><input type="text" name="criteria[${column}]" ${style}></td>`, (index, column) => {
			const criterion = text(phpGet(this.criteria ?? {}, index)) ?? '';
			const previous = text(phpGet(this.prevCriteria ?? {}, index));
			// PHP's loose != keeps the previous text when both are the same number written differently.
			const kept = isEmpty(this.prevCriteria ?? undefined) || previous === undefined || !looseEquals(previous, criterion) ? criterion : previous;
			this.formCriterions.set(column, kept);
			return `<td class="text-center"><input type="hidden" name="prev_criteria[${column}]" value="${htmlspecialchars(kept)}"><input type="text" name="criteria[${column}]" value="${htmlspecialchars(criterion)}" ${style}></td>`;
		});
	}

	private andOrColCell(column: number, selected: { or: string; and: string; } | null = null, lastColumn = false): string {
		let html = '<td class="text-center">';
		if (!lastColumn) {
			html += `<strong>Or:</strong><input type="radio" name="criteriaAndOrColumn[${column}]" value="or"${selected?.or ?? ''}>`;
			html += `&nbsp;&nbsp;<strong>And:</strong><input type="radio" name="criteriaAndOrColumn[${column}]" value="and"${selected?.and ?? ''}>`;
		}
		html += `<br>Ins<input type="checkbox" name="criteriaColumnInsert[${column}]">`;
		html += `&nbsp;&nbsp;Del<input type="checkbox" name="criteriaColumnDelete[${column}]">`;
		return `${html}</td>`;
	}

	private modifyColumnsRow(): Promise<string> {
		return this.eachColumn(column => this.andOrColCell(column), (index, column) => {
			const andOr = text(phpGet(this.andOrColumn ?? {}, index));
			if (this.andOrColumn === null && index < this.baseColumnCount) {
				// Upstream's default is a list of '' as long as the posted column count.
				this.formAndOrCols.set(column, '');
			} else if (andOr !== undefined) {
				this.formAndOrCols.set(column, andOr);
			}
			const options = andOr === 'or' ? { or: ' checked="checked"', and: '' } : { or: '', and: ' checked="checked"' };
			return this.andOrColCell(column, options, index + 1 === this.columnCount);
		});
	}

	private inputboxRow(row: number): Promise<string> {
		const style = `class="textfield" style="width: ${this.realWidth}" size="20"`;
		// Upstream doubles the "Or" prefix in the name of an inserted column's box.
		return this.eachColumn(column => `<td class="text-center"><input type="text" name="OrOr${row}[${column}]" ${style}></td>`, (index, column) => {
			const value = isEmpty(this.post[`Or${row}`]) ? '' : this.postValue(`Or${row}`, index) ?? '';
			return `<td class="text-center"><input type="text" name="Or${row}[${column}]" value="${htmlspecialchars(value)}" ${style}></td>`;
		});
	}

	private async insDelAndOrCriteriaRows(): Promise<string> {
		let html = '';
		let newRow = 0;
		const rowHtml = async (index: number, checked: { or: boolean; and: boolean; }): Promise<string> => {
			const cell = await render(this.context, 'database/qbe/ins_del_and_or_cell', { row_index: index, checked_options: checked });
			return `<tr class="noclick">${cell}${await this.inputboxRow(index)}</tr>`;
		};
		for (let row = 0; row <= this.rowCount; row++) {
			if (this.flag(this.rowInsert, row)) {
				html += await rowHtml(newRow, { or: true, and: false });
				newRow++;
			}
			if (this.flag(this.rowDelete, row)) {
				continue;
			}
			const andOr = text(phpGet(this.andOrRow ?? {}, row));
			if (this.andOrRow === null && row < this.baseColumnCount) {
				// The default is sized by the column count, and an empty entry still adds a space to the WHERE clause.
				this.formAndOrRows.set(newRow, '');
			} else if (andOr !== undefined) {
				this.formAndOrRows.set(newRow, andOr);
			}
			html += await rowHtml(newRow, andOr === 'and' ? { or: false, and: true } : { or: true, and: false });
			newRow++;
		}
		this.newRowCount = newRow;
		return html;
	}

	/** Qbe::loadRelationsForTable(): the foreign keys of a table, as join conditions by referenced table. */
	private async loadRelations(relations: Relations, table: string): Promise<void> {
		const { context } = this;
		const joins = new Map<string, string>();
		relations.set(table, joins);
		const foreigners = await getForeigners(context, context.db, table);
		for (const key of foreigners.foreign_keys_data ?? []) {
			const clauses = (key.index_list ?? []).map((field, index) => `${backquote(table)}.${backquote(field)} = ${backquote(key.ref_table_name)}.${backquote(key.ref_index_list?.[index])}`);
			joins.set(String(key.ref_table_name), clauses.join(' AND '));
		}
	}

	/**
	 * Qbe::getMasterTable(). Upstream's index lookup tests column names against a list, so it never finds a candidate,
	 * which leaves the where clause columns or else the search tables.
	 */
	private async masterTable(searchTables: string[], whereColumns: Map<string, string>, whereTables: Map<string, string>): Promise<string> {
		const { context } = this;
		if (whereTables.size === 1) {
			return whereTables.keys().toArray()[0];
		}
		let candidates = new Map(whereColumns.size > 0 ? whereColumns : searchTables.map((table): [string, string] => [table, table]));
		const foreignTables = new Map<string, string>();
		for (const table of candidates.values()) {
			const foreigners = await getForeigners(context, context.db, table);
			for (const key of foreigners.foreign_keys_data ?? []) {
				const referenced = String(key.ref_table_name);
				if (candidates.values().toArray().includes(referenced)) {
					foreignTables.set(referenced, referenced);
				}
			}
		}
		if (foreignTables.size > 0) {
			candidates = foreignTables;
		}
		if (candidates.size <= 1) {
			return candidates.values().toArray()[0] ?? '';
		}
		// The largest table is the master, counted once per table name.
		const sizes = new Map<string, number | false>();
		let maxSize = -1;
		let result = '';
		for (const table of candidates.values()) {
			if (!sizes.has(table)) {
				sizes.set(table, await Table.get(context, table, context.db).countRecords());
			}
			const size = sizes.get(table);
			// PHP's false <= $maxsize always holds, so a table that cannot be counted is never picked.
			if (size === false || size === undefined || size <= maxSize) {
				continue;
			}
			maxSize = size;
			result = table;
		}
		return result;
	}

	/**
	 * The intermediary search of Qbe::getJoinForFromClause() for one unjoined table: each table referencing it is tried,
	 * and kept when it joins more tables. True once every table is joined.
	 */
	private async joinThroughReferences(table: string, relations: Relations, state: { finalized: Map<string, string>; searchTables: string[]; }, unfinalizedCount: number): Promise<boolean> {
		const { dbi, db } = this.context;
		const rows = await dbi.fetchResult<Record<string, string>>(
			`SELECT \`column_name\`, \`table_name\`, \`table_schema\`, \`referenced_column_name\` FROM \`information_schema\`.\`key_column_usage\` WHERE \`referenced_table_name\` = '${dbi.escapeString(table)}' AND \`referenced_table_schema\` = '${dbi.escapeString(db)}'`,
		);
		// Relation::getChildReferences() groups the rows by referenced column.
		const references = Map.groupBy(rows, row => row.referenced_column_name).values().toArray()
			.flat();
		for (const reference of references) {
			if (reference.table_schema !== db) {
				continue;
			}
			await this.loadRelations(relations, reference.table_name);
			const tempFinalized = new Map(state.finalized);
			const tempSearchTables = [...state.searchTables, reference.table_name];
			fillJoinClauses(tempFinalized, relations, tempSearchTables);
			const tempUnfinalized = unfinalizedTables(tempSearchTables, tempFinalized);
			if (tempUnfinalized.length < unfinalizedCount) {
				state.finalized = tempFinalized;
				state.searchTables = tempSearchTables;
			}
			if (tempUnfinalized.length === 0) {
				return true;
			}
		}
		return false;
	}

	/** Qbe::getJoinForFromClause(). */
	private async joinForFromClause(initialTables: string[]): Promise<string> {
		const relations: Relations = new Map();
		for (const table of initialTables) {
			await this.loadRelations(relations, table);
		}
		const criteria = Object.keys(this.criteria ?? {}).map((_, index) => text(phpGet(this.criteria ?? {}, index)));
		const counted = this.criteria === null ? Array.from({ length: this.baseColumnCount }, () => '') : criteria;
		const where = whereClauseTablesAndColumns(counted, index => this.postValue('criteriaColumn', index));
		const master = await this.masterTable(initialTables, where.columns, where.tables);
		const state = { finalized: new Map<string, string>(), searchTables: initialTables };
		if (master !== '') {
			state.finalized.set(master, '');
		}
		fillJoinClauses(state.finalized, relations, state.searchTables);
		let unfinalized = unfinalizedTables(state.searchTables, state.finalized);
		if (unfinalized.length > 0) {
			for (const table of unfinalized) {
				if (await this.joinThroughReferences(table, relations, state, unfinalized.length)) {
					break;
				}
			}
			unfinalized = unfinalizedTables(state.searchTables, state.finalized);
		}
		return joinClause(unfinalized, state.finalized);
	}

	/** Qbe::getFromClause(). */
	private async fromClause(): Promise<string> {
		if (this.formColumns.size === 0) {
			return '';
		}
		const searchTables = new Map<string, string>();
		for (const value of this.formColumns.values()) {
			const [table, column] = value.split('.', 2);
			if (isEmpty(table) || isEmpty(column)) {
				continue;
			}
			const name = table.replaceAll('`', '');
			searchTables.set(name, name);
		}
		const tables = searchTables.values().toArray();
		const join = await this.joinForFromClause(tables);
		if (join !== '' && join !== '0') {
			return join;
		}
		return tables.map(table => backquote(table)).join(', ');
	}

	private async sqlQuery(): Promise<string> {
		let query = selectClause(this.columnCount, this.formColumns, this.formShows, this.formAliases);
		const from = await this.fromClause();
		if (from !== '') {
			query += `FROM ${from}\n`;
		}
		query += whereClause({
			columnCount: this.columnCount,
			rowCount: this.rowCount,
			columns: this.formColumns,
			criterions: this.formCriterions,
			andOrColumns: this.formAndOrCols,
			andOrRows: this.formAndOrRows,
			orValue: (row, column) => this.postValue(`Or${row}`, column),
		});
		return query + orderByClause(this.columnCount, this.formColumns, this.formSorts, this.formSortOrders);
	}

	/** Qbe::setCriteriaTablesAndColumns(); false when the database has no tables (upstream echoes an error and exits). */
	async loadTables(): Promise<boolean> {
		const { db, dbi } = this.context;
		const tableList = postedArray(this.post.TableList);
		for (const table of Object.values(tableList ?? {})) {
			this.criteriaTables.set(String(table), SELECTED);
		}
		const result = await dbi.query(`SHOW TABLES FROM ${backquote(db)};`);
		const tables = result.fetchAllColumn().map(String);
		if (tables.length === 0) {
			return false;
		}
		let width = 12;
		for (const table of tables) {
			const columns = await dbi.getColumns(db, table);
			if (isEmpty(this.criteriaTables.get(table)) && !isEmpty(this.post.TableList)) {
				this.criteriaTables.set(table, '');
			} else {
				this.criteriaTables.set(table, SELECTED);
			}
			if (this.criteriaTables.get(table) !== SELECTED) {
				continue;
			}
			const quotedTable = backquote(table);
			this.columnNames.push(`${quotedTable}.*`);
			for (const column of columns.keys()) {
				const name = `${quotedTable}.${backquote(column)}`;
				this.columnNames.push(name);
				width = Math.max([...name].length, width);
			}
		}
		this.realWidth = `${width}ex`;
		return true;
	}

	/** Qbe::getSelectionForm(). */
	async getSelectionForm(): Promise<string> {
		const { context } = this;
		const columnNamesRow = await this.columnNamesRow();
		const columnAliasRow = await this.columnAliasRow();
		const showRow = await this.showRow();
		const sortRow = await this.sortRow();
		const sortOrder = await this.sortOrderRow();
		const criteriaInputBoxRow = await this.criteriaInputboxRow();
		const insDelAndOrCriteriaRows = await this.insDelAndOrCriteriaRows();
		const modifyColumnsRow = await this.modifyColumnsRow();
		return render(context, 'database/qbe/selection_form', {
			db: context.db,
			url_params: { db: context.db, criteriaColumnCount: this.newColumnCount, rows: this.newRowCount - 1 },
			db_link: dbLink(context, context.db),
			criteria_tables: this.criteriaTables,
			saved_searches_field: '',
			column_names_row: columnNamesRow,
			column_alias_row: columnAliasRow,
			show_row: showRow,
			sort_row: sortRow,
			sort_order: sortOrder,
			criteria_input_box_row: criteriaInputBoxRow,
			ins_del_and_or_criteria_rows: insDelAndOrCriteriaRows,
			modify_columns_row: modifyColumnsRow,
			sql_query: await this.sqlQuery(),
		});
	}
}

/** Database\QueryByExampleController. */
export async function queryByExampleController(context: PmaContext): Promise<Response> {
	const { request, response } = context;
	response.addScriptFiles(['database/qbe.js']);
	const sqlQuery = typeof request.post.sql_query === 'string' ? request.post.sql_query : '';
	let hasMessageToDisplay = false;
	let addedHtml = false;
	if (request.post.submit_sql !== undefined && sqlQuery !== '' && sqlQuery !== '0') {
		if (!sqlQuery.toUpperCase().startsWith('SELECT')) {
			hasMessageToDisplay = true;
		} else {
			try {
				response.addHTML(await new Sql(context).executeQueryAndSendQueryResponse({
					analyzed: null,
					isGotoFile: false,
					db: typeof request.post.db === 'string' ? request.post.db : '',
					table: null,
					findRealEnd: false,
					extraData: null,
					messageToShow: null,
					sqlData: null,
					goto: getFromRoute(context.urlState(), '/database/sql'),
					dispQuery: null,
					dispMessage: null,
					sqlQuery,
					completeQuery: null,
				}));
				addedHtml = true;
			} catch (error) {
				if (!(error instanceof SqlExit)) {
					throw error;
				}
				return response.response();
			}
		}
	}
	if (!await hasDatabase(context)) {
		return response.response();
	}
	const urlParams = { ...commonUrlParams(context), goto: getFromRoute(context.urlState(), '/database/qbe') };
	await getDbInfo(context, '_qbe');
	const qbe = new Qbe(context);
	if (!await qbe.loadTables()) {
		// Upstream echoes the error and exits, so the echo is the page unless the query results were already added.
		if (!addedHtml) {
			response.addHTML(Message.error('No tables found in database.').getDisplay());
		}
		return response.response();
	}
	let selectionForm: string;
	try {
		selectionForm = await qbe.getSelectionForm();
	} catch (error) {
		if (!(error instanceof StrictNullError)) {
			throw error;
		}
		return internalErrorPage(context, 'TypeError');
	}
	response.addHTML(await render(context, 'database/qbe/index', {
		url_params: urlParams,
		has_message_to_display: hasMessageToDisplay,
		selection_form_html: selectionForm,
	}));
	return response.response();
}

export const controllers = {
	'Database/QueryByExampleController': queryByExampleController,
};

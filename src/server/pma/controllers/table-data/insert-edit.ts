// Port of PhpMyAdmin\InsertEdit's database and rendering parts: the insert/edit form rows and the edit-mode row lookup.
import {
	type ForeignData,
	dropdownConfig,
	getComments,
	getForeignData,
} from './relation.ts';
import { escapeString } from '../../../../lib/pma/dbi-sql.ts';
import { getUniqueCondition } from '../../../../lib/pma/sql/results.ts';
import {
	type AnalyzedColumn,
	type EditConfig,
	type SpecialChars,
	type TableColumn,
	analyzeTableColumnsArray,
	bin2hex,
	getFunctionsForField,
	getGisDataTypes,
	getHtmlInput,
	getMaxUploadSize,
	getNullifyCode,
	getSpecialCharsForExistingRow,
	getSpecialCharsForInsertingMode,
	getValueColumnForOtherDatatypes,
	isColumn,
	isColumnBinary,
	onChangeClause,
	protectedBlobSize,
	showTypeOrFunctionParams,
	truthy,
	typeAndDecimals,
} from '../../../../lib/pma/table-data/insert-edit.ts';
import {
	type PhpArray,
	type PhpValue,
	phpEntries,
	phpScalar,
} from '../../../../lib/pma/table-data/php-params.ts';
import { type Foreigners, foreignDropdown, looseEquals } from '../../../../lib/pma/table-data/relation.ts';
import { getTypeClass } from '../../../../lib/pma/table-data/types.ts';
import { extractColumnSpec } from '../../../../lib/pma/table-structure/column-spec.ts';
import { htmlspecialchars } from '../../../../lib/twig/php.ts';
import { backquote } from '../../../../lib/twig/sanitize.ts';
import { getCommon, getFromRoute } from '../../../../lib/twig/url.ts';
import { getMessage } from '../../core/generator.ts';
import { Table } from '../../core/table.ts';
import { render } from '../table-structure/common.ts';

import type { PmaContext } from '../../core/context.ts';
import type { DbiResult, DbiRow } from '../../core/dbi.ts';

// The oracle's PHP upload_max_filesize, which Config's max_upload_size reports.
export const MAX_UPLOAD_SIZE = 2_097_152;

/** $cfg as the insert/edit helpers read it; a copy, because CharEditing changes while rendering. */
export function editConfig(context: PmaContext): EditConfig {
	const { config } = context;
	return {
		ShowFunctionFields: config.ShowFunctionFields,
		ShowFieldTypesInDataEditView: config.ShowFieldTypesInDataEditView,
		ProtectBinary: config.ProtectBinary as string | false,
		CharEditing: config.CharEditing,
		MinSizeForInputField: config.MinSizeForInputField,
		MaxSizeForInputField: config.MaxSizeForInputField,
		TextareaRows: config.TextareaRows,
		TextareaCols: config.TextareaCols,
		CharTextareaRows: config.CharTextareaRows,
		CharTextareaCols: config.CharTextareaCols,
		LongtextDoubleTextarea: config.LongtextDoubleTextarea,
		LimitChars: config.LimitChars,
		DefaultFunctions: config.DefaultFunctions,
	};
}

/** InsertEdit::getTableColumns(). */
export async function getTableColumns(context: PmaContext, db: string, table: string): Promise<TableColumn[]> {
	await context.dbi.selectDb(db);
	const columns = await context.dbi.getColumns(db, table, true);
	// eslint-disable-next-line antislop/no-chained-type-assertions -- SHOW FULL COLUMNS rows always carry these fields, but the DBI returns them as untyped rows.
	return columns.values().toArray() as unknown as TableColumn[];
}

/** InsertEdit::getCommentsMap(). */
export async function getCommentsMap(context: PmaContext, db: string, table: string): Promise<Record<string, string>> {
	if (context.config.ShowPropertyComments) {
		return getComments(context, db, table);
	}
	return {};
}

/** Gis::convertToWellKnownText(). */
export async function convertToWellKnownText(context: PmaContext, data: string, includeSrid = false): Promise<string> {
	const { dbi } = context;
	const hex = bin2hex(data);
	const version = dbi.getVersion();
	const asText = version >= 50600 ? 'ST_ASTEXT' : 'ASTEXT';
	const srid = version >= 50600 ? 'ST_SRID' : 'SRID';
	const axisOrder = version >= 80001 && !dbi.isMariaDB() ? ', \'axis-order=long-lat\'' : '';
	let sql = `SELECT ${asText}(x'${hex}'${axisOrder})`;
	if (includeSrid) {
		sql += `, ${srid}(x'${hex}')`;
	}
	const result = await dbi.tryQuery(sql);
	const row = result === false ? null : result.fetchRow();
	let wkt = row?.[0] ?? '';
	if (includeSrid) {
		wkt = `'${wkt}',${row?.[1] ?? ''}`;
	}
	return wkt;
}

export interface EditState {
	insertMode: boolean;
	whereClause: string | string[] | null;
	/** [key, clause] pairs in request order. */
	whereClauseArray: [string, string][];
	whereClauses: Map<string, string> | null;
	/** One result per where clause in edit mode, or the LIMIT 1 result of the table when inserting. */
	result: Map<string, DbiResult> | DbiResult;
	rows: [string, DbiRow | null | false][];
	foundUniqueKey: boolean;
	afterInsert: string | null;
}

function stringValues(array: PhpArray): [string, string][] {
	return phpEntries(array).map(([key, value]) => [key, typeof value === 'string' ? value : '']);
}

/** InsertEdit::determineInsertOrEdit(). */
export async function determineInsertOrEdit(context: PmaContext, post: PhpArray, get: PhpArray, initialWhereClause: PhpValue | null, db: string, table: string): Promise<EditState> {
	const { dbi, config, session } = context;
	let whereClause: PhpValue | null = initialWhereClause;
	let afterInsert: string | null = null;
	if (post.where_clause !== undefined) {
		whereClause = post.where_clause;
	}
	if (session.data.edit_next !== undefined) {
		whereClause = session.data.edit_next;
		delete session.data.edit_next;
		afterInsert = 'edit_next';
	}
	if (post.ShowFunctionFields !== undefined) {
		(config as Record<string, unknown>).ShowFunctionFields = post.ShowFunctionFields;
	}
	if (post.ShowFieldTypesInDataEditView !== undefined) {
		(config as Record<string, unknown>).ShowFieldTypesInDataEditView = post.ShowFieldTypesInDataEditView;
	}
	if (post.after_insert !== undefined) {
		afterInsert = phpScalar(post.after_insert) ?? null;
	}

	let state: EditState;
	if (whereClause !== null) {
		const whereClauseArray: [string, string][] = typeof whereClause === 'string' ? [['0', whereClause]] : stringValues(whereClause);
		const results = new Map<string, DbiResult>();
		const rows: [string, DbiRow | null][] = [];
		const whereClauses = new Map<string, string>();
		let foundUniqueKey = false;
		for (const [keyId, clause] of whereClauseArray) {
			const localQuery = `SELECT * FROM ${backquote(db)}.${backquote(table)} WHERE ${clause};`;
			const result = await dbi.query(localQuery);
			results.set(keyId, result);
			const row = result.fetchAssoc();
			rows.push([keyId, row]);
			whereClauses.set(keyId, clause.replaceAll('\\', '\\\\'));
			if (row === null) {
				context.response.addHTML(await getMessage(context, 'MySQL returned an empty result set (i.e. zero rows).', { sqlQuery: localQuery }));
				continue;
			}
			// Upstream passes the associative row, so every numeric lookup misses and each column reads as NULL.
			const meta = result.getFieldsMeta();
			const [uniqueCondition] = getUniqueCondition(meta, meta.map(() => null), { forceUnique: true, isView: () => false, escapeString });
			if (uniqueCondition !== '') {
				foundUniqueKey = true;
			}
		}
		state = {
			insertMode: false,
			whereClause: typeof whereClause === 'string' ? whereClause : whereClauseArray.map(([, clause]) => clause),
			whereClauseArray,
			whereClauses,
			result: results,
			rows,
			foundUniqueKey,
			afterInsert,
		};
	} else {
		const result = await dbi.query(`SELECT * FROM ${backquote(db)}.${backquote(table)} LIMIT 1;`);
		const rows: [string, false][] = [];
		for (let index = 0; index < Math.trunc(Number(config.InsertRows)); index++) {
			rows.push([String(index), false]);
		}
		state = { insertMode: true, whereClause: null, whereClauseArray: [], whereClauses: null, result, rows, foundUniqueKey: false, afterInsert };
	}

	const defaultAction = phpScalar(post.default_action) ?? phpScalar(get.default_action) ?? '';
	if (defaultAction === 'insert') {
		state.whereClause = null;
		state.whereClauses = null;
	}
	return state;
}

/** InsertEdit::showTypeOrFunction(). */
export function showTypeOrFunction(context: PmaContext, which: 'function' | 'type', urlParams: Record<string, unknown>, isShow: boolean, config: EditConfig): string {
	const url = context.urlState();
	const params = showTypeOrFunctionParams(which, urlParams, isShow, config, getFromRoute(url, '/sql'));
	const label = which === 'function' ? 'Function' : 'Type';
	const href = getFromRoute(url, '/table/change');
	// Url::getCommon($params, '', false) leaves the query unencoded for data-post.
	const dataPost = getCommon(url, params, '');
	if (!isShow) {
		return ` : <a href="${href}" data-post="${dataPost}">${label}</a>`;
	}
	return `<th><a href="${href}" data-post="${dataPost}" title="Hide">${label}</a></th>`;
}

export interface FormRowInput {
	urlParams: Record<string, unknown>;
	tableColumns: TableColumn[];
	commentsMap: Record<string, string>;
	timestampSeen: boolean;
	currentResult: DbiResult;
	jsvkey: string;
	vkey: string;
	insertMode: boolean;
	currentRow: DbiRow | null;
	isUpload: boolean;
	foreigners: Foreigners;
	table: string;
	db: string;
	rowId: number;
	whereClauseArray: [string, string][];
	defaultAction: string;
	/** Whether $_POST['where_clause'] is set, which the enum default selection reads. */
	postedWhereClause: boolean;
}

export interface FormRowState {
	/** $o_rows: rows rendered so far. */
	oRows: number;
	/** $tabindex, left at the last column's index. */
	tabindex: number;
}

interface ColumnInput {
	tableColumn: TableColumn;
	columnNumber: number;
	metaLength: number;
	defaultCharEditing: string;
	columnsCount: number;
}

/** PHP's date('Y-m-d H:i:s') in the oracle's UTC timezone. */
function phpDateNow(): string {
	return new Date().toISOString().slice(0, 19)
		.replace('T', ' ');
}

/** InsertEdit::getHtmlForInsertEditFormColumn(). */
async function getHtmlForInsertEditFormColumn(context: PmaContext, input: FormRowInput, columnInput: ColumnInput, rowState: FormRowState, config: EditConfig): Promise<string> {
	const { dbi } = context;
	const server = { isMariaDB: dbi.isMariaDB(), version: dbi.getVersion() };
	const readOnly = false;
	const column: AnalyzedColumn = analyzeTableColumnsArray(columnInput.tableColumn, input.commentsMap, input.timestampSeen);
	const fieldHashMd5 = column.Field_md5;
	const extractedColumnspec = extractColumnSpec(column.Type, config.LimitChars);
	if (column.len === -1) {
		column.len = columnInput.metaLength;
		if (column.len === -1) {
			column.len = 30;
		}
	}
	const changeClause = onChangeClause(fieldHashMd5, input.jsvkey, column.pma_type);
	const columnNameAppendix = `${input.vkey}[${fieldHashMd5}]`;
	if (column.Type === 'datetime' && column.Null !== 'YES' && column.Default === null && input.insertMode) {
		column.Default = phpDateNow();
	}
	const gisDataTypes = getGisDataTypes();

	let special: SpecialChars;
	if (input.currentRow !== null && Object.keys(input.currentRow).length > 0) {
		const value = input.currentRow[column.Field] ?? null;
		let wkt: string | null = null;
		if (value !== null && gisDataTypes.includes(column.True_Type)) {
			wkt = await convertToWellKnownText(context, value, true);
		}
		special = getSpecialCharsForExistingRow(value, column, columnNameAppendix, input.defaultAction, config, wkt);
	} else {
		special = getSpecialCharsForInsertingMode(column);
	}

	const idindex = (rowState.oRows * columnInput.columnsCount) + columnInput.columnNumber + 1;
	rowState.tabindex = idindex;
	const tabindex = idindex;
	const tabindexForValue = 0;

	const foreignData: ForeignData = await getForeignData(context, input.foreigners, column.Field, false, '', '');
	const isBinary = isColumnBinary(column, input.isUpload, config);
	let functionOptions = '';
	if (truthy(config.ShowFunctionFields)) {
		functionOptions = getFunctionsForField(column, input.insertMode, foreignData.foreign_field !== null, config, server);
	}
	const foreigner = foreignData.foreign_field === null ? null : foreignData.foreign_link;
	const nullifyCode = getNullifyCode(column, foreigner);
	const { type, decimals } = typeAndDecimals(column.pma_type);

	let columnValue = '';
	let foreignDropdownHtml = '';
	let textareaRows = config.TextareaRows;
	let textareaCols = config.TextareaCols;
	let maxlength = '';
	let enumSelectedValue = '';
	let setValues: { plain: string; html: string; }[] = [];
	let setSelectSize = 0;
	let isProtectedBlob = false;
	let blobValue = '';
	let blobValueUnit = '';
	let maxUploadSize = '';
	let inputFieldHtml = '';
	const dataType = getTypeClass(column.True_Type);
	const options = { columnNameAppendix, onChangeClause: changeClause, tabindex, tabindexForValue, idindex, readOnly };
	if (Array.isArray(foreignData.disp_row)) {
		foreignDropdownHtml = foreignDropdown(foreignData.disp_row, foreignData.foreign_field ?? '', foreignData.foreign_display, special.data, dropdownConfig(context), context.config.ForeignKeyMaxLimit);
	}
	if (column.is_char) {
		textareaRows = Math.max(config.CharTextareaRows, 7);
		textareaCols = config.CharTextareaCols;
		maxlength = extractedColumnspec.spec_in_brackets;
	} else if (config.LongtextDoubleTextarea && column.pma_type.includes('longtext')) {
		textareaRows = config.TextareaRows * 2;
		textareaCols = config.TextareaCols * 2;
	}

	if (column.pma_type === 'enum') {
		column.values ??= extractedColumnspec.enum_set_values.map((value) => {
			return { plain: value, html: htmlspecialchars(value) };
		});
		const data = special.data ?? '';
		for (const enumValue of column.values) {
			const isDefault = data === '' && (!input.postedWhereClause || column.Null !== 'YES') && column.Default !== null && looseEquals(enumValue.plain, column.Default);
			if (looseEquals(data, enumValue.plain) || isDefault) {
				enumSelectedValue = enumValue.plain;
				break;
			}
		}
	} else if (column.pma_type === 'set') {
		if (column.values === undefined) {
			column.values = extractedColumnspec.enum_set_values.map((value) => {
				return { plain: value, html: htmlspecialchars(value) };
			});
			column.select_size = Math.min(4, column.values.length);
		}
		setValues = column.values;
		setSelectSize = column.select_size ?? 0;
	} else if (column.is_binary || column.is_blob) {
		isProtectedBlob = (config.ProtectBinary === 'blob' && column.is_blob) || config.ProtectBinary === 'all' || (config.ProtectBinary === 'noblob' && !column.is_blob);
		if (isProtectedBlob && special.data !== null) {
			[blobValue, blobValueUnit] = protectedBlobSize(special.data);
		}
		if (input.isUpload && column.is_blob) {
			maxUploadSize = getMaxUploadSize(column.True_Type, MAX_UPLOAD_SIZE);
		}
		if (!isProtectedBlob && !(column.is_blob || column.len > config.LimitChars)) {
			inputFieldHtml = getHtmlInput(column, special.specialChars, Math.min(Math.max(column.len * 2, 4), config.LimitChars), 'HEX', options);
		}
	} else {
		columnValue = getValueColumnForOtherDatatypes({
			column,
			defaultCharEditing: columnInput.defaultCharEditing,
			backupField: special.backupField,
			specialChars: special.specialChars,
			specialCharsEncoded: special.specialCharsEncoded,
			data: special.data,
			specInBrackets: extractedColumnspec.spec_in_brackets,
		}, options, config);
	}

	return render(context, 'table/insert/column_row', {
		db: input.db,
		table: input.table,
		column,
		row_id: input.rowId,
		show_field_types_in_data_edit_view: config.ShowFieldTypesInDataEditView,
		show_function_fields: config.ShowFunctionFields,
		is_column_binary: isBinary,
		function_options: functionOptions,
		read_only: readOnly,
		nullify_code: nullifyCode,
		real_null_value: special.realNullValue,
		id_index: idindex,
		type,
		decimals,
		special_chars: special.specialChars,
		transformed_value: '',
		value: columnValue,
		is_value_foreign_link: foreignData.foreign_link,
		backup_field: special.backupField,
		data: special.data,
		gis_data_types: gisDataTypes,
		foreign_dropdown: foreignDropdownHtml,
		data_type: dataType,
		textarea_cols: textareaCols,
		textarea_rows: textareaRows,
		text_dir: 'ltr',
		max_length: maxlength,
		longtext_double_textarea: config.LongtextDoubleTextarea,
		enum_selected_value: enumSelectedValue,
		set_values: setValues,
		set_select_size: setSelectSize,
		is_column_protected_blob: isProtectedBlob,
		blob_value: blobValue,
		blob_value_unit: blobValueUnit,
		is_upload: input.isUpload,
		max_upload_size: maxUploadSize,
		select_option_for_upload: '',
		limit_chars: config.LimitChars,
		input_field_html: inputFieldHtml,
		tab_index: tabindex,
		tab_index_for_value: tabindexForValue,
	});
}

/** InsertEdit::getHtmlForInsertEditRow(). */
export async function getHtmlForInsertEditRow(context: PmaContext, input: FormRowInput, rowState: FormRowState, config: EditConfig): Promise<string> {
	let type = '';
	let func = '';
	if (truthy(config.ShowFieldTypesInDataEditView)) {
		type = showTypeOrFunction(context, 'type', input.urlParams, true, config);
	}
	if (truthy(config.ShowFunctionFields)) {
		func = showTypeOrFunction(context, 'function', input.urlParams, true, config);
	}
	let html = `${await render(context, 'table/insert/get_head_and_foot_of_insert_row_table', { type, function: func })}<tbody>`;
	const defaultCharEditing = config.CharEditing;
	const fieldsMeta = input.currentResult.getFieldsMeta();
	const columnsCount = input.tableColumns.length;
	const virtual = new Set(['VIRTUAL', 'PERSISTENT', 'VIRTUAL GENERATED', 'STORED GENERATED']);
	for (let columnNumber = 0; columnNumber < columnsCount; columnNumber++) {
		const tableColumn = input.tableColumns[columnNumber];
		if (virtual.has(tableColumn.Extra)) {
			continue;
		}
		html += await getHtmlForInsertEditFormColumn(context, input, {
			tableColumn,
			columnNumber,
			metaLength: fieldsMeta[columnNumber]?.length ?? -1,
			defaultCharEditing,
			columnsCount,
		}, rowState, config);
	}
	rowState.oRows++;
	return `${html}  </tbody></table></div><br><div class="clearfloat"></div>`;
}

/** Whether any column is a BLOB, which turns off AJAX submission of the form. */
export function hasBlobField(columns: TableColumn[]): boolean {
	return columns.some(column => isColumn(column, ['blob', 'tinyblob', 'mediumblob', 'longblob']));
}

/** InsertEdit::setSessionForEditNext(). */
export async function setSessionForEditNext(context: PmaContext, oneWhereClause: string): Promise<void> {
	const localQuery = `SELECT * FROM ${backquote(context.db)}.${backquote(context.table)} WHERE ${oneWhereClause.replaceAll('` =', '` >')} LIMIT 1;`;
	const result = await context.dbi.query(localQuery);
	const row = result.fetchRow() ?? [];
	const [uniqueCondition] = getUniqueCondition(result.getFieldsMeta(), row, { forceUnique: true, isView: () => false, escapeString });
	if (uniqueCondition !== '') {
		context.session.data.edit_next = uniqueCondition;
	}
}

/** The row count ReplaceController sends back after a grid edit. */
export async function countRows(context: PmaContext, table: string, db: string): Promise<number | false> {
	return Table.get(context, table, db).countRecords();
}

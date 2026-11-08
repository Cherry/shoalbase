// Pure parts of PhpMyAdmin\Display\Results: display parts, sort links, unique conditions and the small cell templates.
import { getImage } from '../../twig/html.ts';
import { htmlspecialchars, phpString } from '../../twig/php.ts';
import { backquote } from '../../twig/sanitize.ts';
import { type FieldMetadata, FieldType } from '../field-metadata.ts';
import { type LinkState, linkOrButton } from '../generator.ts';
import { Message } from '../message.ts';
import { phpToInt } from '../sprintf.ts';

import type { QuerySettings, SessionTmpval } from '../session.ts';

export const NO_EDIT_OR_DELETE = 'nn';
export const UPDATE_ROW = 'ur';
export const DELETE_ROW = 'dr';
export const KILL_PROCESS = 'kp';

export const POSITION_LEFT = 'left';
export const POSITION_RIGHT = 'right';
export const POSITION_BOTH = 'both';
export const POSITION_NONE = 'none';

export const DISPLAY_FULL_TEXT = 'F';
export const DISPLAY_PARTIAL_TEXT = 'P';
export const RELATIONAL_KEY = 'K';
export const RELATIONAL_DISPLAY_COLUMN = 'D';
export const GEOMETRY_DISP_GEOM = 'GEOM';
export const GEOMETRY_DISP_WKT = 'WKT';
export const GEOMETRY_DISP_WKB = 'WKB';
export const ALL_ROWS = 'all';

/** $displayParts: which links and blocks a results table shows; null links count as "not NO_EDIT_OR_DELETE". */
export interface DisplayParts {
	edit_lnk: string | null;
	del_lnk: string | null;
	sort_lnk: string;
	nav_bar: string;
	bkm_form: string;
	text_btn: string;
	pview_lnk: string;
}

/** The $_SESSION['tmpval'] display settings once setConfigParamsForDisplayTable() ran. */
export interface DisplaySettings {
	pftext: string;
	relational_display: string;
	geoOption: string;
	display_binary: boolean;
	display_blob: boolean;
	hide_transformation: boolean;
	pos: number;
	max_rows: number | 'all';
	repeat_cells: number;
}

const SHOW_PATTERN = /^SHOW[\t\n\v\f\r ]+(VARIABLES|(FULL[\t\n\v\f\r ]+)?PROCESSLIST|STATUS|TABLE|GRANTS|CREATE|LOGS|DATABASES|FIELDS)/i;

/** setDisplayPartsForPrintView(). */
export function displayPartsForPrintView(parts: DisplayParts): DisplayParts {
	return { ...parts, edit_lnk: NO_EDIT_OR_DELETE, del_lnk: NO_EDIT_OR_DELETE, sort_lnk: '0', nav_bar: '0', bkm_form: '0', text_btn: '0', pview_lnk: '0' };
}

/** Whether a SHOW statement lists processes, which gives its rows Kill links. */
export function isShowProcessList(sqlQuery: string): boolean {
	const which = SHOW_PATTERN.exec(sqlQuery);
	return which !== null && ` ${which[1].toUpperCase()}`.indexOf('PROCESSLIST') > 0;
}

/** setDisplayPartsForShow(). */
export function displayPartsForShow(parts: DisplayParts, sqlQuery: string): DisplayParts {
	return {
		...parts,
		edit_lnk: NO_EDIT_OR_DELETE,
		del_lnk: isShowProcessList(sqlQuery) ? KILL_PROCESS : NO_EDIT_OR_DELETE,
		sort_lnk: '0',
		nav_bar: '0',
		bkm_form: '1',
		text_btn: '1',
		pview_lnk: '1',
	};
}

/** setDisplayPartsForNonData(): COUNT, maintenance, EXPLAIN and PROCEDURE ANALYSE results. */
export function displayPartsForNonData(parts: DisplayParts, isMaint: boolean): DisplayParts {
	return {
		...parts,
		edit_lnk: NO_EDIT_OR_DELETE,
		del_lnk: NO_EDIT_OR_DELETE,
		sort_lnk: '0',
		nav_bar: '0',
		bkm_form: '1',
		text_btn: isMaint ? '1' : '0',
		pview_lnk: '1',
	};
}

/** setDisplayPartsForSelect(): row links only when every column comes from one table. */
export function displayPartsForSelect(parts: DisplayParts, fieldsMeta: FieldMetadata[]): DisplayParts {
	const result = { ...parts, text_btn: '1' };
	let previousTable = '';
	for (const meta of fieldsMeta) {
		const isLink = result.edit_lnk !== NO_EDIT_OR_DELETE || result.del_lnk !== NO_EDIT_OR_DELETE || result.sort_lnk !== '0';
		if (isLink && previousTable !== '' && meta.table !== '' && meta.table !== previousTable) {
			result.edit_lnk = NO_EDIT_OR_DELETE;
			result.del_lnk = NO_EDIT_OR_DELETE;
			break;
		}
		result.pview_lnk = '1';
		if (meta.table !== '') {
			previousTable = meta.table;
		}
	}
	if (previousTable === '') {
		result.edit_lnk = NO_EDIT_OR_DELETE;
		result.del_lnk = NO_EDIT_OR_DELETE;
	}
	return result;
}

/** Results::getPartialText(): cuts to LimitChars in partial text mode; returns [truncated, text, original length]. */
export function getPartialText(str: string, limitChars: number, pftext: string): [boolean, string, number] {
	const characters = [...str];
	if (characters.length > limitChars && pftext === DISPLAY_PARTIAL_TEXT) {
		return [true, `${characters.slice(0, Math.trunc(limitChars)).join('')}...`, characters.length];
	}
	return [false, str, characters.length];
}

/** Core::mimeDefaultFunction(). */
export function mimeDefaultFunction(buffer: string): string {
	return htmlspecialchars(buffer).replaceAll('  ', ' &nbsp;').replaceAll(/\r\n|\r|\n/g, '<br>\n');
}

/** Util::printableBitValue(): (int) of the value in binary, left padded to the column length. */
export function printableBitValue(value: string, length: number): string {
	const match = /^\s*\d+/.exec(value);
	const digits = match === null ? '0' : match[0].trim();
	return BigInt(digits).toString(2).padStart(length, '0');
}

/** Results::getClassForDateTimeRelatedFields(). */
export function classForDateTimeRelatedFields(meta: FieldMetadata): string {
	if (meta.isMappedTypeTimestamp || meta.isType(FieldType.DATETIME)) {
		return 'datetimefield';
	}
	if (meta.isType(FieldType.DATE)) {
		return 'datefield';
	}
	if (meta.isType(FieldType.TIME)) {
		return 'timefield';
	}
	if (meta.isType(FieldType.STRING)) {
		return 'text';
	}
	return '';
}

/** Results::isColumnNumeric(). */
export function isColumnNumeric(meta: FieldMetadata): boolean {
	return meta.isType(FieldType.REAL) || meta.isMappedTypeBit || meta.isType(FieldType.INT);
}

/** Results::addClass(); without pmadb no column has an input transformation. */
export function addClass(classes: string, conditionField: boolean, meta: FieldMetadata, nowrap: string, isFieldTruncated = false, hasTransformationPlugin = false): string {
	const list = [classes, nowrap].filter(item => item !== '' && item !== '0');
	if (meta.internalMediaType !== null) {
		list.push(meta.internalMediaType.replaceAll('/', '_'));
	}
	if (conditionField) {
		list.push('condition');
	}
	if (isFieldTruncated) {
		list.push('truncated');
	}
	if (hasTransformationPlugin) {
		list.push('transformed');
	}
	if (meta.isEnum) {
		list.push('enum');
	}
	if (meta.isSet) {
		list.push('set');
	}
	if (meta.isMappedTypeBit) {
		list.push('bit');
	}
	if (meta.isBinary) {
		list.push('hex');
	}
	return list.join(' ');
}

/** display/results/value_display.twig. */
export function valueDisplay(classes: string, conditionField: boolean, value: string): string {
	return `<td class="text-start ${htmlspecialchars(classes)}${conditionField ? ' condition' : ''}">${value}</td>\n`;
}

/** display/results/null_display.twig. */
export function nullDisplay(classes: string, conditionField: boolean, meta: FieldMetadata): string {
	const tdClass = addClass(classes, conditionField, meta, '');
	return `<td data-decimals="${meta.decimals}"\n    data-type="${meta.getMappedType()}"\n        class="${htmlspecialchars(tdClass)} null">\n    <em>NULL</em>\n</td>\n`;
}

/** display/results/empty_display.twig. */
export function emptyDisplay(classes: string, conditionField: boolean, meta: FieldMetadata): string {
	return `<td class="${htmlspecialchars(addClass(classes, conditionField, meta, 'text-nowrap'))}"></td>\n`;
}

/** display/results/row_data.twig. */
export function rowData(value: string, tdClass: string, meta: FieldMetadata, originalLength: string): string {
	const length = originalLength === '' ? '' : ` data-originallength="${htmlspecialchars(originalLength)}"`;
	return `<td data-decimals="${meta.decimals}" data-type="${meta.getMappedType()}"${length} class="${htmlspecialchars(tdClass)}">${value}</td>\n`;
}

export interface RowLink {
	url: string | null;
	params: Record<string, unknown> | null;
	string: string | null;
}

export interface CheckboxAndLinks {
	position: string;
	hasCheckbox: boolean;
	edit: RowLink & { clauseIsUnique: boolean; };
	copy: RowLink;
	delete: RowLink;
	rowNumber: number;
	whereClause: string;
	/** json_encode() of the condition array. */
	condition: string;
	isAjax: boolean;
	jsConf: string;
}

function checkboxCell(input: CheckboxAndLinks, side: string): string {
	if (!input.hasCheckbox) {
		return '';
	}
	return `    <td class="text-center d-print-none">
      <input type="checkbox" class="multi_checkbox checkall" id="id_rows_to_delete${input.rowNumber}_${side}" name="rows_to_delete[${input.rowNumber}]" value="${htmlspecialchars(input.whereClause)}">
      <input type="hidden" class="condition_array" value="${htmlspecialchars(input.condition)}">
    </td>
  `;
}

// The cell around one row link, with the hidden extra that follows the link when there is one.
function linkCell(tdClass: string, link: string, extra: string): string {
	const extraHtml = extra === '' ? '' : `          ${extra}\n        `;
	return `    <td class="${tdClass}">
      <span class="text-nowrap">
        ${link}
        ${extraHtml}      </span>
    </td>
  `;
}

function whereClauseInput(whereClause: string): string {
	if (whereClause === '') {
		return '';
	}
	return `<input type="hidden" class="where_clause" value="${htmlspecialchars(whereClause)}">`;
}

function editCell(state: LinkState, input: CheckboxAndLinks): string {
	if (input.edit.url === null || input.edit.url === '') {
		return '';
	}
	const link = linkOrButton(state, input.edit.url, input.edit.params, phpString(input.edit.string));
	return linkCell(`text-center d-print-none edit_row_anchor${input.edit.clauseIsUnique ? '' : ' nonunique'}`, link, whereClauseInput(input.whereClause));
}

function copyCell(state: LinkState, input: CheckboxAndLinks): string {
	if (input.copy.url === null || input.copy.url === '') {
		return '';
	}
	const link = linkOrButton(state, input.copy.url, input.copy.params, phpString(input.copy.string));
	return linkCell('text-center d-print-none', link, whereClauseInput(input.whereClause));
}

function deleteCell(state: LinkState, input: CheckboxAndLinks): string {
	if (input.delete.url === null || input.delete.url === '') {
		return '';
	}
	const link = linkOrButton(state, input.delete.url, input.delete.params, phpString(input.delete.string), { class: 'delete_row requireConfirm ajax' });
	const jsConf = input.jsConf === '' ? '' : `<div class="hide">${htmlspecialchars(input.jsConf)}</div>`;
	return linkCell(`text-center d-print-none${input.isAjax ? ' ajax' : ''}`, link, jsConf);
}

/** display/results/checkbox_and_links.twig. */
export function checkboxAndLinks(state: LinkState, input: CheckboxAndLinks): string {
	if (input.position === POSITION_LEFT) {
		return `  ${checkboxCell(input, 'left')}\n  ${editCell(state, input)}\n  ${copyCell(state, input)}\n  ${deleteCell(state, input)}`;
	}
	if (input.position === POSITION_RIGHT) {
		return `  ${deleteCell(state, input)}\n  ${copyCell(state, input)}\n  ${editCell(state, input)}\n  ${checkboxCell(input, 'right')}`;
	}
	return `  ${checkboxCell(input, 'left')}`;
}

/** display/results/comment_for_row.twig. */
export function commentForRow(commentsMap: Record<string, Record<string, string>>, columnName: string, tableName: string, limitChars: number): string {
	const comment = commentsMap[tableName]?.[columnName];
	if (comment === undefined) {
		return '';
	}
	const characters = [...comment];
	let shown = htmlspecialchars(comment);
	if (characters.length > limitChars) {
		shown = `${htmlspecialchars(characters.slice(0, limitChars).join(''))}…`;
	}
	return `    <br><span class="tblcomment" title="${htmlspecialchars(comment)}">\n                    ${shown}\n            </span>\n`;
}

export interface HeaderColumn {
	column_name: string;
	order_link?: string;
	comments: string;
	is_browse_pointer_enabled?: boolean;
	is_browse_marker_enabled?: boolean;
	is_column_hidden: boolean;
	is_column_numeric: boolean;
	has_condition?: boolean;
}

/** display/results/table_headers_for_columns.twig. */
export function tableHeadersForColumns(isSortable: boolean, columns: HeaderColumn[]): string {
	let html = '';
	for (const column of columns) {
		let classes = 'draggable position-sticky';
		classes += column.is_column_numeric ? ' text-end' : '';
		classes += column.is_column_hidden ? ' hide' : '';
		classes += isSortable ? ' column_heading' : '';
		classes += isSortable && column.is_browse_marker_enabled ? ' marker' : '';
		classes += isSortable && column.is_browse_pointer_enabled ? ' pointer' : '';
		classes += !isSortable && column.has_condition ? ' condition' : '';
		const content = isSortable ? column.order_link ?? '' : htmlspecialchars(column.column_name);
		html += `  <th class="${classes}" data-column="${htmlspecialchars(column.column_name)}">\n          ${content}\n        ${column.comments}\n  </th>\n`;
	}
	return html;
}

/** Results::getRepeatingHeaders(). */
export function repeatingHeaders(emptyBefore: number, descriptions: string[], emptyAfter: number, rowActionLinks: string): string {
	let html = '<tr class="repeating_header_row">\n';
	if (emptyBefore > 0) {
		html += `    <th colspan="${emptyBefore}">\n        &nbsp;</th>\n`;
	} else if (rowActionLinks === POSITION_NONE) {
		html += '    <th></th>\n';
	}
	html += descriptions.join('');
	if (emptyAfter > 0) {
		html += `    <th colspan="${emptyAfter}">\n        &nbsp;</th>\n`;
	}
	return `${html}</tr>\n`;
}

/** Results::getSortingUrlParams(): the reversed direction to link to and the arrow images. */
export function sortingUrlParams(sortDirection: string, sortOrder: string): [string, string] {
	if (sortDirection.trim().toUpperCase() === 'DESC') {
		const image = ` ${getImage('s_desc', 'Descending', { class: 'soimg', title: '' })} ${getImage('s_asc', 'Ascending', { class: 'soimg hide', title: '' })}`;
		return [`${sortOrder}ASC`, image];
	}
	const image = ` ${getImage('s_asc', 'Ascending', { class: 'soimg', title: '' })} ${getImage('s_desc', 'Descending', { class: 'soimg hide', title: '' })}`;
	return [`${sortOrder}DESC`, image];
}

/** Results::isInSorted(). */
export function isInSorted(sortExpression: string[], sortExpressionNoDirection: string[], sortTable: string, nameToUseInSort: string): boolean {
	let indexInExpression = 0;
	for (const [index, clause] of sortExpressionNoDirection.entries()) {
		let clause2: string;
		if (clause.includes('.')) {
			const fragments = clause.split('.');
			clause2 = `${fragments[0]}.${fragments[1].replaceAll('`', '')}`;
		} else {
			clause2 = sortTable + clause.replaceAll('`', '');
		}
		if (clause2 === sortTable + nameToUseInSort) {
			indexInExpression = index;
			break;
		}
	}
	const expression = sortExpression[indexInExpression];
	if ([undefined, '', '0'].includes(expression)) {
		return false;
	}
	const noDirection = sortExpressionNoDirection[indexInExpression];
	const noSortTable = sortTable === '' || !noDirection.includes(sortTable);
	const noOpenParenthesis = !noDirection.includes('(');
	let newSortExpressionNoDirection = noDirection;
	if (sortTable !== '' && noSortTable && noOpenParenthesis) {
		newSortExpressionNoDirection = sortTable + noDirection;
	}
	const sortName = sortTable.replaceAll('`', '') + nameToUseInSort.replaceAll('`', '');
	return sortName === newSortExpressionNoDirection.replaceAll('`', '') || sortName === noDirection.replaceAll('`', '');
}

/** Results::getSingleAndMultiSortUrls(): [single sort ORDER BY, multi sort ORDER BY, arrow images]. */
export function singleAndMultiSortUrls(
	sortExpression: string[],
	sortExpressionNoDirectionInput: string[],
	sortTable: string,
	currentName: string,
	sortDirectionInput: string[],
	meta: FieldMetadata,
	configOrder: string,
): [string, string, string] {
	const sortExpressionNoDirection = [...sortExpressionNoDirectionInput];
	const sortDirection = [...sortDirectionInput];
	const isInSort = isInSorted(sortExpression, sortExpressionNoDirection, sortTable, currentName);
	if (sortExpressionNoDirection[0] === '' || !isInSort) {
		const specialIndex = sortExpressionNoDirection[0] === '' ? 0 : sortExpressionNoDirection.length;
		sortExpressionNoDirection[specialIndex] = backquote(currentName);
		sortDirection[specialIndex] = configOrder;
		if (configOrder === 'SMART') {
			const isTimeOrDate = meta.isType(FieldType.TIME) || meta.isType(FieldType.DATE) || meta.isType(FieldType.DATETIME) || meta.isType(FieldType.TIMESTAMP);
			sortDirection[specialIndex] = isTimeOrDate ? 'DESC' : 'ASC';
		}
	}

	let singleSortOrder = '';
	let orderImg = '';
	const sortOrderColumns: string[] = [];
	for (const [index, expression] of sortExpressionNoDirection.entries()) {
		// array_filter() drops empty and "0" expressions but keeps the indexes.
		if (expression === '' || expression === '0') {
			continue;
		}
		let nameToUseInSort = expression;
		let sortTableNew = sortTable;
		if (nameToUseInSort.includes('.') && !nameToUseInSort.includes('(')) {
			const matches = nameToUseInSort.split('.');
			nameToUseInSort = matches[1];
			sortTableNew = matches[0];
		}
		nameToUseInSort = nameToUseInSort.replaceAll(' )', ')').replaceAll('``', '`').replaceAll(/^`+|`+$/g, '');
		let sortOrder = index === 0 ? '\nORDER BY ' : '';
		if (nameToUseInSort.includes('(')) {
			sortOrder += nameToUseInSort;
		} else {
			if (sortTableNew !== '' && !sortTableNew.endsWith('.')) {
				sortTableNew += '.';
			}
			sortOrder += sortTableNew + backquote(nameToUseInSort);
		}
		if (currentName === nameToUseInSort) {
			singleSortOrder = '\nORDER BY ';
			if (!currentName.includes('(')) {
				singleSortOrder += sortTable;
			}
			singleSortOrder += `${backquote(currentName)} `;
			if (isInSort) {
				[singleSortOrder, orderImg] = sortingUrlParams(sortDirection[index], singleSortOrder);
			} else {
				singleSortOrder += sortDirection[index].toUpperCase();
			}
		}
		sortOrder += ' ';
		if (currentName === nameToUseInSort && isInSort) {
			[sortOrder, orderImg] = sortingUrlParams(sortDirection[index], sortOrder);
			orderImg += ` <small>${index + 1}</small>`;
		} else {
			sortOrder += sortDirection[index].toUpperCase();
		}
		sortOrderColumns.push(sortOrder);
	}
	return [singleSortOrder, sortOrderColumns.join(', '), orderImg];
}

export interface SortByKeyOption {
	value: string;
	content: string;
	is_selected: boolean;
}

/** The option list of Results::getSortByKeyDropDown() for indexes given as [name, column names]. */
export function sortByKeyOptions(indexes: [string, string[]][], sortExpression: string[], unsortedSqlQuery: string): SortByKeyOption[] {
	const localOrder = sortExpression.join(', ');
	let isIndexUsed = false;
	const options: SortByKeyOption[] = [];
	// PCRE's [[:space:]] before the trailing clause, matched greedily from the end like /(.*)(...)/is.
	const tail = /^([\s\S]*)([\t\n\v\f\r ](LIMIT ([\s\S]*)|PROCEDURE ([\s\S]*)|FOR UPDATE|LOCK IN SHARE MODE))/i.exec(unsortedSqlQuery);
	let firstPart = unsortedSqlQuery;
	let secondPart = '';
	if (tail !== null) {
		firstPart = tail[1];
		secondPart = tail[2];
	}
	for (const [name, columns] of indexes) {
		const ascSort = `\`${columns.join('` ASC, `')}\` ASC`;
		const descSort = `\`${columns.join('` DESC, `')}\` DESC`;
		isIndexUsed ||= localOrder === ascSort || localOrder === descSort;
		options.push(
			{ value: `${firstPart} ORDER BY ${ascSort}${secondPart}`, content: `${name} (ASC)`, is_selected: localOrder === ascSort },
			{ value: `${firstPart} ORDER BY ${descSort}${secondPart}`, content: `${name} (DESC)`, is_selected: localOrder === descSort },
		);
	}
	options.push({ value: unsortedSqlQuery, content: 'None', is_selected: !isIndexUsed });
	return options;
}

/** PHP's is_numeric() for request strings. */
function isNumeric(value: unknown): boolean {
	return typeof value === 'string' && /^[\t\n\v\f\r ]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?[\t\n\v\f\r ]*$/i.test(value);
}

/** PHP's empty() for the stored settings. */
function isEmptyValue(value: unknown): boolean {
	return ([undefined, null, '', '0', 0, false] as unknown[]).includes(value);
}

export interface DisplayRequest {
	/** $_GET['session_max_rows'] ?? $_POST['session_max_rows']. */
	sessionMaxRows: unknown;
	/** $_REQUEST values. */
	request: Record<string, unknown>;
}

/** Whether setConfigParamsForDisplayTable() takes session_max_rows, after which it unsets it from $_GET and $_POST. */
export function isSessionMaxRowsUsed(sessionMaxRows: unknown): boolean {
	return isNumeric(sessionMaxRows) || sessionMaxRows === ALL_ROWS;
}

/** Results::setConfigParamsForDisplayTable() for one query's stored settings: the new settings to remember. */
export function querySettingsForDisplay(
	stored: QuerySettings | undefined,
	input: DisplayRequest,
	config: { RepeatCells: number; MaxRows: number; RelationalDisplay: string; },
	isExplain: boolean,
): QuerySettings {
	const query: QuerySettings = { ...stored };
	const { request } = input;
	if (isEmptyValue(query.repeat_cells)) {
		query.repeat_cells = config.RepeatCells;
	}
	const sessionMaxRows = input.sessionMaxRows ?? '';
	if (isNumeric(sessionMaxRows)) {
		query.max_rows = phpToInt(sessionMaxRows);
	} else if (sessionMaxRows === ALL_ROWS) {
		query.max_rows = ALL_ROWS;
	} else if (isEmptyValue(query.max_rows)) {
		query.max_rows = Math.trunc(config.MaxRows);
	}
	if (isNumeric(request.pos)) {
		query.pos = phpToInt(request.pos);
	} else if (isEmptyValue(query.pos)) {
		query.pos = 0;
	}
	const pftext = request.pftext;
	if (pftext === DISPLAY_PARTIAL_TEXT || pftext === DISPLAY_FULL_TEXT) {
		query.pftext = pftext;
	} else if (isExplain) {
		query.pftext = DISPLAY_FULL_TEXT;
	} else if (isEmptyValue(query.pftext)) {
		query.pftext = DISPLAY_PARTIAL_TEXT;
	}
	const relational = request.relational_display;
	if (relational === RELATIONAL_KEY || relational === RELATIONAL_DISPLAY_COLUMN) {
		query.relational_display = relational;
	} else if (isEmptyValue(query.relational_display)) {
		query.relational_display = config.RelationalDisplay;
	}
	const geoOption = request.geoOption;
	if (typeof geoOption === 'string' && [GEOMETRY_DISP_WKT, GEOMETRY_DISP_WKB, GEOMETRY_DISP_GEOM].includes(geoOption)) {
		query.geoOption = geoOption;
	} else if (isEmptyValue(query.geoOption)) {
		query.geoOption = GEOMETRY_DISP_GEOM;
	}
	const isOptionsForm = request.display_options_form !== undefined;
	if (request.display_binary !== undefined) {
		query.display_binary = true;
	} else if (isOptionsForm) {
		delete query.display_binary;
	} else if (request.full_text_button === undefined) {
		query.display_binary = true;
	}
	for (const key of ['display_blob', 'hide_transformation'] as const) {
		if (request[key] !== undefined) {
			query[key] = true;
		} else if (isOptionsForm) {
			delete query[key];
		}
	}
	return query;
}

/** The $_SESSION['tmpval'] keys setConfigParamsForDisplayTable() fills from a query's settings. */
export function applyDisplaySettings(tmpval: SessionTmpval, query: QuerySettings): void {
	tmpval.pftext = query.pftext;
	tmpval.relational_display = query.relational_display;
	tmpval.geoOption = query.geoOption;
	tmpval.display_binary = query.display_binary !== undefined;
	tmpval.display_blob = query.display_blob !== undefined;
	tmpval.hide_transformation = query.hide_transformation !== undefined;
	tmpval.pos = query.pos;
	tmpval.max_rows = query.max_rows;
	tmpval.repeat_cells = query.repeat_cells;
}

/** Results::getOffsets(): [next page position, previous page position]. */
export function pageOffsets(pos: number, maxRows: number | 'all'): [number, number] {
	if (maxRows === ALL_ROWS) {
		return [0, 0];
	}
	return [pos + maxRows, Math.max(0, pos - maxRows)];
}

export interface UniqueConditionOptions {
	forceUnique?: boolean;
	/** The table the condition is restricted to, or false for none. */
	restrictToTable?: string | false;
	/** [alias, column] pairs of the SELECT expressions. */
	expressions?: { alias: string | null; column: string | null; }[];
	/** Whether a result table name is a view, so its own name is kept. */
	isView: (table: string) => boolean;
	escapeString: (value: string) => string;
}

/** bin2hex() of a byte string (one char per byte). */
export function bin2hex(value: string): string {
	let hex = '';
	for (let index = 0; index < value.length; index++) {
		hex += (value.codePointAt(index) as number & 0xFF).toString(16).padStart(2, '0');
	}
	return hex;
}

/** mb_strlen() in UTF-8 of a byte string: valid sequences count once, stray bytes count one each. */
export function utf8Length(bytes: string): number {
	let count = 0;
	let index = 0;
	while (index < bytes.length) {
		const byte = bytes.codePointAt(index) as number;
		let size = 1;
		if (byte >= 0xC2 && byte <= 0xDF) {
			size = 2;
		} else if (byte >= 0xE0 && byte <= 0xEF) {
			size = 3;
		} else if (byte >= 0xF0 && byte <= 0xF4) {
			size = 4;
		}
		let valid = index + size <= bytes.length;
		for (let next = 1; valid && next < size; next++) {
			const continuation = bytes.codePointAt(index + next) as number;
			valid = continuation >= 0x80 && continuation <= 0xBF;
		}
		index += valid ? size : 1;
		count++;
	}
	return count;
}

/** Util::getConditionValue(): [value, condition]; a null value leaves the column out. */
function conditionValue(row: string | null, meta: FieldMetadata, fieldsCount: number, conditionKey: string, condition: string, escape: (value: string) => string): [string | null, string] {
	if (row === null) {
		return ['IS NULL', condition];
	}
	if (meta.isNumeric) {
		return [`= ${row}`, condition];
	}
	const isBinaryString = meta.isType(FieldType.STRING) && meta.isBinary;
	const isBlobAndIsBinaryCharset = meta.isType(FieldType.BLOB) && meta.charsetnr === 63;
	const notEmpty = row !== '' && row !== '0';
	if (isBlobAndIsBinaryCharset || (notEmpty && isBinaryString)) {
		// mb_strlen() of a byte string counts the bytes that are not part of a valid UTF-8 sequence one by one.
		const rowLength = utf8Length(row);
		if (rowLength > 0 && rowLength < 1000) {
			return [`= CAST(0x${bin2hex(row)} AS BINARY)`, condition];
		}
		if (fieldsCount === 1) {
			return [` = ${rowLength}`, ` CHAR_LENGTH(${conditionKey}) `];
		}
		return [null, condition];
	}
	if (meta.isMappedTypeGeometry && notEmpty) {
		if (utf8Length(row) < 5000) {
			return ['', `${condition}= CAST(0x${bin2hex(row)} AS BINARY)`];
		}
		return ['', ''];
	}
	if (meta.isMappedTypeBit) {
		return [`= b'${printableBitValue(row, meta.length)}'`, condition];
	}
	return [`= '${escape(row)}'`, condition];
}

/** Util::getUniqueCondition(): [where clause, whether it is unique, condition array]. Mutates meta like upstream. */
export function getUniqueCondition(fieldsMeta: FieldMetadata[], row: (string | null)[], options: UniqueConditionOptions): [string, boolean, Record<string, string>] {
	const { forceUnique = false, restrictToTable = false, expressions = [] } = options;
	let primaryKey = '';
	let uniqueKey = '';
	let nonPrimaryCondition = '';
	const primaryKeyArray: Record<string, string> = {};
	const uniqueKeyArray: Record<string, string> = {};
	const nonPrimaryConditionArray: Record<string, string> = {};
	for (const [index, meta] of fieldsMeta.entries()) {
		if (meta.orgname === '') {
			meta.orgname = meta.name;
			for (const expression of expressions) {
				if (expression.alias === null || expression.alias === '' || expression.column === null || expression.column === '') {
					continue;
				}
				if (meta.name.toLowerCase() === expression.alias.toLowerCase()) {
					meta.orgname = expression.column;
					break;
				}
			}
		}
		if (meta.table !== meta.orgtable && !options.isView(meta.table)) {
			meta.table = meta.orgtable;
		}
		if (restrictToTable !== false && restrictToTable !== '' && restrictToTable !== meta.table) {
			continue;
		}
		let conKey = `${backquote(meta.table)}.${backquote(meta.orgname)}`;
		if (meta.isType(FieldType.REAL)) {
			conKey = `CONCAT(${conKey})`;
		}
		const [value, condition] = conditionValue(row[index] ?? null, meta, fieldsMeta.length, conKey, ` ${conKey} `, options.escapeString);
		if (value === null) {
			continue;
		}
		const fullCondition = `${condition}${value} AND`;
		if (meta.isPrimaryKey) {
			primaryKey += fullCondition;
			primaryKeyArray[conKey] = value;
		} else if (meta.isUniqueKey) {
			uniqueKey += fullCondition;
			uniqueKeyArray[conKey] = value;
		}
		nonPrimaryCondition += fullCondition;
		nonPrimaryConditionArray[conKey] = value;
	}
	let preferred = '';
	let conditionArray: Record<string, string> = {};
	let clauseIsUnique = true;
	if (primaryKey !== '') {
		preferred = primaryKey;
		conditionArray = primaryKeyArray;
	} else if (uniqueKey !== '') {
		preferred = uniqueKey;
		conditionArray = uniqueKeyArray;
	} else if (!forceUnique) {
		preferred = nonPrimaryCondition;
		conditionArray = nonPrimaryConditionArray;
		clauseIsUnique = false;
	}
	const whereClause = preferred.replace(/\s?AND$/, '').replaceAll(/^[\t\n\v\r\0 ]+|[\t\n\v\r\0 ]+$/g, '');
	return [whereClause, clauseIsUnique, conditionArray];
}

export interface PositionMessageInput {
	limit: { offset: number; rowCount: number; } | null;
	maxRows: number | 'all';
	pos: number;
	posNext: number;
	total: number;
	unlimNumRows: number | string | false;
	numRows: number;
	/** The "This view has at least this number of rows" hint, or false. */
	viewWarning: string | false;
	preCount: string;
	afterCount: string;
	queryTime: number;
	sortedColumnMessage: string;
}

/** Results::setMessageInformation(): "Showing rows x - y (n total, Query took t seconds.)". */
export function positionMessage(input: PositionMessageInput): Message {
	let firstShownRec: number;
	let lastShownRec: number;
	if (input.limit !== null) {
		firstShownRec = input.limit.offset;
		const rowCount = input.limit.rowCount;
		lastShownRec = firstShownRec + Math.min(rowCount, input.total) - 1;
	} else if (input.maxRows === ALL_ROWS || input.posNext > input.total) {
		firstShownRec = input.pos;
		lastShownRec = firstShownRec + input.numRows - 1;
	} else {
		firstShownRec = input.pos;
		lastShownRec = input.posNext - 1;
	}
	const message = Message.success('Showing rows %1s - %2s');
	message.addParam(firstShownRec);
	if (input.viewWarning === false) {
		message.addParam(lastShownRec);
	} else {
		message.addParamHtml(`... ${input.viewWarning}`);
	}
	message.addText('(');
	if (input.viewWarning === false) {
		let total: Message;
		// PHP's loose != between the counted total and the unlimited row count.
		if (Number(input.unlimNumRows) === input.total) {
			total = Message.notice(`${input.preCount}%d total`);
			total.addParam(input.total);
		} else {
			total = Message.notice(`${input.preCount}%1$d total, %2$d in query`);
			total.addParam(input.total);
			total.addParam(Number(input.unlimNumRows));
		}
		if (input.afterCount !== '') {
			total.addHtml(input.afterCount);
		}
		message.addMessage(total, '');
		message.addText(', ', '');
	}
	const time = Message.notice('Query took %01.4f seconds.)');
	time.addParam(input.queryTime);
	message.addMessage(time, '');
	message.addHtml(input.sortedColumnMessage, '');
	return message;
}

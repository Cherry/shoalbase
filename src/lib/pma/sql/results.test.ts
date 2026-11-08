import { describe, expect, it } from 'vitest';

import { FieldMetadata, MysqlFlag, MysqlType } from '../field-metadata.ts';
import {
	ALL_ROWS,
	type CheckboxAndLinks,
	DELETE_ROW,
	type DisplayParts,
	KILL_PROCESS,
	NO_EDIT_OR_DELETE,
	POSITION_LEFT,
	POSITION_NONE,
	POSITION_RIGHT,
	type PositionMessageInput,
	UPDATE_ROW,
	addClass,
	applyDisplaySettings,
	bin2hex,
	checkboxAndLinks,
	classForDateTimeRelatedFields,
	commentForRow,
	displayPartsForNonData,
	displayPartsForPrintView,
	displayPartsForSelect,
	displayPartsForShow,
	emptyDisplay,
	getPartialText,
	getUniqueCondition,
	isColumnNumeric,
	isInSorted,
	isSessionMaxRowsUsed,
	isShowProcessList,
	mimeDefaultFunction,
	nullDisplay,
	pageOffsets,
	positionMessage,
	printableBitValue,
	querySettingsForDisplay,
	repeatingHeaders,
	rowData,
	singleAndMultiSortUrls,
	sortByKeyOptions,
	sortingUrlParams,
	tableHeadersForColumns,
	utf8Length,
	valueDisplay,
} from './results.ts';

import type { SessionTmpval } from '../session.ts';

interface MetaOptions { name?: string; orgname?: string; table?: string; orgtable?: string; charsetnr?: number; decimals?: number; length?: number; }

const meta = (type: number, flags = 0, options: MetaOptions = {}): FieldMetadata => {
	const name = options.name ?? 'c';
	const table = options.table ?? 't';
	return new FieldMetadata(type, flags, {
		name,
		orgname: options.orgname ?? name,
		table,
		orgtable: options.orgtable ?? table,
		charsetnr: options.charsetnr ?? 255,
		decimals: options.decimals ?? 0,
		length: options.length ?? 11,
	});
};

const parts: DisplayParts = { edit_lnk: UPDATE_ROW, del_lnk: DELETE_ROW, sort_lnk: '1', nav_bar: '1', bkm_form: '1', text_btn: '0', pview_lnk: '0' };
const linkState = { url: { server: 1, serverDefault: 1, lang: 'en', hasLangCookie: true, token: 't' }, linkLengthLimit: 1000 };
const escape = (value: string): string => value.replaceAll('\'', String.raw`\'`);
const noViews = { isView: () => false, escapeString: escape };

describe('display parts', () => {
	it('turns everything off for the print view', () => {
		expect(displayPartsForPrintView(parts)).toEqual({ edit_lnk: NO_EDIT_OR_DELETE, del_lnk: NO_EDIT_OR_DELETE, sort_lnk: '0', nav_bar: '0', bkm_form: '0', text_btn: '0', pview_lnk: '0' });
	});

	it('gives process lists Kill links and other SHOW results none', () => {
		expect(isShowProcessList('SHOW PROCESSLIST')).toBe(true);
		expect(isShowProcessList('show full\tprocesslist')).toBe(true);
		expect(isShowProcessList('SHOW VARIABLES')).toBe(false);
		expect(isShowProcessList('SELECT 1')).toBe(false);
		expect(displayPartsForShow(parts, 'SHOW PROCESSLIST')).toMatchObject({ edit_lnk: NO_EDIT_OR_DELETE, del_lnk: KILL_PROCESS, sort_lnk: '0', nav_bar: '0', text_btn: '1' });
		expect(displayPartsForShow(parts, 'SHOW TABLES').del_lnk).toBe(NO_EDIT_OR_DELETE);
	});

	it('shows the text button for non-data results only after maintenance', () => {
		expect(displayPartsForNonData(parts, true)).toMatchObject({ edit_lnk: NO_EDIT_OR_DELETE, sort_lnk: '0', text_btn: '1' });
		expect(displayPartsForNonData(parts, false).text_btn).toBe('0');
	});

	it('keeps row links for one table and drops them for several or none', () => {
		expect(displayPartsForSelect(parts, [meta(MysqlType.LONG), meta(MysqlType.LONG, 0, { table: '' })])).toMatchObject({ edit_lnk: UPDATE_ROW, del_lnk: DELETE_ROW, text_btn: '1', pview_lnk: '1' });
		expect(displayPartsForSelect(parts, [meta(MysqlType.LONG), meta(MysqlType.LONG, 0, { table: 'u' })])).toMatchObject({ edit_lnk: NO_EDIT_OR_DELETE, del_lnk: NO_EDIT_OR_DELETE });
		expect(displayPartsForSelect(parts, [meta(MysqlType.LONG, 0, { table: '' })])).toMatchObject({ edit_lnk: NO_EDIT_OR_DELETE, del_lnk: NO_EDIT_OR_DELETE });
		const noLinks = { ...parts, edit_lnk: NO_EDIT_OR_DELETE, del_lnk: NO_EDIT_OR_DELETE, sort_lnk: '0' };
		expect(displayPartsForSelect(noLinks, [meta(MysqlType.LONG), meta(MysqlType.LONG, 0, { table: 'u' })]).pview_lnk).toBe('1');
	});
});

describe('cell text helpers', () => {
	it('cuts partial text by characters and reports the original length', () => {
		expect(getPartialText('héllo world', 5, 'P')).toEqual([true, 'héllo...', 11]);
		expect(getPartialText('héllo world', 5, 'F')).toEqual([false, 'héllo world', 11]);
		expect(getPartialText('abc', 5, 'P')).toEqual([false, 'abc', 3]);
	});

	it('escapes values and keeps runs of spaces and line breaks visible', () => {
		expect(mimeDefaultFunction('a  b\r\nc\rd\n<e>')).toBe('a &nbsp;b<br>\nc<br>\nd<br>\n&lt;e&gt;');
	});

	it('prints BIT values in binary padded to the column length', () => {
		expect(printableBitValue('5', 8)).toBe('00000101');
		expect(printableBitValue(' 18446744073709551615', 1)).toBe('1'.repeat(64));
		expect(printableBitValue('x', 2)).toBe('00');
	});

	it('classifies columns for the grid editor', () => {
		expect(classForDateTimeRelatedFields(meta(MysqlType.TIMESTAMP))).toBe('datetimefield');
		expect(classForDateTimeRelatedFields(meta(MysqlType.DATETIME))).toBe('datetimefield');
		expect(classForDateTimeRelatedFields(meta(MysqlType.DATE))).toBe('datefield');
		expect(classForDateTimeRelatedFields(meta(MysqlType.TIME))).toBe('timefield');
		expect(classForDateTimeRelatedFields(meta(MysqlType.VAR_STRING))).toBe('text');
		expect(classForDateTimeRelatedFields(meta(MysqlType.LONG))).toBe('');
		expect(isColumnNumeric(meta(MysqlType.DOUBLE))).toBe(true);
		expect(isColumnNumeric(meta(MysqlType.BIT))).toBe(true);
		expect(isColumnNumeric(meta(MysqlType.LONG))).toBe(true);
		expect(isColumnNumeric(meta(MysqlType.VAR_STRING))).toBe(false);
	});

	it('adds classes for media type, condition, truncation, transformation and column kind', () => {
		const typed = meta(MysqlType.STRING, MysqlFlag.ENUM | MysqlFlag.SET, { charsetnr: 63 });
		typed.internalMediaType = 'Text/Plain';
		expect(addClass('data', true, typed, 'pre_wrap', true, true)).toBe('data pre_wrap Text_Plain condition truncated transformed enum set hex');
		expect(addClass('', false, meta(MysqlType.BIT), '0')).toBe('bit');
	});
});

describe('cell templates', () => {
	it('renders values, NULLs, empty strings and data cells like the display/results templates', () => {
		const text = meta(MysqlType.VAR_STRING, 0, { decimals: 31 });
		expect(valueDisplay('data "x"', true, '<b>v</b>')).toBe('<td class="text-start data &quot;x&quot; condition"><b>v</b></td>\n');
		expect(valueDisplay('data', false, 'v')).toBe('<td class="text-start data">v</td>\n');
		expect(nullDisplay('data text', false, text)).toBe('<td data-decimals="31"\n    data-type="string"\n        class="data text null">\n    <em>NULL</em>\n</td>\n');
		expect(emptyDisplay('data', false, text)).toBe('<td class="data text-nowrap"></td>\n');
		expect(rowData('Ada', 'data pre_wrap', text, '3')).toBe('<td data-decimals="31" data-type="string" data-originallength="3" class="data pre_wrap">Ada</td>\n');
		expect(rowData('1', 'data', meta(MysqlType.LONG), '')).toBe('<td data-decimals="0" data-type="int" class="data">1</td>\n');
	});

	it('shortens long column comments with an ellipsis', () => {
		const comments = { t: { c: 'a <long> comment' } };
		expect(commentForRow(comments, 'c', 't', 6)).toBe('    <br><span class="tblcomment" title="a &lt;long&gt; comment">\n                    a &lt;lon…\n            </span>\n');
		expect(commentForRow(comments, 'c', 't', 50)).toContain('a &lt;long&gt; comment\n');
		expect(commentForRow(comments, 'd', 't', 50)).toBe('');
		expect(commentForRow(comments, 'c', 'u', 50)).toBe('');
	});

	it('renders sortable and plain column headers', () => {
		const sortable = tableHeadersForColumns(true, [{ column_name: 'id', order_link: '<a>id</a>', comments: '', is_browse_marker_enabled: true, is_browse_pointer_enabled: true, is_column_hidden: true, is_column_numeric: true }]);
		expect(sortable).toBe('  <th class="draggable position-sticky text-end hide column_heading marker pointer" data-column="id">\n          <a>id</a>\n        \n  </th>\n');
		const plain = tableHeadersForColumns(false, [{ column_name: 'a<b', comments: 'x', is_column_hidden: false, is_column_numeric: false, has_condition: true }]);
		expect(plain).toBe('  <th class="draggable position-sticky condition" data-column="a&lt;b">\n          a&lt;b\n        x\n  </th>\n');
		expect(tableHeadersForColumns(true, [{ column_name: 'n', comments: '', is_column_hidden: false, is_column_numeric: false }])).toContain('column_heading" data-column="n">\n          \n');
	});

	it('repeats the header row with the empty action columns around it', () => {
		expect(repeatingHeaders(4, ['<th>a</th>'], 1, POSITION_LEFT)).toBe('<tr class="repeating_header_row">\n    <th colspan="4">\n        &nbsp;</th>\n<th>a</th>    <th colspan="1">\n        &nbsp;</th>\n</tr>\n');
		expect(repeatingHeaders(0, [], 0, POSITION_NONE)).toBe('<tr class="repeating_header_row">\n    <th></th>\n</tr>\n');
		expect(repeatingHeaders(0, [], 0, POSITION_LEFT)).toBe('<tr class="repeating_header_row">\n</tr>\n');
	});
});

describe('checkboxAndLinks', () => {
	const input: CheckboxAndLinks = {
		position: POSITION_LEFT,
		hasCheckbox: true,
		edit: { url: 'index.php?route=/table/change', params: { a: 1 }, string: 'Edit', clauseIsUnique: false },
		copy: { url: 'index.php?route=/table/change', params: { a: 2 }, string: 'Copy' },
		delete: { url: 'index.php?route=/sql', params: { sql_query: 'DELETE' }, string: 'Delete' },
		rowNumber: 3,
		whereClause: '`t`.`id` = 1',
		condition: '{"`t`.`id`":"= 1"}',
		isAjax: true,
		jsConf: 'DELETE FROM t WHERE <x>',
	};

	it('renders the checkbox, edit, copy and delete cells on the left', () => {
		const html = checkboxAndLinks(linkState, input);
		expect(html).toContain('id="id_rows_to_delete3_left" name="rows_to_delete[3]" value="`t`.`id` = 1"');
		expect(html).toContain('<input type="hidden" class="condition_array" value="{&quot;`t`.`id`&quot;:&quot;= 1&quot;}">');
		expect(html).toContain('<td class="text-center d-print-none edit_row_anchor nonunique">');
		expect(html).toContain('<input type="hidden" class="where_clause" value="`t`.`id` = 1">');
		expect(html).toContain('<td class="text-center d-print-none ajax">');
		expect(html).toContain('class="delete_row requireConfirm ajax">Delete</a>');
		expect(html).toContain('<div class="hide">DELETE FROM t WHERE &lt;x&gt;</div>');
		expect(html.indexOf('rows_to_delete')).toBeLessThan(html.indexOf('Edit'));
	});

	it('mirrors the order on the right and shows only the checkbox without links', () => {
		const right = checkboxAndLinks(linkState, { ...input, position: POSITION_RIGHT, edit: { ...input.edit, clauseIsUnique: true }, isAjax: false, jsConf: '', whereClause: '' });
		expect(right.indexOf('Delete')).toBeLessThan(right.indexOf('Edit'));
		expect(right).toContain('id="id_rows_to_delete3_right"');
		expect(right).toContain('edit_row_anchor">');
		expect(right).not.toContain('class="where_clause"');
		expect(right).not.toContain('<div class="hide">');
		expect(right).toContain('<td class="text-center d-print-none">\n      <span class="text-nowrap">\n        <a href="index.php" data-post="route=/sql&sql_query=DELETE"');
		const none = checkboxAndLinks(linkState, { ...input, position: POSITION_NONE });
		expect(none).toContain('rows_to_delete');
		expect(none).not.toContain('Edit');
	});

	it('leaves out missing links and the checkbox', () => {
		const html = checkboxAndLinks(linkState, {
			...input,
			hasCheckbox: false,
			edit: { url: null, params: null, string: null, clauseIsUnique: true },
			copy: { url: '', params: null, string: null },
			delete: { url: null, params: null, string: null },
		});
		expect(html).toBe('  \n  \n  \n  ');
	});
});

describe('sorting', () => {
	it('links to the reverse direction with the matching arrows', () => {
		const [desc, descImages] = sortingUrlParams(' desc', 'ORDER BY `a` ');
		expect(desc).toBe('ORDER BY `a` ASC');
		expect(descImages).toBe(' <img src="themes/dot.gif" title="" alt="Descending" class="icon ic_s_desc soimg"> <img src="themes/dot.gif" title="" alt="Ascending" class="icon ic_s_asc soimg hide">');
		expect(sortingUrlParams('ASC', '')[0]).toBe('DESC');
	});

	it('finds a column among the sorted expressions, with or without its table', () => {
		expect(isInSorted(['`name` DESC'], ['`name`'], '', 'name')).toBe(true);
		expect(isInSorted(['`t`.`name` ASC'], ['`t`.`name`'], '`t`.', 'name')).toBe(true);
		expect(isInSorted(['`id` ASC', '`name` ASC'], ['`id`', '`name`'], '`t`.', 'name')).toBe(true);
		expect(isInSorted(['`id` ASC'], ['`id`'], '', 'name')).toBe(false);
		expect(isInSorted([''], [''], '', 'name')).toBe(false);
		expect(isInSorted(['LENGTH(name) ASC'], ['LENGTH(name)'], '`t`.', 'LENGTH(name)')).toBe(false);
	});

	it('builds the single and multi sort clauses for an unsorted column', () => {
		const [single, multi, image] = singleAndMultiSortUrls([''], [''], '`t`.', 'name', [''], meta(MysqlType.VAR_STRING), 'ASC');
		expect(single).toBe('\nORDER BY `t`.`name` ASC');
		expect(multi).toBe('\nORDER BY `t`.`name` ASC');
		expect(image).toBe('');
	});

	it('reverses the sorted column and appends to an existing multi sort', () => {
		const [single, multi, image] = singleAndMultiSortUrls(['`score` DESC', '`name` ASC'], ['`score`', '`name`'], '`players`.', 'name', ['DESC', 'ASC'], meta(MysqlType.VAR_STRING), 'ASC');
		expect(single).toBe('\nORDER BY `players`.`name` DESC');
		expect(multi).toBe('\nORDER BY `players`.`score` DESC, `players`.`name` DESC');
		expect(image).toContain('ic_s_asc soimg"');
		expect(image).toMatch(/<small>2<\/small>$/);
		const [, added] = singleAndMultiSortUrls(['`score` DESC'], ['`score`'], '', 'name', ['DESC'], meta(MysqlType.VAR_STRING), 'DESC');
		expect(added).toBe('\nORDER BY `score` DESC, `name` DESC');
	});

	it('sorts dates descending first in SMART mode and keeps functions and table prefixes', () => {
		expect(singleAndMultiSortUrls([''], [''], '', 'joined', [''], meta(MysqlType.DATETIME), 'SMART')[0]).toBe('\nORDER BY `joined` DESC');
		expect(singleAndMultiSortUrls([''], [''], '', 'name', [''], meta(MysqlType.VAR_STRING), 'SMART')[0]).toBe('\nORDER BY `name` ASC');
		const [, multi] = singleAndMultiSortUrls(['LENGTH(`a`) ASC', '`u`.`b` ASC', '0'], ['LENGTH(`a`)', '`u`.`b`', '0'], '`t`', 'c', ['ASC', 'ASC', ''], meta(MysqlType.VAR_STRING), 'ASC');
		expect(multi).toBe('\nORDER BY LENGTH(`a`) ASC, `u`.`b` ASC, `t`.`c` ASC');
	});

	it('sorts a column named after a function call without the table prefix', () => {
		const [single, multi] = singleAndMultiSortUrls([''], [''], '`t`.', 'COUNT(*)', [''], meta(MysqlType.LONGLONG), 'ASC');
		expect(single).toBe('\nORDER BY `COUNT(*)` ASC');
		expect(multi).toBe('\nORDER BY COUNT(*) ASC');
	});

	it('offers each index in both directions before the trailing clause', () => {
		const options = sortByKeyOptions([['PRIMARY', ['id']], ['ab', ['a', 'b']]], ['`a` DESC, `b` DESC'], 'SELECT * FROM t\nLIMIT 5');
		expect(options).toEqual([
			{ value: 'SELECT * FROM t ORDER BY `id` ASC\nLIMIT 5', content: 'PRIMARY (ASC)', is_selected: false },
			{ value: 'SELECT * FROM t ORDER BY `id` DESC\nLIMIT 5', content: 'PRIMARY (DESC)', is_selected: false },
			{ value: 'SELECT * FROM t ORDER BY `a` ASC, `b` ASC\nLIMIT 5', content: 'ab (ASC)', is_selected: false },
			{ value: 'SELECT * FROM t ORDER BY `a` DESC, `b` DESC\nLIMIT 5', content: 'ab (DESC)', is_selected: true },
			{ value: 'SELECT * FROM t\nLIMIT 5', content: 'None', is_selected: false },
		]);
		expect(sortByKeyOptions([['PRIMARY', ['id']]], [''], 'SELECT * FROM t').at(-1)).toEqual({ value: 'SELECT * FROM t', content: 'None', is_selected: true });
	});
});

describe('querySettingsForDisplay', () => {
	const config = { RepeatCells: 100, MaxRows: 25, RelationalDisplay: 'K' };

	it('starts from the configured defaults', () => {
		expect(querySettingsForDisplay(undefined, { sessionMaxRows: undefined, request: {} }, config, false)).toEqual({
			repeat_cells: 100, max_rows: 25, pos: 0, pftext: 'P', relational_display: 'K', geoOption: 'GEOM', display_binary: true,
		});
	});

	it('takes valid request values and keeps stored ones otherwise', () => {
		const stored = { repeat_cells: 5, max_rows: 50, pos: 25, pftext: 'F', relational_display: 'D', geoOption: 'WKT', display_blob: true };
		expect(querySettingsForDisplay(stored, { sessionMaxRows: 'x', request: { pos: 'x', pftext: 'x', relational_display: 'x', geoOption: 'x', full_text_button: '1' } }, config, false)).toEqual(stored);
		expect(querySettingsForDisplay(stored, {
			sessionMaxRows: ' 10 ',
			request: { pos: '7.9', pftext: 'P', relational_display: 'K', geoOption: 'WKB', display_binary: 'on', hide_transformation: 'on' },
		}, config, false)).toEqual({ ...stored, max_rows: 10, pos: 7, pftext: 'P', relational_display: 'K', geoOption: 'WKB', display_binary: true, hide_transformation: true });
		expect(querySettingsForDisplay(stored, { sessionMaxRows: 'all', request: {} }, config, false).max_rows).toBe(ALL_ROWS);
	});

	it('shows EXPLAIN in full text and clears unticked options of the display form', () => {
		expect(querySettingsForDisplay({ pftext: 'P' }, { sessionMaxRows: undefined, request: {} }, config, true).pftext).toBe('F');
		const cleared = querySettingsForDisplay({ display_binary: true, display_blob: true, hide_transformation: true }, { sessionMaxRows: undefined, request: { display_options_form: '1' } }, config, false);
		expect(cleared).not.toHaveProperty('display_binary');
		expect(cleared).not.toHaveProperty('display_blob');
		expect(cleared).not.toHaveProperty('hide_transformation');
	});

	it('reports which session_max_rows values are consumed', () => {
		expect(isSessionMaxRowsUsed('50')).toBe(true);
		expect(isSessionMaxRowsUsed('all')).toBe(true);
		expect(isSessionMaxRowsUsed('')).toBe(false);
		expect(isSessionMaxRowsUsed(undefined)).toBe(false);
	});

	it('copies the settings into tmpval with flags for the stored options', () => {
		const tmpval: SessionTmpval = {};
		applyDisplaySettings(tmpval, { pftext: 'P', relational_display: 'K', geoOption: 'GEOM', display_blob: true, pos: 0, max_rows: 25, repeat_cells: 100 });
		expect(tmpval).toEqual({ pftext: 'P', relational_display: 'K', geoOption: 'GEOM', display_binary: false, display_blob: true, hide_transformation: false, pos: 0, max_rows: 25, repeat_cells: 100 });
	});
});

describe('pageOffsets', () => {
	it('returns the next and previous positions, never below zero', () => {
		expect(pageOffsets(25, 25)).toEqual([50, 0]);
		expect(pageOffsets(10, 25)).toEqual([35, 0]);
		expect(pageOffsets(10, ALL_ROWS)).toEqual([0, 0]);
	});
});

describe('byte helpers', () => {
	it('hex-encodes byte strings', () => {
		expect(bin2hex('\u{0}ÿA')).toBe('00ff41');
	});

	it('counts UTF-8 characters like mb_strlen() and stray bytes one by one', () => {
		expect(utf8Length('abc')).toBe(3);
		expect(utf8Length('Ã©â\u{82}¬ð\u{9F}\u{98}\u{80}')).toBe(3);
		expect(utf8Length('ÿÃ')).toBe(2);
		expect(utf8Length('âA')).toBe(2);
	});
});

describe('getUniqueCondition', () => {
	it('prefers the primary key over other columns', () => {
		const fields = [meta(MysqlType.LONG, MysqlFlag.PRI_KEY, { name: 'id' }), meta(MysqlType.VAR_STRING, 0, { name: 'name' })];
		expect(getUniqueCondition(fields, ['1', 'O\'Hara'], noViews)).toEqual(['`t`.`id` = 1', true, { '`t`.`id`': '= 1' }]);
	});

	it('falls back to a unique key, then to every column', () => {
		const unique = [meta(MysqlType.VAR_STRING, MysqlFlag.UNIQUE_KEY, { name: 'u' }), meta(MysqlType.LONG, 0, { name: 'n' })];
		expect(getUniqueCondition(unique, ['x', '2'], noViews)).toEqual(['`t`.`u` = \'x\'', true, { '`t`.`u`': '= \'x\'' }]);
		const plain = [meta(MysqlType.LONG, 0, { name: 'a' }), meta(MysqlType.VAR_STRING, 0, { name: 'b' })];
		expect(getUniqueCondition(plain, [null, 'O\'Hara'], noViews)).toEqual(['`t`.`a` IS NULL AND `t`.`b` = \'O\\\'Hara\'', false, { '`t`.`a`': 'IS NULL', '`t`.`b`': String.raw`= 'O\'Hara'` }]);
		expect(getUniqueCondition(plain, ['1', 'x'], { ...noViews, forceUnique: true })).toEqual(['', true, {}]);
	});

	it('matches binary values by hex and long blobs by length', () => {
		const binary = meta(MysqlType.STRING, 0, { name: 'bn', charsetnr: 63 });
		expect(getUniqueCondition([binary], ['\u{0}ÿ'], noViews)[0]).toBe('`t`.`bn` = CAST(0x00ff AS BINARY)');
		expect(getUniqueCondition([binary], [''], noViews)[0]).toBe('`t`.`bn` = \'\'');
		const blob = meta(MysqlType.BLOB, MysqlFlag.BLOB, { name: 'bl', charsetnr: 63 });
		expect(getUniqueCondition([blob], ['x'.repeat(1000)], noViews)[0]).toBe('CHAR_LENGTH(`t`.`bl`)  = 1000');
		expect(getUniqueCondition([blob, meta(MysqlType.LONG, 0, { name: 'n' })], ['x'.repeat(1000), '5'], noViews)[0]).toBe('`t`.`n` = 5');
		expect(getUniqueCondition([blob, meta(MysqlType.LONG, 0, { name: 'n' })], ['', '5'], noViews)[0]).toBe('`t`.`n` = 5');
	});

	it('handles geometry, BIT and floating point columns', () => {
		const geometry = meta(MysqlType.GEOMETRY, 0, { name: 'g', charsetnr: 63 });
		expect(getUniqueCondition([geometry], ['\u{1}'], noViews)[0]).toBe('`t`.`g` = CAST(0x01 AS BINARY)');
		expect(getUniqueCondition([geometry], ['x'.repeat(5000)], noViews)[0]).toBe('');
		expect(getUniqueCondition([meta(MysqlType.BIT, 0, { name: 'b', length: 4 })], ['5'], noViews)[0]).toBe('`t`.`b` = b\'0101\'');
		expect(getUniqueCondition([meta(MysqlType.DOUBLE, 0, { name: 'f' })], ['1.5'], noViews)[0]).toBe('CONCAT(`t`.`f`) = 1.5');
	});

	it('restricts to one table and resolves aliases and views', () => {
		const aliased = meta(MysqlType.LONG, MysqlFlag.PRI_KEY, { name: 'ident', orgname: '', table: 'v', orgtable: 't' });
		const other = meta(MysqlType.LONG, 0, { name: 'x', table: 'u' });
		const fields = [aliased, other];
		expect(getUniqueCondition(fields, ['1', '2'], { ...noViews, restrictToTable: 'u', expressions: [{ alias: null, column: null }, { alias: 'IDENT', column: 'id' }] }))
			.toEqual(['`u`.`x` = 2', false, { '`u`.`x`': '= 2' }]);
		expect(aliased.orgname).toBe('id');
		expect(aliased.table).toBe('t');
		const inView = meta(MysqlType.LONG, MysqlFlag.PRI_KEY, { name: 'id', table: 'v', orgtable: 't' });
		expect(getUniqueCondition([inView], ['1'], { isView: table => table === 'v', escapeString: escape })[0]).toBe('`v`.`id` = 1');
		const unaliased = meta(MysqlType.LONG, 0, { name: 'n', orgname: '' });
		getUniqueCondition([unaliased], ['1'], { ...noViews, expressions: [{ alias: 'z', column: 'y' }] });
		expect(unaliased.orgname).toBe('n');
	});
});

describe('positionMessage', () => {
	const base: PositionMessageInput = {
		limit: null,
		maxRows: 25,
		pos: 0,
		posNext: 25,
		total: 260,
		unlimNumRows: 260,
		numRows: 25,
		viewWarning: false,
		preCount: '',
		afterCount: '',
		queryTime: 0.00012,
		sortedColumnMessage: '',
	};

	it('describes the shown page, total and query time', () => {
		expect(positionMessage(base).getMessage()).toBe('Showing rows 0 - 24 (260 total, Query took 0.0001 seconds.)');
		expect(positionMessage({ ...base, pos: 250, posNext: 275, numRows: 10, total: 260, unlimNumRows: '300', sortedColumnMessage: ' [x]' }).getMessage())
			.toBe('Showing rows 250 - 259 (260 total, 300 in query, Query took 0.0001 seconds.) [x]');
		expect(positionMessage({ ...base, maxRows: ALL_ROWS, numRows: 260 }).getMessage()).toContain('Showing rows 0 - 259');
	});

	it('uses the LIMIT of the query and the approximate count hint', () => {
		expect(positionMessage({ ...base, limit: { offset: 1, rowCount: 1 }, total: 3, unlimNumRows: 3 }).getMessage()).toContain('Showing rows 1 -  1 (3 total');
		expect(positionMessage({ ...base, limit: { offset: 0, rowCount: 10 }, total: 3, unlimNumRows: 3 }).getMessage()).toContain('Showing rows 0 -  2 (');
		expect(positionMessage({ ...base, preCount: '~', afterCount: '<hint>' }).getMessage()).toContain('(~260 total <hint>, Query took');
	});

	it('replaces the last row and total with the view warning', () => {
		expect(positionMessage({ ...base, viewWarning: '<span>hint</span>' }).getMessage()).toBe('Showing rows 0 - ... <span>hint</span> (Query took 0.0001 seconds.)');
	});
});

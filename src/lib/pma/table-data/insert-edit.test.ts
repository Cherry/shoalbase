import { describe, expect, it } from 'vitest';

import {
	type EditConfig,
	type TableColumn,
	addMicroseconds,
	analyzeTableColumnsArray,
	bin2hex,
	buildInsertQuery,
	castPostedBoolean,
	duplicateFirstNewline,
	getColumnSize,
	getCurrentValueForDifferentTypes,
	getCurrentValueForFunction,
	getDefaultFunctionForField,
	getFunctionsForField,
	getGisDataTypes,
	getGotoInclude,
	getHtmlForIgnoreOption,
	getHtmlInput,
	getMaxUploadSize,
	getNullifyCode,
	getQueryValue,
	getSpecialCharsForExistingRow,
	getSpecialCharsForInsertingMode,
	getTextarea,
	getValueColumnForOtherDatatypes,
	gisFromFunctions,
	isColumnBinary,
	isWhereClauseNumeric,
	onChangeClause,
	printableBitValue,
	protectedBlobSize,
	showTypeOrFunctionParams,
	stripcslashes,
	trimmedWhereClauses,
	truthy,
	typeAndDecimals,
} from './insert-edit.ts';

const mysql84 = { isMariaDB: false, version: 80400 };

function config(overrides: Partial<EditConfig> = {}): EditConfig {
	return {
		ShowFunctionFields: true,
		ShowFieldTypesInDataEditView: true,
		ProtectBinary: 'blob',
		CharEditing: 'input',
		MinSizeForInputField: 4,
		MaxSizeForInputField: 60,
		TextareaRows: 15,
		TextareaCols: 40,
		CharTextareaRows: 7,
		CharTextareaCols: 40,
		LongtextDoubleTextarea: true,
		LimitChars: 50,
		DefaultFunctions: { FUNC_CHAR: '', FUNC_DATE: '', FUNC_NUMBER: '', FUNC_SPATIAL: 'GeomFromText', FUNC_UUID: 'UUID', first_timestamp: 'NOW' },
		...overrides,
	};
}

function column(type: string, overrides: Partial<TableColumn> = {}): TableColumn {
	return { Field: 'col', Type: type, Null: 'YES', Key: '', Default: null, Extra: '', ...overrides };
}

const options = { columnNameAppendix: '[multi_edit][0][h]', onChangeClause: 'onchange="x"', tabindex: 2, tabindexForValue: 0, idindex: 2, readOnly: false };

describe('column analysis', () => {
	it('derives the true type, flags and the comment title', () => {
		const analyzed = analyzeTableColumnsArray(column('varchar(10)', { Field: 'a<b' }), { 'a<b': 'say "hi"' }, false);
		expect(analyzed.True_Type).toBe('varchar');
		expect(analyzed.Field_md5).toHaveLength(32);
		expect(analyzed.Field_title).toBe('<span style="border-bottom: 1px dashed black;" title="say &quot;hi&quot;">a&lt;b</span>');
		expect(analyzed.is_char).toBe(true);
		expect(analyzed.wrap).toBe(' text-nowrap');
		expect(analyzeTableColumnsArray(column('double'), {}, false).len).toBe(100);
	});

	it('treats enum and set as their own type and flags the first timestamp', () => {
		expect(analyzeTableColumnsArray(column('enum(\'binary\')'), {}, false)).toMatchObject({ pma_type: 'enum', wrap: '', is_binary: false });
		expect(analyzeTableColumnsArray(column('set(\'a\')'), {}, false).pma_type).toBe('set');
		expect(analyzeTableColumnsArray(column('timestamp(3)'), {}, false)).toMatchObject({ pma_type: 'timestamp(3)', first_timestamp: true });
		expect(analyzeTableColumnsArray(column('timestamp'), {}, true).first_timestamp).toBe(false);
		expect(analyzeTableColumnsArray(column('blob'), {}, false).is_blob).toBe(true);
	});

	it('picks the nullify code the JavaScript expects', () => {
		const analyze = (type: string) => analyzeTableColumnsArray(column(type), {}, false);
		expect(getNullifyCode(analyze('enum(\'alpha\',\'beta\',\'gamma\')'), null)).toBe('1');
		expect(getNullifyCode(analyze('enum(\'a\')'), null)).toBe('2');
		expect(getNullifyCode(analyze('set(\'a\')'), null)).toBe('3');
		expect(getNullifyCode(analyze('int'), false)).toBe('4');
		expect(getNullifyCode(analyze('int'), true)).toBe('6');
		expect(getNullifyCode(analyze('int'), null)).toBe('5');
	});
});

describe('value helpers', () => {
	it('mirrors the Util string helpers', () => {
		expect(addMicroseconds('')).toBe('');
		expect(addMicroseconds('CURRENT_TIMESTAMP(3)')).toBe('CURRENT_TIMESTAMP(3)');
		expect(addMicroseconds('10:00')).toBe('10:00.000000');
		expect(addMicroseconds('10:00.12')).toBe('10:00.120000');
		expect(duplicateFirstNewline('\r\nx')).toBe('\n\r\nx');
		expect(duplicateFirstNewline('x\r\n')).toBe('x\r\n');
		expect(printableBitValue('3', 8)).toBe('00000011');
		expect(printableBitValue('', 2)).toBe('00');
		expect(printableBitValue('x', 1)).toBe('0');
		expect(bin2hex('\u{0}ÿ')).toBe('00ff');
		expect(bin2hex('é€')).toBe('c3a9e282ac');
		expect(stripcslashes('a\\nb\\x41\\101\\q\\')).toBe('a\nbAAq');
	});

	it('recognises numeric single-column where clauses', () => {
		expect(isWhereClauseNumeric(null)).toBe(false);
		expect(isWhereClauseNumeric('`t`.`id` = 5')).toBe(true);
		expect(isWhereClauseNumeric(['`t`.`a` = \'x\'', ' `t`.`b` = 1'])).toBe(true);
		expect(isWhereClauseNumeric('`t`.`a` = \'x\'')).toBe(false);
	});

	it('lists GIS types and the type and decimals data attributes', () => {
		expect(getGisDataTypes(true)[0]).toBe('GEOMETRY');
		expect(getGisDataTypes()).toContain('point');
		expect(typeAndDecimals('decimal(10,2)')).toEqual({ type: 'decimal', decimals: '10,2' });
		expect(typeAndDecimals('enum')).toEqual({ type: 'enum', decimals: 0 });
		expect(onChangeClause('h', '0', 'int')).toBe('onchange="return verificationsAfterFieldChange(\'h\', \'0\',\'int\')"');
		expect(getHtmlForIgnoreOption(1)).toContain('checked="checked" name="insert_ignore_1"');
		expect(getHtmlForIgnoreOption(2, false)).toBe('<input type="checkbox" name="insert_ignore_2" id="insert_ignore_2"><label for="insert_ignore_2">Ignore</label><br>\n');
		expect(truthy('0')).toBe(false);
		expect(truthy(1)).toBe(true);
		expect(trimmedWhereClauses({ 0: ' a ' })).toEqual({ 0: 'a' });
	});

	it('caps the upload size per BLOB type and sizes protected blobs', () => {
		expect(getMaxUploadSize('blob', 2_097_152)).toBe('(Max: 64KiB)\n');
		expect(getMaxUploadSize('longblob', 2_097_152)).toBe('(Max: 2,048KiB)\n');
		expect(protectedBlobSize('00ff10')).toEqual(['6', 'B']);
		expect(protectedBlobSize('a\\0b\\')).toEqual(['3', 'B']);
		expect(protectedBlobSize(String.raw`a\xb`)).toEqual(['3', 'B']);
	});

	it('builds the show/hide links for the function and type columns', () => {
		expect(showTypeOrFunctionParams('function', { db: 'd' }, true, config(), 'index.php?route=/sql&server=2')).toEqual({ db: 'd', ShowFunctionFields: 0, ShowFieldTypesInDataEditView: true, goto: 'index.php?route=/sql&server=2' });
		expect(showTypeOrFunctionParams('type', {}, false, config(), 'index.php?route=/sql')).toEqual({ ShowFieldTypesInDataEditView: 1, ShowFunctionFields: true, goto: 'index.php?route=/sql' });
		expect(showTypeOrFunctionParams('function', {}, false, config(), '').ShowFunctionFields).toBe(1);
		expect(showTypeOrFunctionParams('type', {}, true, config(), '').ShowFieldTypesInDataEditView).toBe(0);
	});
});

describe('function drop-down', () => {
	const analyze = (type: string, overrides: Partial<TableColumn> = {}) => analyzeTableColumnsArray(column(type, overrides), {}, false);

	it('selects the default function by type class', () => {
		expect(getDefaultFunctionForField(analyze('point'), true, config(), mysql84)).toBe('ST_GeomFromText');
		expect(getDefaultFunctionForField(analyze('point'), true, config(), { isMariaDB: false, version: 50500 })).toBe('GeomFromText');
		expect(getDefaultFunctionForField(analyze('point'), true, config({ DefaultFunctions: { FUNC_SPATIAL: 'ST_X' } }), mysql84)).toBe('ST_X');
		expect(getDefaultFunctionForField(analyze('json'), true, config(), mysql84)).toBe('');
		expect(getDefaultFunctionForField(analyze('uuid'), true, config(), mysql84)).toBe('');
	});

	it('uses NOW for a first NOT NULL timestamp without default and UUID for char(36) keys', () => {
		expect(getDefaultFunctionForField(analyze('timestamp', { Null: 'NO' }), false, config(), mysql84)).toBe('NOW');
		expect(getDefaultFunctionForField(analyze('timestamp', { Null: 'NO', Default: 'CURRENT_TIMESTAMP' }), false, config(), mysql84)).toBe('');
		expect(getDefaultFunctionForField(analyze('char(36)', { Key: 'PRI' }), true, config(), mysql84)).toBe('UUID');
		expect(getDefaultFunctionForField(analyze('char(36)', { Key: 'PRI' }), false, config(), mysql84)).toBe('');
		expect(getDefaultFunctionForField(analyze('varchar(36)', { Key: 'PRI' }), true, config(), mysql84)).toBe('UUID');
		expect(getDefaultFunctionForField(analyze('varchar(37)', { Key: 'PRI' }), true, config(), mysql84)).toBe('');
	});

	it('marks the default unless the column has a foreign key', () => {
		const html = getFunctionsForField(analyze('timestamp', { Null: 'NO' }), true, false, config(), mysql84);
		expect(html.startsWith('<option></option>\n<option>ABS</option>\n')).toBe(true);
		expect(html).toContain('<option selected="selected">NOW</option>');
		expect(html.endsWith('password_hash() PHP function</option>\n')).toBe(true);
		expect(getFunctionsForField(analyze('timestamp', { Null: 'NO' }), true, true, config(), mysql84)).not.toContain('selected');
	});

	it('marks binary columns only while functions are shown', () => {
		expect(isColumnBinary(analyze('blob'), false, config())).toBe(true);
		expect(isColumnBinary(analyze('blob'), true, config())).toBe(false);
		expect(isColumnBinary(analyze('binary(2)'), true, config({ ProtectBinary: 'all' }))).toBe(true);
		expect(isColumnBinary(analyze('binary(2)'), true, config({ ProtectBinary: 'noblob' }))).toBe(true);
		expect(isColumnBinary(analyze('blob'), false, config({ ShowFunctionFields: '0' }))).toBe(false);
	});
});

describe('value inputs', () => {
	const analyze = (type: string, overrides: Partial<TableColumn> = {}) => analyzeTableColumnsArray(column(type, overrides), {}, false);

	it('renders text inputs with date classes, integer ranges and char lengths', () => {
		const date = getHtmlInput(analyze('date'), '2024-01-01', 10, 'DATE', options);
		expect(date).toBe('<input type="text" name="fields[multi_edit][0][h]" value="2024-01-01" size="10" data-type="DATE" class="textfield datefield" onchange="x" tabindex="2" id="field_2_3">');
		expect(getHtmlInput(analyze('int(10) unsigned'), null, 11, 'NUMBER', options)).toContain('min="0" max="4294967295" data-type="INT"');
		// MySQL 8 drops the display width, so the true type keeps "unsigned" and is not an integer type for upstream.
		expect(getHtmlInput(analyze('int unsigned'), null, 11, 'NUMBER', options)).toContain('data-type="NUMBER"');
		expect(getHtmlInput(analyze('char(5)'), 'x', 5, 'CHAR', { ...options, readOnly: true })).toContain('data-maxlength="5" readonly="readonly"');
		expect(getHtmlInput(analyze('time'), '', 8, 'DATE', options)).toContain('class="textfield timefield"');
		expect(getHtmlInput(analyze('datetime'), '', 8, 'DATE', options)).toContain('class="textfield datetimefield"');
	});

	it('renders textareas sized for char and long text columns', () => {
		expect(getTextarea(analyze('varchar(100)'), '<b>', 'v', 'CHAR', options, config())).toBe('<b>\n<textarea name="fields[multi_edit][0][h]" class="charField" data-maxlength="100" rows="7" cols="40" dir="ltr" id="field_2_3" onchange="x" tabindex="2" data-type="CHAR">v</textarea>');
		expect(getTextarea(analyze('longtext'), '', null, 'CHAR', { ...options, onChangeClause: '', readOnly: true }, config())).toBe('\n<textarea name="fields[multi_edit][0][h]" class="" readonly="readonly" rows="30" cols="80" dir="ltr" id="field_2_3" tabindex="2" data-type="CHAR"></textarea>');
		expect(getTextarea(analyze('text'), '', '', 'CHAR', options, config())).toContain('rows="15" cols="40"');
	});

	it('switches wide char columns to a textarea and restores CharEditing', () => {
		const settings = config();
		expect(getColumnSize(analyze('varchar(100)'), '100', settings)).toBe(60);
		expect(settings.CharEditing).toBe('textarea');
		const html = getValueColumnForOtherDatatypes({ column: analyze('varchar(100)'), defaultCharEditing: 'input', backupField: '<b>', specialChars: 'v', specialCharsEncoded: 'v', data: 'v', specInBrackets: '100' }, options, config());
		expect(html.startsWith('<b>\n\n<b>\n<textarea')).toBe(true);
		expect(getColumnSize({ ...analyze('int'), len: 2 }, '', config())).toBe(4);
		expect(getColumnSize(analyze('char(x)'), 'x', config())).toBe(4);
	});

	it('adds the hidden type, virtual and auto increment markers to inputs', () => {
		const render = (type: string, extra = '') => getValueColumnForOtherDatatypes({ column: { ...analyze(type, { Extra: extra }), len: 10 }, defaultCharEditing: 'input', backupField: '', specialChars: '', specialCharsEncoded: '', data: null, specInBrackets: '' }, options, config());
		expect(render('int', 'auto_increment')).toContain('name="auto_increment[multi_edit][0][h]"');
		expect(render('int', 'VIRTUAL GENERATED')).toContain('name="virtual[multi_edit][0][h]"');
		expect(render('timestamp', 'DEFAULT_GENERATED')).toContain('value="timestamp"');
		expect(render('timestamp', 'DEFAULT_GENERATED')).not.toContain('virtual');
		expect(render('datetime')).toContain('value="datetime"');
		expect(render('date')).toContain('value="date"');
		expect(render('bit(1)')).toContain('value="bit"');
		expect(render('char(3)', '')).toContain('data-maxlength');
		const multiline = getValueColumnForOtherDatatypes({ column: analyze('char(3)'), defaultCharEditing: 'input', backupField: '', specialChars: 'a\nb', specialCharsEncoded: 'a\nb', data: 'a\nb', specInBrackets: '3' }, options, config());
		expect(multiline).toContain('<textarea');
	});
});

describe('special characters of the current value', () => {
	const analyze = (type: string, overrides: Partial<TableColumn> = {}) => analyzeTableColumnsArray(column(type, overrides), {}, false);
	const appendix = '[multi_edit][0][h]';

	it('handles NULL, bit, fractional time, spatial, binary and text values of an existing row', () => {
		expect(getSpecialCharsForExistingRow(null, analyze('int'), appendix, '', config())).toEqual({ realNullValue: true, specialCharsEncoded: '', specialChars: '', data: '', backupField: '<input type="hidden" name="fields_prev[multi_edit][0][h]" value="">' });
		expect(getSpecialCharsForExistingRow('3', analyze('bit(4)'), appendix, '', config())).toMatchObject({ specialChars: '0011', data: null, backupField: '<input type="hidden" name="fields_prev[multi_edit][0][h]" value="3">' });
		expect(getSpecialCharsForExistingRow('10:00:00.5', analyze('time(1)'), appendix, '', config()).specialChars).toBe('10:00:00.500000');
		expect(getSpecialCharsForExistingRow('raw', analyze('point'), appendix, '', config(), '\'POINT(1 2)\',0').specialChars).toBe('\'POINT(1 2)\',0');
		expect(getSpecialCharsForExistingRow('raw', analyze('point'), appendix, '', config()).specialChars).toBe('');
		expect(getSpecialCharsForExistingRow('\u{1}', analyze('varbinary(2)'), appendix, '', config()).data).toBe('01');
		expect(getSpecialCharsForExistingRow('\u{1}', analyze('blob'), appendix, '', config({ ProtectBinary: 'all' })).data).toBe('\u{1}');
		expect(getSpecialCharsForExistingRow('\r\n"\'', analyze('text'), appendix, '', config())).toMatchObject({ specialChars: '\r\n&quot;\'', specialCharsEncoded: '\n\r\n&quot;\'' });
	});

	it('empties a copied auto increment key', () => {
		const copied = getSpecialCharsForExistingRow('7', analyze('int', { Key: 'PRI', Extra: 'auto_increment' }), appendix, 'insert', config());
		expect(copied).toMatchObject({ data: null, specialChars: null, specialCharsEncoded: null });
		expect(copied.backupField).toContain('value="7"');
	});

	it('shows column defaults when inserting', () => {
		expect(getSpecialCharsForInsertingMode(analyze('int'))).toEqual({ realNullValue: true, data: '', specialChars: '', backupField: '', specialCharsEncoded: '' });
		expect(getSpecialCharsForInsertingMode(analyze('bit(3)', { Default: 'b\'101\'' })).specialChars).toBe('101');
		expect(getSpecialCharsForInsertingMode(analyze('datetime', { Default: '2024-01-01 00:00:00' })).specialChars).toBe('2024-01-01 00:00:00.000000');
		expect(getSpecialCharsForInsertingMode(analyze('binary(1)', { Default: '\u{1}' })).specialChars).toBe('01');
		expect(getSpecialCharsForInsertingMode(analyze('text', { Default: String.raw`'a\nb'` })).specialChars).toBe('a\nb');
		expect(getSpecialCharsForInsertingMode(analyze('text', { Default: 'ab' })).specialChars).toBe('ab');
		expect(getSpecialCharsForInsertingMode(analyze('varchar(3)', { Default: '<x>' }))).toMatchObject({ realNullValue: false, data: '<x>', specialChars: '&lt;x&gt;' });
	});
});

describe('saving', () => {
	it('builds function calls for the posted values', () => {
		const base = { salt: undefined, value: 'v\'', version: 80400 };
		expect(getCurrentValueForFunction({ ...base, func: 'PHP_PASSWORD_HASH', passwordHash: '$2y$x' })).toBe('\'$2y$x\'');
		expect(getCurrentValueForFunction({ ...base, func: 'PHP_PASSWORD_HASH' })).toBe('\'\'');
		expect(getCurrentValueForFunction({ ...base, func: 'UUID', uuid: 'u' })).toBe('\'u\'');
		expect(getCurrentValueForFunction({ ...base, func: 'UUID' })).toBe('\'\'');
		expect(getCurrentValueForFunction({ ...base, func: 'ST_GeomFromText', value: '\'POINT(1 1)\',4326' })).toBe('ST_GeomFromText(\'POINT(1 1)\',4326)');
		expect(getCurrentValueForFunction({ ...base, func: 'GeomFromWKB', value: 'abc', version: 50500 })).toBe('GeomFromWKB(\'abc\')');
		expect(getCurrentValueForFunction({ ...base, func: 'AES_ENCRYPT', salt: '' })).toBe(String.raw`AES_ENCRYPT('v\'','')`);
		expect(getCurrentValueForFunction({ ...base, func: 'ENCRYPT', salt: '' })).toBe(String.raw`ENCRYPT('v\'')`);
		expect(getCurrentValueForFunction({ ...base, func: 'DES_ENCRYPT', salt: 'k' })).toBe(String.raw`DES_ENCRYPT('v\'','k')`);
		expect(getCurrentValueForFunction({ ...base, func: 'NOW', value: '3' })).toBe('NOW(3)');
		expect(getCurrentValueForFunction({ ...base, func: 'NOW', value: '9' })).toBe('NOW(\'9\')');
		// PHP matches the WKT without /s, so a value with a newline escapes the missing group as an empty string.
		expect(getCurrentValueForFunction({ ...base, func: 'ST_GeomFromText', value: 'POINT(1\n1)' })).toBe('ST_GeomFromText(\'\')');
		expect(getCurrentValueForFunction({ ...base, func: 'DES_ENCRYPT' })).toBe(String.raw`DES_ENCRYPT('v\'')`);
		expect(getCurrentValueForFunction({ ...base, func: 'AES_DECRYPT' })).toBe(String.raw`AES_DECRYPT('v\'')`);
		expect(getCurrentValueForFunction({ ...base, func: 'NOW', value: '' })).toBe('NOW()');
		expect(getCurrentValueForFunction({ ...base, func: 'UPPER' })).toBe(String.raw`UPPER('v\'')`);
		expect(gisFromFunctions(50500).text[0]).toBe('GeomFromText');
	});

	it('quotes and converts values by their posted type', () => {
		const base = { uploaded: false as const, type: '', value: 'x', isAutoIncrement: false, isNull: false, wasNull: false, nullIsSet: false, setValues: null, protectedRow: null, columnName: 'c' };
		expect(getCurrentValueForDifferentTypes({ ...base, uploaded: '0xff' })).toBe('0xff');
		expect(getCurrentValueForDifferentTypes({ ...base, value: '' })).toBe('\'\'');
		expect(getCurrentValueForDifferentTypes({ ...base, value: '', isAutoIncrement: true })).toBe('NULL');
		expect(getCurrentValueForDifferentTypes({ ...base, type: 'set', setValues: ['a', 'b'] })).toBe('\'a,b\'');
		expect(getCurrentValueForDifferentTypes({ ...base, type: 'set', setValues: [] })).toBe('\'\'');
		expect(getCurrentValueForDifferentTypes({ ...base, type: 'protected', protectedRow: { c: '\u{1}' } })).toBe('0x01');
		expect(getCurrentValueForDifferentTypes({ ...base, type: 'protected', protectedRow: { c: '' } })).toBe('');
		expect(getCurrentValueForDifferentTypes({ ...base, type: 'protected', wasNull: true })).toBe('\'\'');
		expect(getCurrentValueForDifferentTypes({ ...base, type: 'hex', value: 'ab' })).toBe('0xab');
		expect(getCurrentValueForDifferentTypes({ ...base, type: 'hex', value: '0xab' })).toBe('0xab');
		expect(getCurrentValueForDifferentTypes({ ...base, type: 'bit', value: '1021' })).toBe('b\'1001\'');
		expect(getCurrentValueForDifferentTypes({ ...base, type: 'timestamp', value: 'current_timestamp(2)' })).toBe('current_timestamp(2)');
		expect(getCurrentValueForDifferentTypes({ ...base, type: 'date', value: 'x' })).toBe('\'x\'');
		expect(getCurrentValueForDifferentTypes({ ...base, value: '', isNull: true })).toBe('NULL');
		expect(getCurrentValueForDifferentTypes({ ...base, type: 'protected', isNull: true })).toBe('NULL');
		expect(getCurrentValueForDifferentTypes({ ...base, type: 'uuid', value: 'uuid()' })).toBe('uuid()');
		expect(getCurrentValueForDifferentTypes({ ...base, type: 'uuid', value: 'x' })).toBe('\'x\'');
	});

	it('decides which columns an INSERT lists and an UPDATE sets', () => {
		const base = { columnName: 'c', isInsert: true, valueSql: '\'x\'', value: 'x', previous: undefined, func: undefined, isNull: false, nullIsSet: false, wasNull: false, isFirstRow: true };
		expect(getQueryValue(base)).toEqual({ value: '\'x\'', addField: true });
		expect(getQueryValue({ ...base, isFirstRow: false })).toEqual({ value: '\'x\'', addField: false });
		expect(getQueryValue({ ...base, valueSql: '' })).toEqual({ value: null, addField: false });
		const update = { ...base, isInsert: false };
		expect(getQueryValue({ ...update, wasNull: true })).toEqual({ value: '`c` = \'x\'', addField: false });
		expect(getQueryValue({ ...update, previous: 'x' })).toEqual({ value: null, addField: false });
		expect(getQueryValue({ ...update, previous: 'x', func: 'UPPER' }).value).toBe('`c` = \'x\'');
		expect(getQueryValue({ ...update, previous: 'y' }).value).toBe('`c` = \'x\'');
		expect(getQueryValue({ ...update, valueSql: 'NULL', isNull: true, nullIsSet: true, wasNull: true }).value).toBeNull();
		expect(getQueryValue({ ...update, valueSql: '' }).value).toBeNull();
		expect(buildInsertQuery(true, 't', ['`a`'], ['1', '2'])).toBe('INSERT IGNORE INTO `t` (`a`) VALUES (1), (2)');
		expect(buildInsertQuery(false, 't', ['`a`'], ['1'])).toBe('INSERT INTO `t` (`a`) VALUES (1)');
	});

	it('chooses the page to show after saving', () => {
		expect(getGotoInclude('new_insert', '', 't')).toEqual({ include: '/table/change', table: 't' });
		expect(getGotoInclude(undefined, 'index.php?route=/sql&db=d', 't')).toEqual({ include: '/sql', table: 't' });
		expect(getGotoInclude(undefined, 'index.php', 't')).toEqual({ include: 'index.php', table: 't' });
		expect(getGotoInclude('back', 'index.php?route=/database/sql', 't')).toEqual({ include: '/database/sql', table: '' });
		expect(getGotoInclude(undefined, 'index.php?route=/table/sql', 't')).toEqual({ include: '/table/sql', table: 't' });
		expect(getGotoInclude(undefined, '', '')).toEqual({ include: '/database/sql', table: '' });
	});
});

describe('castPostedBoolean', () => {
	it('casts a posted checkbox like FormDisplay::save(), keeping an empty string', () => {
		expect(castPostedBoolean(undefined)).toBe(false);
		expect(castPostedBoolean('')).toBe('');
		expect(castPostedBoolean('on')).toBe(true);
		expect(castPostedBoolean('0')).toBe(false);
		expect(castPostedBoolean({ 0: 'on' })).toBe(false);
	});
});

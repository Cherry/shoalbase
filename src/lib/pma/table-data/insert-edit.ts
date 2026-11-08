// Pure parts of PhpMyAdmin\InsertEdit and Generator::getFunctionsForField() for the insert/edit form and its save.
import {
	INTEGER_TYPES,
	type ServerFlavor,
	getAllFunctions,
	getIntegerRange,
	getTypeClass,
} from './types.ts';
import { htmlspecialchars, phpTrim } from '../../twig/php.ts';
import { backquote, escapeJsString } from '../../twig/sanitize.ts';
import { escapeString } from '../dbi-sql.ts';
import { md5 } from '../md5.ts';
import { convertBitDefaultValue, escapeCompat, extractColumnSpec } from '../table-structure/column-spec.ts';
import { formatByteDown, getFormattedMaximumUploadSize } from '../util.ts';

/** One row of SHOW FULL COLUMNS. */
export interface TableColumn {
	Field: string;
	Type: string;
	Collation?: string | null;
	Null: string;
	Key: string;
	Default: string | null;
	Extra: string;
	Comment?: string;
}

export interface AnalyzedColumn extends TableColumn {
	Field_md5: string;
	True_Type: string;
	len: number;
	Field_title: string;
	is_binary: boolean;
	is_blob: boolean;
	is_char: boolean;
	pma_type: string;
	wrap: string;
	first_timestamp: boolean;
	values?: { plain: string; html: string; }[];
	select_size?: number;
}

/** The $cfg entries the insert/edit form reads; CharEditing is changed while rendering, as upstream does with the global. */
export interface EditConfig {
	ShowFunctionFields: boolean | string | number;
	ShowFieldTypesInDataEditView: boolean | string | number;
	ProtectBinary: string | false;
	CharEditing: string;
	MinSizeForInputField: number;
	MaxSizeForInputField: number;
	TextareaRows: number;
	TextareaCols: number;
	CharTextareaRows: number;
	CharTextareaCols: number;
	LongtextDoubleTextarea: boolean;
	LimitChars: number;
	DefaultFunctions: Record<string, string>;
}

export const GIS_DATA_TYPES = ['geometry', 'point', 'linestring', 'polygon', 'multipoint', 'multilinestring', 'multipolygon', 'geometrycollection'];

/** Gis::getDataTypes(). */
export function getGisDataTypes(upperCase = false): string[] {
	return upperCase ? GIS_DATA_TYPES.map(type => type.toUpperCase()) : [...GIS_DATA_TYPES];
}

/** PHP truthiness for config values that may come from a request string. */
export function truthy(value: unknown): boolean {
	return value !== false && value !== 0 && value !== '' && value !== '0' && value !== null && value !== undefined;
}

/** The bytes PHP would see: byte strings (all chars below 256 with some above 127 that are not valid UTF-8 text) stay as they are. */
export function toBytes(value: string): Uint8Array {
	const codes = Array.from(value, character => character.codePointAt(0) as number);
	// Strings from binary columns arrive one char per byte, so any char above 0xFF means UTF-8 text.
	if (codes.every(code => code < 256)) {
		return Uint8Array.from(codes);
	}
	return new TextEncoder().encode(value);
}

/** PHP's bin2hex() over a byte string (one char per byte) or UTF-8 text. */
export function bin2hex(value: string): string {
	let hex = '';
	for (const byte of toBytes(value)) {
		hex += byte.toString(16).padStart(2, '0');
	}
	return hex;
}

/** InsertEdit::isColumn(): the type starts with one of the names, ignoring case. */
export function isColumn(column: { Type: string; }, types: string[]): boolean {
	const type = column.Type.toLowerCase();
	return types.some(name => type.startsWith(name));
}

function getColumnTitle(column: TableColumn, commentsMap: Record<string, string>): string {
	if (Object.hasOwn(commentsMap, column.Field)) {
		return `<span style="border-bottom: 1px dashed black;" title="${htmlspecialchars(commentsMap[column.Field])}">${htmlspecialchars(column.Field)}</span>`;
	}
	return htmlspecialchars(column.Field);
}

/** InsertEdit::analyzeTableColumnsArray(). */
export function analyzeTableColumnsArray(column: TableColumn, commentsMap: Record<string, string>, timestampSeen: boolean): AnalyzedColumn {
	const trueType = column.Type.replace(/(\(.*)|(\s\/.*)/s, '');
	let pmaType = column.Type;
	let wrap = ' text-nowrap';
	let firstTimestamp = false;
	if (trueType === 'set' || trueType === 'enum') {
		pmaType = trueType;
		wrap = '';
	} else if (trueType === 'timestamp') {
		firstTimestamp = !timestampSeen;
	}
	return {
		...column,
		Field_md5: md5(column.Field),
		True_Type: trueType,
		len: /float|double/.test(column.Type) ? 100 : -1,
		Field_title: getColumnTitle(column, commentsMap),
		is_binary: isColumn(column, ['binary', 'varbinary']),
		is_blob: isColumn(column, ['blob', 'tinyblob', 'mediumblob', 'longblob']),
		is_char: isColumn(column, ['char', 'varchar']),
		pma_type: pmaType,
		wrap,
		first_timestamp: firstTimestamp,
	};
}

/** InsertEdit::getNullifyCodeForNullColumn(); `foreignLink` is null without a foreign key. */
export function getNullifyCode(column: AnalyzedColumn, foreignLink: boolean | null): string {
	if (column.True_Type.includes('enum')) {
		return [...column.Type].length > 20 ? '1' : '2';
	}
	if (column.True_Type.includes('set')) {
		return '3';
	}
	if (foreignLink === false) {
		return '4';
	}
	if (foreignLink === true) {
		return '6';
	}
	return '5';
}

/** Util::addMicroseconds(). */
export function addMicroseconds(value: string): string {
	if (value === '' || /^current_timestamp(?:\([0-6]?\))?$/i.test(value)) {
		return value;
	}
	if (!value.includes('.')) {
		return `${value}.000000`;
	}
	const padded = `${value}000000`;
	const characters = [...padded];
	return characters.slice(0, characters.indexOf('.') + 7).join('');
}

/** Util::duplicateFirstNewline(). */
export function duplicateFirstNewline(value: string): string {
	return value.startsWith('\r\n') ? `\n${value}` : value;
}

/** Util::printableBitValue() for a value that fits a JS number exactly or a decimal string. */
export function printableBitValue(value: string | number, length: number): string {
	let integer: bigint;
	try {
		integer = BigInt(String(value).trim() === '' ? 0 : String(value).trim().replace(/^\+/, '')
			.replace(/\..*$/, ''));
	} catch {
		integer = 0n;
	}
	return integer.toString(2).padStart(length, '0');
}

/** InsertEdit::isWhereClauseNumeric(). */
export function isWhereClauseNumeric(whereClause: string | string[] | null): boolean {
	if (whereClause === null) {
		return false;
	}
	const clauses = Array.isArray(whereClause) ? whereClause : [whereClause];
	return clauses.some(clause => /^\s*`[^`]*`\.`[^`]*` = \d+/.test(clause));
}

/** Generator::getDefaultFunctionForField(); $data, read as a global there, is never set on this page. */
export function getDefaultFunctionForField(column: AnalyzedColumn, insertMode: boolean, config: EditConfig, server: ServerFlavor): string {
	let defaultFunction = '';
	const typeClass = getTypeClass(column.True_Type);
	const configured = config.DefaultFunctions[`FUNC_${typeClass}`];
	if (typeClass !== '' && configured !== undefined && configured !== null) {
		defaultFunction = configured;
		if (typeClass === 'SPATIAL' && server.version >= 50600 && defaultFunction.slice(0, 3).toUpperCase() !== 'ST_') {
			defaultFunction = `ST_${defaultFunction}`;
		}
	}
	const defaultIsEmpty = column.Default === null || ['', '0'].includes(column.Default);
	if (column.True_Type === 'timestamp' && column.first_timestamp && defaultIsEmpty && column.Extra !== 'on update CURRENT_TIMESTAMP' && column.Null === 'NO') {
		defaultFunction = config.DefaultFunctions.first_timestamp;
	}
	if (column.True_Type === 'uuid') {
		return '';
	}
	if (insertMode && column.Key === 'PRI' && (column.Type === 'char(36)' || column.Type === 'varchar(36)')) {
		defaultFunction = config.DefaultFunctions.FUNC_UUID;
	}
	return defaultFunction;
}

/** Generator::getFunctionsForField(); `hasForeignField` is isset($foreignData['foreign_field']). */
export function getFunctionsForField(column: AnalyzedColumn, insertMode: boolean, hasForeignField: boolean, config: EditConfig, server: ServerFlavor): string {
	const defaultFunction = getDefaultFunctionForField(column, insertMode, config, server);
	let html = '<option></option>\n';
	for (const name of getAllFunctions(server)) {
		html += `<option${name === defaultFunction && !hasForeignField ? ' selected="selected"' : ''}>${name}</option>\n`;
	}
	html += '<option value="PHP_PASSWORD_HASH" title="The PHP function password_hash() with default options.">password_hash() PHP function</option>\n';
	return html;
}

/** InsertEdit::isColumnBinary(). */
export function isColumnBinary(column: AnalyzedColumn, isUpload: boolean, config: EditConfig): boolean {
	if (!truthy(config.ShowFunctionFields)) {
		return false;
	}
	return (config.ProtectBinary === 'blob' && column.is_blob && !isUpload)
		|| (config.ProtectBinary === 'all' && column.is_binary)
		|| (config.ProtectBinary === 'noblob' && column.is_binary);
}

/** FormDisplay::save()'s cast of a posted checkbox: a missing one is false and '' is kept, as settype() is skipped for it. */
export function castPostedBoolean(value: string | object | undefined): boolean | '' {
	if (value === undefined) {
		return false;
	}
	if (value === '') {
		return '';
	}
	return truthy(typeof value === 'string' ? value : '');
}

export interface InputOptions {
	columnNameAppendix: string;
	onChangeClause: string;
	tabindex: number;
	tabindexForValue: number;
	idindex: number;
	readOnly: boolean;
}

/** InsertEdit::getHtmlInput(). */
export function getHtmlInput(column: AnalyzedColumn, specialChars: string | null, fieldsize: number, dataType: string, options: InputOptions): string {
	let theClass = 'textfield';
	if (!options.readOnly) {
		if (column.True_Type === 'date') {
			theClass += ' datefield';
		} else if (column.True_Type === 'time') {
			theClass += ' timefield';
		} else if (column.True_Type === 'datetime' || column.True_Type === 'timestamp') {
			theClass += ' datetimefield';
		}
	}
	let inputMinMax = '';
	let type = dataType;
	if (INTEGER_TYPES.includes(column.True_Type)) {
		const [min, max] = getIntegerRange(column.True_Type, !extractColumnSpec(column.Type).unsigned);
		inputMinMax = `min="${min}" max="${max}"`;
		type = 'INT';
	}
	return `<input type="text" name="fields${options.columnNameAppendix}" value="${specialChars ?? ''}" size="${fieldsize}"`
		+ (column.is_char ? ` data-maxlength="${fieldsize}"` : '')
		+ (options.readOnly ? ' readonly="readonly"' : '')
		+ (inputMinMax === '' ? '' : ` ${inputMinMax}`)
		+ ` data-type="${type}" class="${theClass}" ${options.onChangeClause} tabindex="${options.tabindex + options.tabindexForValue}" id="field_${options.idindex}_3">`;
}

/** InsertEdit::getTextarea(). */
export function getTextarea(column: AnalyzedColumn, backupField: string, specialCharsEncoded: string | null, dataType: string, options: InputOptions, config: EditConfig): string {
	let theClass = '';
	let rows = config.TextareaRows;
	let cols = config.TextareaCols;
	let maxlength: string | null = null;
	if (column.is_char) {
		theClass = 'charField';
		rows = config.CharTextareaRows;
		cols = config.CharTextareaCols;
		maxlength = extractColumnSpec(column.Type).spec_in_brackets;
	} else if (config.LongtextDoubleTextarea && column.pma_type.includes('longtext')) {
		rows = config.TextareaRows * 2;
		cols = config.TextareaCols * 2;
	}
	return `${backupField}\n<textarea name="fields${options.columnNameAppendix}" class="${theClass}"`
		+ (options.readOnly ? ' readonly="readonly"' : '')
		+ (maxlength === null ? '' : ` data-maxlength="${maxlength}"`)
		+ ` rows="${rows}" cols="${cols}" dir="ltr" id="field_${options.idindex}_3"`
		+ (options.onChangeClause === '' ? '' : ` ${options.onChangeClause}`)
		+ ` tabindex="${options.tabindex + options.tabindexForValue}" data-type="${dataType}">${specialCharsEncoded ?? ''}</textarea>`;
}

/** InsertEdit::getColumnSize(); a char column wider than the input limit switches CharEditing to textarea. */
export function getColumnSize(column: AnalyzedColumn, specInBrackets: string, config: EditConfig): number {
	let fieldsize: number;
	if (column.is_char) {
		fieldsize = Number.parseInt(specInBrackets, 10) || 0;
		if (fieldsize > config.MaxSizeForInputField) {
			config.CharEditing = 'textarea';
		}
	} else {
		fieldsize = column.len;
	}
	return Math.min(Math.max(fieldsize, config.MinSizeForInputField), config.MaxSizeForInputField);
}

export interface ValueFieldInput {
	column: AnalyzedColumn;
	defaultCharEditing: string;
	backupField: string;
	specialChars: string | null;
	specialCharsEncoded: string | null;
	data: string | null;
	specInBrackets: string;
}

/** InsertEdit::getValueColumnForOtherDatatypes(). */
export function getValueColumnForOtherDatatypes(input: ValueFieldInput, options: InputOptions, config: EditConfig): string {
	const { column } = input;
	const dataType = getTypeClass(column.True_Type);
	const fieldsize = getColumnSize(column, input.specInBrackets, config);
	let html = `${input.backupField}\n`;
	if (column.is_char && (config.CharEditing === 'textarea' || (input.data ?? '').includes('\n'))) {
		html += '\n';
		config.CharEditing = input.defaultCharEditing;
		return html + getTextarea(column, input.backupField, input.specialCharsEncoded, dataType, options, config);
	}
	html += getHtmlInput(column, input.specialChars, fieldsize, dataType, options);
	if (/VIRTUAL|PERSISTENT|GENERATED/.test(column.Extra) && !column.Extra.includes('DEFAULT_GENERATED')) {
		html += `<input type="hidden" name="virtual${options.columnNameAppendix}" value="1">`;
	}
	if (column.Extra === 'auto_increment') {
		html += `<input type="hidden" name="auto_increment${options.columnNameAppendix}" value="1">`;
	}
	if (column.pma_type.startsWith('timestamp')) {
		html += `<input type="hidden" name="fields_type${options.columnNameAppendix}" value="timestamp">`;
	}
	if (column.pma_type.startsWith('date')) {
		const type = column.pma_type.startsWith('datetime') ? 'datetime' : 'date';
		html += `<input type="hidden" name="fields_type${options.columnNameAppendix}" value="${type}">`;
	}
	if (column.True_Type === 'bit' || column.True_Type === 'uuid') {
		html += `<input type="hidden" name="fields_type${options.columnNameAppendix}" value="${column.True_Type}">`;
	}
	return html;
}

export interface SpecialChars {
	realNullValue: boolean;
	specialCharsEncoded: string | null;
	specialChars: string | null;
	data: string | null;
	backupField: string;
}

/**
 * InsertEdit::getSpecialCharsAndBackupFieldForExistingRow(). `wkt` is Gis::convertToWellKnownText($value, true)
 * for spatial columns, which needs the server.
 */
export function getSpecialCharsForExistingRow(value: string | null, column: AnalyzedColumn, columnNameAppendix: string, defaultAction: string, config: EditConfig, wkt: string | null = null): SpecialChars {
	let specialCharsEncoded: string | null = '';
	let specialChars: string | null;
	let data: string | null = null;
	let realNullValue = false;
	let current = value;
	if (current === null) {
		realNullValue = true;
		current = '';
		specialChars = '';
		data = current;
	} else if (column.True_Type === 'bit') {
		specialChars = printableBitValue(current, Number.parseInt(extractColumnSpec(column.Type).spec_in_brackets, 10));
	} else if ((column.True_Type.startsWith('timestamp') || column.True_Type === 'datetime' || column.True_Type === 'time') && current.includes('.')) {
		current = addMicroseconds(current);
		specialChars = escapeCompat(current);
	} else if (GIS_DATA_TYPES.includes(column.True_Type)) {
		current = wkt ?? '';
		specialChars = escapeCompat(current);
	} else {
		if (column.is_binary || (column.is_blob && config.ProtectBinary !== 'all')) {
			current = bin2hex(current);
		}
		specialChars = escapeCompat(current);
		specialCharsEncoded = duplicateFirstNewline(specialChars);
		data = current;
	}

	if (defaultAction === 'insert' && column.Key === 'PRI' && column.Extra.includes('auto_increment')) {
		data = null;
		specialCharsEncoded = null;
		specialChars = null;
	}

	const backupField = `<input type="hidden" name="fields_prev${columnNameAppendix}" value="${escapeCompat(current)}">`;
	return { realNullValue, specialCharsEncoded, specialChars, data, backupField };
}

/** PHP's stripcslashes(). */
export function stripcslashes(value: string): string {
	const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\u{7}', v: '\v', b: '\b', f: '\f' };
	return value.replaceAll(/\\(x[0-9A-Fa-f]{1,2}|[0-7]{1,3}|[\s\S])?/g, (match, escape: string | undefined) => {
		if (escape === undefined) {
			return '';
		}
		if (Object.hasOwn(simple, escape)) {
			return simple[escape];
		}
		if (/^x[0-9A-Fa-f]/.test(escape)) {
			return String.fromCodePoint(Number.parseInt(escape.slice(1), 16));
		}
		if (/^[0-7]/.test(escape)) {
			return String.fromCodePoint(Number.parseInt(escape, 8) % 256);
		}
		return escape;
	});
}

/** InsertEdit::getSpecialCharsAndBackupFieldForInsertingMode(). */
export function getSpecialCharsForInsertingMode(column: AnalyzedColumn): SpecialChars {
	let defaultValue = column.Default;
	let realNullValue = false;
	let data: string;
	if (defaultValue === null) {
		defaultValue = '';
		realNullValue = true;
		data = '';
	} else {
		data = defaultValue;
	}

	const trueType = column.True_Type;
	let specialChars: string;
	if (trueType === 'bit') {
		specialChars = convertBitDefaultValue(defaultValue);
	} else if (trueType.startsWith('timestamp') || trueType === 'datetime' || trueType === 'time') {
		specialChars = addMicroseconds(defaultValue);
	} else if (trueType === 'binary' || trueType === 'varbinary') {
		specialChars = bin2hex(defaultValue);
	} else if (trueType.endsWith('text')) {
		const characters = [...defaultValue];
		const textDefault = characters.length > 2 ? characters.slice(1, -1).join('') : '';
		specialChars = htmlspecialchars(stripcslashes(textDefault === '' ? defaultValue : textDefault));
	} else {
		specialChars = htmlspecialchars(defaultValue);
	}

	return { realNullValue, data, specialChars, backupField: '', specialCharsEncoded: duplicateFirstNewline(specialChars) };
}

/** InsertEdit::getMaxUploadSize(); returns the "(Max: ...)" text, as upstream drops the biggest size it computes. */
export function getMaxUploadSize(trueType: string, phpMaxUploadSize: number): string {
	const maxFieldSizes: Record<string, number> = { tinyblob: 256, blob: 65536, mediumblob: 16_777_216, longblob: 4_294_967_296 };
	let size = phpMaxUploadSize;
	if (size > maxFieldSizes[trueType]) {
		size = maxFieldSizes[trueType];
	}
	return `${getFormattedMaximumUploadSize(size)}\n`;
}

/** The blob size shown next to "Binary - do not edit": Util::formatByteDown(mb_strlen(stripslashes($data)), 3, 1). */
export function protectedBlobSize(data: string): [string, string] {
	const stripped = data.replaceAll(/\\([\s\S])?/g, (_match, character: string | undefined) => {
		if (character === undefined) {
			return '';
		}
		return character === '0' ? '\0' : character;
	});
	return formatByteDown([...stripped].length, 3, 1) as [string, string];
}

/** The verificationsAfterFieldChange() handler of a field. */
export function onChangeClause(fieldHashMd5: string, jsvkey: string, pmaType: string): string {
	return `onchange="return verificationsAfterFieldChange('${escapeJsString(fieldHashMd5)}', '${escapeJsString(jsvkey)}','${pmaType}')"`;
}

/** The `type` and `decimals` data attributes of the value cell. */
export function typeAndDecimals(pmaType: string): { type: string; decimals: string | number; } {
	const type = pmaType.split('(', 1)[0];
	const match = /\([^()]+\)/.exec(pmaType);
	if (match) {
		return { type, decimals: match[0].replaceAll(/^[()]+|[()]+$/g, '') };
	}
	return { type, decimals: 0 };
}

/** InsertEdit::getHtmlForIgnoreOption(). */
export function getHtmlForIgnoreOption(rowId: number, checked = true): string {
	return `<input type="checkbox"${checked ? ' checked="checked"' : ''} name="insert_ignore_${rowId}" id="insert_ignore_${rowId}"><label for="insert_ignore_${rowId}">Ignore</label><br>\n`;
}

/** The query parameters InsertEdit::showTypeOrFunction() links carry. */
export function showTypeOrFunctionParams(which: 'function' | 'type', urlParams: Record<string, unknown>, isShow: boolean, config: EditConfig, goto: string): Record<string, unknown> {
	const params: Record<string, unknown> = {};
	if (which === 'function') {
		params.ShowFunctionFields = isShow ? 0 : 1;
		params.ShowFieldTypesInDataEditView = config.ShowFieldTypesInDataEditView;
	} else {
		params.ShowFieldTypesInDataEditView = isShow ? 0 : 1;
		params.ShowFunctionFields = config.ShowFunctionFields;
	}
	params.goto = goto;
	return { ...urlParams, ...params };
}

// --- Saving (ReplaceController) ---

export const FUNC_NO_PARAM = ['CONNECTION_ID', 'CURRENT_USER', 'CURDATE', 'CURTIME', 'CURRENT_DATE', 'CURRENT_TIME', 'DATABASE', 'LAST_INSERT_ID', 'NOW', 'PI', 'RAND', 'SYSDATE', 'UNIX_TIMESTAMP', 'USER', 'UTC_DATE', 'UTC_TIME', 'UTC_TIMESTAMP', 'UUID', 'UUID_SHORT', 'VERSION'];
export const FUNC_OPTIONAL_PARAM = ['NOW', 'RAND', 'UNIX_TIMESTAMP'];
const GIS_FROM_TEXT = ['GeomFromText', 'GeomCollFromText', 'LineFromText', 'MLineFromText', 'PointFromText', 'MPointFromText', 'PolyFromText', 'MPolyFromText'];
const GIS_FROM_WKB = ['GeomFromWKB', 'GeomCollFromWKB', 'LineFromWKB', 'MLineFromWKB', 'PointFromWKB', 'MPointFromWKB', 'PolyFromWKB', 'MPolyFromWKB'];

/** ReplaceController's $gis_from_text_functions and $gis_from_wkb_functions. */
export function gisFromFunctions(version: number): { text: string[]; wkb: string[]; } {
	if (version >= 50600) {
		return { text: GIS_FROM_TEXT.map(name => `ST_${name}`), wkb: GIS_FROM_WKB.map(name => `ST_${name}`) };
	}
	return { text: GIS_FROM_TEXT, wkb: GIS_FROM_WKB };
}

/** is_numeric() for a request string. */
function isNumeric(value: string): boolean {
	return /^[\t\n\v\f\r ]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?[\t\n\v\f\r ]*$/i.test(value);
}

export interface FunctionValueInput {
	func: string;
	salt: string | undefined;
	value: string;
	version: number;
	/** password_hash() of the value, for PHP_PASSWORD_HASH. */
	passwordHash?: string;
	/** SELECT UUID(), for UUID. */
	uuid?: string;
}

/** InsertEdit::getCurrentValueAsAnArrayForMultipleEdit(). */
export function getCurrentValueForFunction(input: FunctionValueInput): string {
	const { func, salt, value } = input;
	if (func === 'PHP_PASSWORD_HASH') {
		return `'${escapeString(input.passwordHash ?? '')}'`;
	}
	if (func === 'UUID') {
		return `'${escapeString(input.uuid ?? '')}'`;
	}
	const gis = gisFromFunctions(input.version);
	if (gis.text.includes(func) || gis.wkb.includes(func)) {
		// Without /s a value with a newline does not match, and upstream escapes the missing group as ''.
		const match = /^('?)(.*?)\1(?:,(\d+))?$/.exec(value);
		const text = match === null ? '' : match[2];
		const params = `'${escapeString(text)}${match?.[3] === undefined ? '\'' : `',${match[3]}`}`;
		return `${func}(${params})`;
	}
	if (!FUNC_NO_PARAM.includes(func) || (value !== '' && FUNC_OPTIONAL_PARAM.includes(func))) {
		const usesSalt = ['AES_ENCRYPT', 'AES_DECRYPT'].includes(func) || (['DES_ENCRYPT', 'DES_DECRYPT', 'ENCRYPT'].includes(func) && !['', '0'].includes(salt ?? ''));
		if (salt !== undefined && usesSalt) {
			return `${func}('${escapeString(value)}','${escapeString(salt)}')`;
		}
		if (func === 'NOW' && isNumeric(value) && Number(value) >= 0 && Number(value) <= 6) {
			return `${func}(${escapeString(value)})`;
		}
		return `${func}('${escapeString(value)}')`;
	}
	return `${func}()`;
}

export interface TypedValueInput {
	/** The uploaded file's content, or false without an upload. */
	uploaded: string | false;
	type: string;
	value: string;
	isAutoIncrement: boolean;
	isNull: boolean;
	/** !empty($multi_edit_columns_null_prev[$key]). */
	wasNull: boolean;
	/** isset($multi_edit_columns_null[$key]). */
	nullIsSet: boolean;
	/** The posted values of a SET column. */
	setValues: string[] | null;
	/** The current row for protected blobs, fetched only when inserting a copy of an existing row. */
	protectedRow: Record<string, string | null> | null;
	columnName: string;
}

function phpEmptyString(value: string): boolean {
	return value === '' || value === '0';
}

/** InsertEdit::getCurrentValueForDifferentTypes(). */
export function getCurrentValueForDifferentTypes(input: TypedValueInput): string {
	if (input.uploaded !== false) {
		return input.uploaded;
	}
	const { type } = input;
	let value = input.value;
	if (type !== 'protected' && type !== 'set' && value.length === 0) {
		value = input.isAutoIncrement ? 'NULL' : '\'\'';
	} else if (type === 'set') {
		value = '\'\'';
		if (input.setValues !== null && input.setValues.length > 0) {
			value = `'${escapeString(input.setValues.join(','))}'`;
		}
	} else if (type === 'protected') {
		value = '';
		const original = input.protectedRow?.[input.columnName];
		if (original !== undefined && original !== null && !phpEmptyString(original)) {
			value = `0x${bin2hex(original)}`;
		}
	} else if (type === 'hex') {
		if (!value.startsWith('0x')) {
			value = `0x${value}`;
		}
	} else if (type === 'bit') {
		value = `b'${escapeString(value.replaceAll(/[^01]/g, '0'))}'`;
	} else if (!['datetime', 'timestamp', 'date'].includes(type) || !/^current_timestamp(?:\([0-6]?\))?$/i.test(value)) {
		value = `'${escapeString(value)}'`;
	}

	if (input.isNull && (value === '\'\'' || value === '')) {
		value = 'NULL';
	}
	if (phpEmptyString(value) && input.wasNull && !input.nullIsSet) {
		value = '\'\'';
	}
	if (type === 'uuid' && !input.nullIsSet && ['\'\'', '', '\'uuid()\''].includes(value)) {
		value = 'uuid()';
	}
	return value;
}

export interface QueryValueInput {
	columnName: string;
	isInsert: boolean;
	/** The SQL for the value. */
	valueSql: string;
	/** The raw posted value. */
	value: string;
	previous: string | undefined;
	func: string | undefined;
	isNull: boolean;
	nullIsSet: boolean;
	wasNull: boolean;
	isFirstRow: boolean;
}

/** InsertEdit::getQueryValuesForInsertAndUpdateInMultipleEdit(): the value or SET item for one column, and whether it names a field. */
export function getQueryValue(input: QueryValueInput): { value: string | null; addField: boolean; } {
	const column = backquote(input.columnName);
	if (input.isInsert) {
		if (input.valueSql.length > 0) {
			return { value: input.valueSql, addField: input.isFirstRow };
		}
		return { value: null, addField: false };
	}
	if (input.wasNull && !input.nullIsSet) {
		return { value: `${column} = ${input.valueSql}`, addField: false };
	}
	const funcEmpty = input.func === undefined || phpEmptyString(input.func);
	const unchanged = funcEmpty && !input.isNull && input.previous !== undefined && input.value === input.previous;
	if (!unchanged && input.valueSql !== '' && (!input.wasNull || !input.isNull)) {
		return { value: `${column} = ${input.valueSql}`, addField: false };
	}
	return { value: null, addField: false };
}

/** InsertEdit::buildSqlQuery(). */
export function buildInsertQuery(isInsertIgnore: boolean, table: string, queryFields: string[], valueSets: string[]): string {
	return `${isInsertIgnore ? 'INSERT IGNORE ' : 'INSERT '}INTO ${backquote(table)} (${queryFields.join(', ')}) VALUES (${valueSets.join('), (')})`;
}

/** InsertEdit::getGotoInclude(); also returns $GLOBALS['table'], which a database-level goto clears. */
export function getGotoInclude(afterInsert: string | undefined, goto: string, table: string): { include: string; table: string; } {
	if (afterInsert !== undefined && ['new_insert', 'same_insert', 'edit_next'].includes(afterInsert)) {
		return { include: '/table/change', table };
	}
	let include: string | false = false;
	let currentTable = table;
	if (goto !== '' && goto !== '0') {
		if (/^[a-z_]+\.php$/.test(goto)) {
			include = goto;
		} else if (goto.includes('index.php?route=/sql')) {
			include = '/sql';
		}
		if (goto === 'index.php?route=/database/sql' && currentTable.length > 0) {
			currentTable = '';
		}
	}
	if (include === false) {
		include = currentTable.length === 0 ? '/database/sql' : '/table/sql';
	}
	return { include, table: currentTable };
}

/** The where clauses as InsertEdit::getFormParametersForInsertForm() and the continue form print them. */
export function trimmedWhereClauses(whereClauses: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(whereClauses).map(([key, clause]) => [key, phpTrim(clause)]));
}

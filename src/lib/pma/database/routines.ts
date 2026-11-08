// Pure parts of PhpMyAdmin\Database\Routines: the CREATE statement built from the editor and the queries that execute a routine.
import { isOptionEntry } from '../../../sql-parser/components/OptionsArray.ts';
import { Parser } from '../../../sql-parser/Parser.ts';
import { member } from '../../../sql-parser/php.ts';
import { TokensList } from '../../../sql-parser/TokensList.ts';
import { Routine } from '../../../sql-parser/utils/Routine.ts';
import { backquote } from '../../twig/sanitize.ts';
import { escapeString } from '../dbi-sql.ts';
import { type PhpArray, type PhpValue, phpGet } from '../table-data/php-params.ts';
import { getTypeClass } from '../table-data/types.ts';

import type { CreateStatement } from '../../../sql-parser/statements/CreateStatement.ts';

export const DIRECTIONS = ['IN', 'OUT', 'INOUT'];
export const SQL_DATA_ACCESS = ['CONTAINS SQL', 'NO SQL', 'READS SQL DATA', 'MODIFIES SQL DATA'];
export const NUMERIC_OPTIONS = ['UNSIGNED', 'ZEROFILL', 'UNSIGNED ZEROFILL'];

const NO_LENGTH_PARAM_TYPES = /^(?:DATE|TINYBLOB|TINYTEXT|BLOB|TEXT|MEDIUMBLOB|MEDIUMTEXT|LONGBLOB|LONGTEXT|SERIAL|BOOLEAN)$/i;
const NO_LENGTH_RETURN_TYPES = /^(?:DATE|DATETIME|TIME|TINYBLOB|TINYTEXT|BLOB|TEXT|MEDIUMBLOB|MEDIUMTEXT|LONGBLOB|LONGTEXT|SERIAL|BOOLEAN)$/i;

const ALIASES: Record<string, string> = {
	'BOOL': 'TINYINT',
	'BOOLEAN': 'TINYINT',
	'CHARACTER VARYING': 'VARCHAR',
	'FIXED': 'DECIMAL',
	'FLOAT4': 'FLOAT',
	'FLOAT8': 'DOUBLE',
	'INT1': 'TINYINT',
	'INT2': 'SMALLINT',
	'INT3': 'MEDIUMINT',
	'INT4': 'INT',
	'INT8': 'BIGINT',
	'LONG VARBINARY': 'MEDIUMBLOB',
	'LONG VARCHAR': 'MEDIUMTEXT',
	'LONG': 'MEDIUMTEXT',
	'MIDDLEINT': 'MEDIUMINT',
	'NUMERIC': 'DECIMAL',
};

/** Types::mapAliasToMysqlType(). */
export function mapAliasToMysqlType(alias: string): string {
	return Object.hasOwn(ALIASES, alias) ? ALIASES[alias] : alias;
}

/** Util::unQuote() with the default quote characters. */
export function unQuote(value: string): string {
	const characters = [...value];
	for (const quote of ['`', '"', '\'']) {
		if (characters.length > 1 && characters[0] === quote && characters.at(-1) === quote) {
			return characters.slice(1, -1).join('').replaceAll(quote + quote, () => quote);
		}
	}
	return value;
}

/** PHP's empty() for a request value. */
function isEmpty(value: PhpValue | null | undefined): boolean {
	if (value === undefined || value === null) {
		return true;
	}
	if (typeof value === 'string') {
		return value === '' || value === '0';
	}
	return Object.keys(value).length === 0;
}

/** A scalar request value as PHP's string conversion sees it; arrays are not expected here. */
function text(value: PhpValue | null | undefined): string {
	return typeof value === 'string' ? value : '';
}

/** The (array) cast of a request value. */
function asArray(value: PhpValue | undefined): PhpArray {
	if (value === undefined) {
		return {};
	}
	if (typeof value === 'string') {
		return { 0: value };
	}
	return value;
}

/** Util::backquoteCompat($identifier, 'NONE', $doIt); a name that keeps its backquotes can never be a reserved word. */
function definerPart(part: string): string {
	if (part.length > 1 && part.startsWith('`') && part.endsWith('`')) {
		return part;
	}
	return backquote(part);
}

/** Routines::processParamsAndBuild() without the messages, which upstream never shows (see routineQueryFromRequest). */
function buildParameters(post: PhpArray, itemType: string): string {
	const names = post.item_param_name as PhpArray;
	const types = post.item_param_type as PhpArray;
	const lengths = post.item_param_length as PhpArray;
	const directions = asArray(post.item_param_dir);
	const textOptions = asArray(post.item_param_opts_text);
	const numericOptions = asArray(post.item_param_opts_num);
	const count = Object.keys(names).length;
	let params = '';
	for (let index = 0; index < count; index++) {
		const name = phpGet(names, index);
		const type = text(phpGet(types, index));
		if (isEmpty(name) || isEmpty(type)) {
			break;
		}
		const direction = text(phpGet(directions, index));
		if (itemType === 'PROCEDURE' && DIRECTIONS.includes(direction)) {
			params += `${direction} ${backquote(name)} ${type}`;
		} else if (itemType === 'FUNCTION') {
			params += `${backquote(name)} ${type}`;
		}
		const length = text(phpGet(lengths, index));
		if (length !== '' && !NO_LENGTH_PARAM_TYPES.test(type)) {
			params += `(${length})`;
		}
		const charset = phpGet(textOptions, index);
		if (!isEmpty(charset) && getTypeClass(type) === 'CHAR' && type !== 'VARBINARY' && type !== 'BINARY') {
			params += ` CHARSET ${text(charset).toLowerCase()}`;
		}
		const numeric = phpGet(numericOptions, index);
		if (!isEmpty(numeric) && getTypeClass(type) === 'NUMBER') {
			params += ` ${text(numeric).toUpperCase()}`;
		}
		if (index !== count - 1) {
			params += ', ';
		}
	}
	return params;
}

/** Routines::processFunctionSpecificParameters(). */
function buildReturns(post: PhpArray, supportedDatatypes: string[]): string {
	const returnType = text(post.item_returntype);
	let query = '';
	if (returnType !== '' && returnType !== '0' && supportedDatatypes.includes(returnType)) {
		query += `RETURNS ${returnType}`;
	}
	if (!isEmpty(post.item_returnlength) && !NO_LENGTH_RETURN_TYPES.test(returnType)) {
		query += `(${text(post.item_returnlength)})`;
	}
	if (!isEmpty(post.item_returnopts_text) && getTypeClass(returnType) === 'CHAR') {
		query += ` CHARSET ${text(post.item_returnopts_text).toLowerCase()}`;
	}
	if (!isEmpty(post.item_returnopts_num) && getTypeClass(returnType) === 'NUMBER') {
		query += ` ${text(post.item_returnopts_num).toUpperCase()}`;
	}
	return `${query} `;
}

/**
 * Routines::getQueryFromRequest(). Its validation messages go to the global $errors, which handleRequestCreateOrEdit()
 * never reads and then overwrites, so 5.2.3 always runs the statement and shows MySQL's error instead.
 */
export function routineQueryFromRequest(post: PhpArray, supportedDatatypes: string[]): string {
	const itemType = text(post.item_type);
	const definer = text(post.item_definer);
	let query = 'CREATE ';
	if (!isEmpty(definer) && definer.includes('@')) {
		const [user, host] = definer.split('@', 2);
		query += `DEFINER=${definerPart(user)}@${definerPart(host)} `;
	}
	if (itemType === 'FUNCTION' || itemType === 'PROCEDURE') {
		query += `${itemType} `;
	}
	if (!isEmpty(post.item_name)) {
		query += backquote(text(post.item_name));
	}
	const { item_param_name: names, item_param_type: types, item_param_length: lengths } = post;
	let params = '';
	if (!isEmpty(names) && !isEmpty(types) && !isEmpty(lengths) && typeof names === 'object' && typeof types === 'object' && typeof lengths === 'object') {
		params = buildParameters(post, itemType);
	}
	query += `(${params}) `;
	if (itemType === 'FUNCTION') {
		query += buildReturns(post, supportedDatatypes);
	}
	if (!isEmpty(post.item_comment)) {
		query += `COMMENT '${escapeString(text(post.item_comment))}' `;
	}
	query += post.item_isdeterministic === undefined ? 'NOT DETERMINISTIC ' : 'DETERMINISTIC ';
	const dataAccess = text(post.item_sqldataaccess);
	if (SQL_DATA_ACCESS.includes(dataAccess)) {
		query += `${dataAccess} `;
	}
	const securityType = text(post.item_securitytype);
	if (securityType === 'DEFINER' || securityType === 'INVOKER') {
		query += `SQL SECURITY ${securityType} `;
	}
	if (!isEmpty(post.item_definition)) {
		query += text(post.item_definition);
	}
	return query;
}

/** The editor values of a routine, as Routines::getDataFromRequest() and getDataFromName() build them. */
export interface RoutineData {
	item_name: string;
	item_type: string;
	item_num_params: number;
	item_param_dir: string[];
	item_param_name: string[];
	item_param_type: string[];
	item_param_length: string[];
	item_param_length_arr?: string[][];
	item_param_opts_num: string[];
	item_param_opts_text: string[];
	[key: string]: unknown;
}

/** A request list as PHP keeps it, read by position like upstream's $array[$i]. */
function list(value: PhpValue | undefined): string[] {
	if (value === undefined || typeof value === 'string') {
		return [];
	}
	return Object.values(value).map(item => text(item));
}

/** Routines::getDataFromRequest(). */
export function routineDataFromRequest(post: PhpArray, supportedDatatypes: string[]): RoutineData {
	const data: Record<string, unknown> = {};
	for (const key of ['item_name', 'item_original_name', 'item_returnlength', 'item_returnopts_num', 'item_returnopts_text', 'item_definition', 'item_comment', 'item_definer']) {
		data[key] = post[key] ?? '';
	}
	const isFunction = post.item_type === 'FUNCTION';
	data.item_type = isFunction ? 'FUNCTION' : 'PROCEDURE';
	data.item_type_toggle = isFunction ? 'PROCEDURE' : 'FUNCTION';
	data.item_original_type = post.item_original_type === 'FUNCTION' ? 'FUNCTION' : 'PROCEDURE';
	let numParams = 0;
	let directions: string[] = [];
	let names: string[] = [];
	let types: string[] = [];
	let lengths: string[] = [];
	let numericOptions: string[] = [];
	let textOptions: string[] = [];
	const arrays = ['item_param_name', 'item_param_type', 'item_param_length', 'item_param_opts_num', 'item_param_opts_text'];
	if (arrays.every(key => typeof post[key] === 'object')) {
		if (post.item_type === 'PROCEDURE') {
			directions = list(post.item_param_dir).map(value => (DIRECTIONS.includes(value) ? value : ''));
		}
		names = list(post.item_param_name);
		types = list(post.item_param_type).map(value => (supportedDatatypes.includes(value) ? value : ''));
		lengths = list(post.item_param_length);
		numericOptions = list(post.item_param_opts_num);
		textOptions = list(post.item_param_opts_text);
		numParams = Math.max(names.length, types.length, lengths.length, numericOptions.length, textOptions.length);
	}
	Object.assign(data, {
		item_num_params: numParams,
		item_param_dir: directions,
		item_param_name: names,
		item_param_type: types,
		item_param_length: lengths,
		item_param_opts_num: numericOptions,
		item_param_opts_text: textOptions,
	});
	const returnType = text(post.item_returntype);
	data.item_returntype = supportedDatatypes.includes(returnType) ? returnType : '';
	data.item_isdeterministic = text(post.item_isdeterministic).toLowerCase() === 'on' ? ' checked=\'checked\'' : '';
	data.item_securitytype_definer = post.item_securitytype === 'DEFINER' ? ' selected=\'selected\'' : '';
	data.item_securitytype_invoker = post.item_securitytype === 'INVOKER' ? ' selected=\'selected\'' : '';
	const dataAccess = text(post.item_sqldataaccess);
	data.item_sqldataaccess = SQL_DATA_ACCESS.includes(dataAccess) ? dataAccess : '';
	return data as RoutineData;
}

/** The INFORMATION_SCHEMA.ROUTINES row Routines::getDataFromName() reads. */
export interface RoutineRow {
	SPECIFIC_NAME: string;
	ROUTINE_TYPE: string;
	DTD_IDENTIFIER: string | null;
	ROUTINE_DEFINITION: string | null;
	IS_DETERMINISTIC: string;
	SQL_DATA_ACCESS: string;
	ROUTINE_COMMENT: string;
	SECURITY_TYPE: string;
}

/** Parses SHOW CREATE output like upstream; the sql-parser Context must be loaded for the server first. */
export function parseRoutineDefinition(definition: string): CreateStatement {
	return new Parser(`DELIMITER $$\n${definition}`).statements[0] as CreateStatement;
}

/** The parameters of a routine definition, as Routine::getParameters() gives them. */
export function routineParameters(definition: string): ReturnType<typeof Routine.getParameters> {
	return Routine.getParameters(parseRoutineDefinition(definition));
}

/** Routines::getDataFromName() once the row and the SHOW CREATE definition are known. */
export function routineDataFromDefinition(row: RoutineRow, definition: string, all: boolean): RoutineData {
	const statement = parseRoutineDefinition(definition);
	// Upstream does not trust ROUTINE_DEFINITION because of a MySQL escaping issue (#15370).
	let body = TokensList.build(statement.body);
	if (body === '' || body === '0') {
		body = String(row.ROUTINE_DEFINITION ?? '');
	}
	const params = Routine.getParameters(statement);
	const data: RoutineData = {
		item_name: row.SPECIFIC_NAME,
		item_type: row.ROUTINE_TYPE,
		item_num_params: params.num,
		item_param_dir: params.dir as string[],
		item_param_name: params.name as string[],
		item_param_type: params.type as string[],
		item_param_length: params.length,
		item_param_length_arr: params.length_arr,
		item_param_opts_num: params.opts,
		item_param_opts_text: params.opts,
	};
	if (!all) {
		return data;
	}
	data.item_type_toggle = data.item_type === 'FUNCTION' ? 'PROCEDURE' : 'FUNCTION';
	data.item_returntype = '';
	data.item_returnlength = '';
	data.item_returnopts_num = '';
	data.item_returnopts_text = '';
	if (row.DTD_IDENTIFIER !== null && row.DTD_IDENTIFIER !== '' && row.DTD_IDENTIFIER !== '0' && statement.return) {
		const options = member(statement.return.options).options.values().map(option => String(isOptionEntry(option) ? option.value : option)).toArray();
		data.item_returntype = statement.return.name;
		data.item_returnlength = statement.return.parameters.join(',');
		data.item_returnopts_num = options.join(' ');
		data.item_returnopts_text = options.join(' ');
	}
	data.item_definer = statement.options?.has('DEFINER');
	data.item_definition = body;
	data.item_isdeterministic = row.IS_DETERMINISTIC === 'YES' ? ' checked=\'checked\'' : '';
	data.item_securitytype_definer = row.SECURITY_TYPE === 'DEFINER' ? ' selected=\'selected\'' : '';
	data.item_securitytype_invoker = row.SECURITY_TYPE === 'INVOKER' ? ' selected=\'selected\'' : '';
	data.item_sqldataaccess = row.SQL_DATA_ACCESS;
	data.item_comment = row.ROUTINE_COMMENT;
	return data;
}

/** Routines::getQueriesFromRoutineForm(): the statements that pass the posted values and call the routine. */
export function routineExecuteQueries(routine: RoutineData, post: PhpArray, allFunctions: string[]): string[] {
	const queries: string[] = [];
	const endQuery: string[] = [];
	const args: string[] = [];
	for (let index = 0; index < routine.item_num_params; index++) {
		const name = routine.item_param_name[index];
		const posted = phpGet(post, 'params', name);
		if (posted !== undefined) {
			// A SET parameter arrives as a list of ticked values.
			const value = escapeString(typeof posted === 'string' ? posted : Object.values(posted).map(item => text(item)).join(','));
			const func = text(phpGet(post, 'funcs', name));
			if (func !== '' && func !== '0' && allFunctions.includes(func)) {
				queries.push(`SET @p${index}=${func}('${value}');\n`);
			} else {
				queries.push(`SET @p${index}='${value}';\n`);
			}
		}
		args.push(`@p${index}`);
		const direction = routine.item_param_dir[index];
		if (routine.item_type === 'PROCEDURE' && (direction === 'OUT' || direction === 'INOUT')) {
			endQuery.push(`@p${index} AS ${backquote(name)}`);
		}
	}
	if (routine.item_type === 'PROCEDURE') {
		queries.push(`CALL ${backquote(routine.item_name)}(${args.join(', ')});\n`);
		if (endQuery.length > 0) {
			queries.push(`SELECT ${endQuery.join(', ')};\n`);
		}
	} else {
		queries.push(`SELECT ${backquote(routine.item_name)}(${args.join(', ')}) AS ${backquote(routine.item_name)};\n`);
	}
	return queries;
}

/** Whether Routines::getRow() offers a parameter dialog rather than running the routine at once. */
export function needsExecuteDialog(type: string, params: { num: number; dir: unknown[]; }): boolean {
	for (let index = 0; index < params.num; index++) {
		if (type !== 'PROCEDURE' || params.dir[index] !== 'OUT') {
			return true;
		}
	}
	return false;
}

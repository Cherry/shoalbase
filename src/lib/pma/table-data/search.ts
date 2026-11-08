// Port of PhpMyAdmin\Table\Search: the SELECT built from the table search and zoom search forms.
import { createGisData, getGisFunctions } from './gis.ts';
import { GIS_DATA_TYPES } from './insert-edit.ts';
import {
	type PhpArray,
	type PhpValue,
	phpArray,
	phpEmpty,
	phpEntries,
	phpGet,
	phpScalar,
	phpValues,
} from './php-params.ts';
import { isUnaryOperator } from './types.ts';
import { phpTrim } from '../../twig/php.ts';
import { backquote } from '../../twig/sanitize.ts';
import { escapeString } from '../dbi-sql.ts';

function listOf(value: PhpValue): string[] {
	if (typeof value === 'string') {
		return value.split(',');
	}
	return phpValues(value).map(item => (typeof item === 'string' ? item : ''));
}

function enumWhereClause(criteriaValues: PhpValue, operator: string): string {
	const values = listOf(criteriaValues);
	let func = operator;
	let open = '';
	let close = '';
	if (operator === '=' && values.length > 1) {
		func = 'IN';
		open = '(';
		close = ')';
	} else if (operator === '!=' && values.length > 1) {
		func = 'NOT IN';
		open = '(';
		close = ')';
	}
	const quoted = values.map(value => `'${escapeString(value)}'`).join(', ');
	return ` ${func} ${open}${quoted}${close}`;
}

function geomWhereClause(criteriaValues: PhpValue | undefined, name: string, operator: string, types: string, geomFunc: string, version: number): string {
	if (operator.includes('IS NULL') || operator.includes('IS NOT NULL')) {
		return `${backquote(name)} ${operator}`;
	}
	const unary = new Set(['IsEmpty', 'IsSimple', 'IsRing', 'IsClosed']);
	const functions = new Map(getGisFunctions(types, true, false, version));
	const geomFunction = functions.get(geomFunc);
	const value = typeof criteriaValues === 'string' ? criteriaValues : '';
	if ((geomFunction?.params ?? 0) > 1) {
		return `${geomFunc}(${backquote(name)}, ${createGisData(value, version)})`;
	}
	const type = geomFunction?.type ?? '';
	const applied = `${geomFunc}(${backquote(name)})`;
	if (unary.has(geomFunc) && phpTrim(value) === '') {
		return applied;
	}
	if (GIS_DATA_TYPES.includes(type) && !phpEmpty(criteriaValues)) {
		return `${applied} ${operator} ${createGisData(value, version)}`;
	}
	if (value.length > 0) {
		return `${applied} ${operator} '${value}'`;
	}
	return '';
}

/** Search::getWhereClause(). */
export function getWhereClause(criteriaValues: PhpValue | undefined, name: string, types: string, operator: string, geomFunc: string | undefined, version: number): string {
	if (geomFunc !== undefined && geomFunc !== '' && geomFunc !== '0') {
		return geomWhereClause(criteriaValues, name, operator, types, geomFunc, version);
	}
	const column = backquote(name);
	if (isUnaryOperator(operator)) {
		return `${column} ${operator}`;
	}
	if (types.slice(0, 4).toLowerCase() === 'enum' && !phpEmpty(criteriaValues)) {
		return column + enumWhereClause(criteriaValues as PhpValue, operator);
	}
	// PHP's $criteriaValues != '': null and '' are empty, an array never is.
	if (criteriaValues === undefined || criteriaValues === '') {
		return '';
	}
	const quote = /char|binary|blob|text|set|date|time|year|uuid/i.test(types) || operator.includes('LIKE') ? '\'' : '';
	let func = operator;
	let value: PhpValue = criteriaValues;
	if (func === 'LIKE %...%') {
		func = 'LIKE';
		value = `%${phpScalar(value) ?? 'Array'}%`;
	}
	if (func === 'NOT LIKE %...%') {
		func = 'NOT LIKE';
		value = `%${phpScalar(value) ?? 'Array'}%`;
	}
	if (func === 'REGEXP ^...$') {
		func = 'REGEXP';
		value = `^${phpScalar(value) ?? 'Array'}$`;
	}
	if (func !== 'IN (...)' && func !== 'NOT IN (...)' && func !== 'BETWEEN' && func !== 'NOT BETWEEN') {
		return `${column} ${func} ${quote}${escapeString(phpScalar(value) ?? '')}${quote}`;
	}
	func = func.replace(' (...)', '');
	const values = listOf(value);
	let emptyKey = -1;
	const quoted = values.map((item, index) => {
		if (item === '') {
			emptyKey = index;
			return 'NULL';
		}
		return `${quote}${escapeString(phpTrim(item))}${quote}`;
	});
	if (func === 'BETWEEN' || func === 'NOT BETWEEN') {
		return `${column} ${func} ${quoted[0] ?? ''} AND ${quoted[1] ?? ''}`;
	}
	if (emptyKey !== -1) {
		quoted.splice(emptyKey, 1);
	}
	const wheres: string[] = [];
	if (quoted.length > 0) {
		wheres.push(`${column} ${func} (${quoted.join(',')})`);
	}
	if (emptyKey !== -1) {
		wheres.push(`${column} IS NULL`);
	}
	const where = wheres.join(' OR ');
	return wheres.length > 1 ? `(${where})` : where;
}

function generateWhereClause(post: PhpArray, version: number): string {
	const custom = phpScalar(post.customWhereClause);
	if (custom !== undefined && phpTrim(custom) !== '') {
		return ` WHERE ${custom}`;
	}
	const operators = phpArray(post.criteriaColumnOperators);
	if (operators === undefined) {
		return '';
	}
	const clauses: string[] = [];
	for (const [index, rawOperator] of phpEntries(operators)) {
		const operator = typeof rawOperator === 'string' ? rawOperator : '';
		const clause = getWhereClause(
			phpGet(post, 'criteriaValues', index),
			phpScalar(phpGet(post, 'criteriaColumnNames', index)) ?? '',
			phpScalar(phpGet(post, 'criteriaColumnTypes', index)) ?? '',
			operator,
			phpScalar(phpGet(post, 'geom_func', index)),
			version,
		);
		if (clause !== '' && clause !== '0') {
			clauses.push(clause);
		}
	}
	return clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
}

/** Search::buildSqlQuery(). */
export function buildSearchQuery(post: PhpArray, version: number): string {
	let sql = 'SELECT ';
	if (post.distinct !== undefined) {
		sql += 'DISTINCT ';
	}
	if (post.zoom_submit !== undefined || !phpEmpty(post.displayAllColumns)) {
		sql += '*';
	} else {
		const columns = phpArray(post.columnsToDisplay) ?? {};
		sql += phpValues(columns).map(column => backquote(typeof column === 'string' ? column : '')).join(', ');
	}
	sql += ` FROM ${backquote(phpScalar(post.table) ?? '')}`;
	sql += generateWhereClause(post, version);
	const orderBy = phpScalar(post.orderByColumn);
	if (orderBy !== undefined && orderBy !== '--nil--') {
		sql += ` ORDER BY ${backquote(orderBy)} ${phpScalar(post.order) ?? ''}`;
	}
	return sql;
}

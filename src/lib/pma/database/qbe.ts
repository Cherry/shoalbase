// Pure parts of PhpMyAdmin\Database\Qbe: the criteria counts and the SELECT, WHERE, ORDER BY and JOIN building.
import { backquote } from '../../twig/sanitize.ts';
import { isNumericString, phpCompareStrings } from '../php-compare.ts';

/** PHP arrays with integer keys, in insertion order. */
export type IndexedValues = Map<number, string>;

/** Qbe.php declares strict_types, so a null passed to mb_strtoupper(), mb_substr() or explode() is a fatal TypeError. */
export class StrictNullError extends Error {}

function present(value: string | undefined): string {
	if (value === undefined) {
		throw new StrictNullError('null given');
	}
	return value;
}

/** PHP's empty() for a string that may be missing. */
function isEmpty(value: string | undefined): boolean {
	return value === undefined || ['', '0'].includes(value);
}

/** is_numeric() then (int) for a posted count. */
function postedInt(value: unknown, fallback: number): number {
	if (typeof value !== 'string' || !isNumericString(value)) {
		return fallback;
	}
	return Math.trunc(Number(value));
}

/** Qbe::initializeCriteriasCount(): `posted` is the column count before columns are added, which the defaults are sized by. */
export function criteriaCounts(post: Record<string, unknown>): { posted: number; columns: number; rows: number; } {
	const posted = postedInt(post.criteriaColumnCount, 3);
	const columns = Math.max(posted + postedInt(post.criteriaColumnAdd, 0), 0);
	const rows = Math.min(100, Math.max(postedInt(post.rows, 0) + postedInt(post.criteriaRowAdd, 0), 0));
	return { posted, columns, rows };
}

/** Qbe::getSelectClause(). */
export function selectClause(columnCount: number, columns: IndexedValues, shows: IndexedValues, aliases: IndexedValues): string {
	const clauses: string[] = [];
	for (let index = 0; index < columnCount; index++) {
		const column = columns.get(index);
		if (isEmpty(column) || shows.get(index) !== 'on') {
			continue;
		}
		let select = column as string;
		const alias = aliases.get(index);
		if (!isEmpty(alias)) {
			select += ` AS ${backquote(alias)}`;
		}
		clauses.push(select);
	}
	if (clauses.length === 0) {
		return '';
	}
	return `SELECT ${clauses.join(', ')}\n`;
}

export interface WhereInput {
	columnCount: number;
	rowCount: number;
	columns: IndexedValues;
	criterions: IndexedValues;
	andOrColumns: IndexedValues;
	andOrRows: IndexedValues;
	/** $_POST['Or<row>'][<column>], indexed like the posted form. */
	orValue: (row: number, column: number) => string | undefined;
}

/** Qbe::getWhereClause(). */
export function whereClause(input: WhereInput): string {
	const { columnCount, rowCount, columns, criterions, andOrColumns, andOrRows, orValue } = input;
	// The first OR value of a row reads the and/or choice of key '', which never exists.
	const glue = (index: number | undefined): string => ` ${present(index === undefined ? undefined : andOrColumns.get(index)).toUpperCase()} `;
	let where = '';
	let count = 0;
	let lastWhere: number | undefined;
	for (let index = 0; index < columnCount; index++) {
		const column = columns.get(index);
		const criterion = criterions.get(index);
		if (isEmpty(column) || isEmpty(criterion)) {
			continue;
		}
		if (lastWhere !== undefined && index > 0) {
			where += glue(lastWhere);
		}
		where += `(${column} ${criterion})`;
		lastWhere = index;
		count++;
	}
	if (count > 1) {
		where = `(${where})`;
	}
	for (let row = 0; row <= rowCount; row++) {
		let orCount = 0;
		let orWhere = '';
		let lastOrWhere: number | undefined;
		for (let index = 0; index < columnCount; index++) {
			const column = columns.get(index);
			const value = orValue(row, index);
			if (isEmpty(column) || isEmpty(value)) {
				continue;
			}
			if (index > 0) {
				orWhere += glue(lastOrWhere);
			}
			orWhere += `(${column} ${value})`;
			lastOrWhere = index;
			orCount++;
		}
		if (orCount > 1) {
			orWhere = `(${orWhere})`;
		}
		if (orWhere === '') {
			continue;
		}
		const andOr = andOrRows.get(row);
		where += `\n${andOr === undefined ? '' : `${andOr} `.toUpperCase()}${orWhere}`;
	}
	if (where !== '' && where !== '()') {
		return `WHERE ${where}\n`;
	}
	return where;
}

/** Qbe::getOrderByClause(): array_multisort() orders by sort order, then direction, then column when the lists line up. */
export function orderByClause(columnCount: number, columns: IndexedValues, sorts: IndexedValues, sortOrders: IndexedValues): string {
	let orderedColumns = columns.values().toArray();
	let orderedSorts = sorts.values().toArray();
	const sorted = sortOrders.size > 0 && sortOrders.size === sorts.size && sortOrders.size === columns.size;
	if (sorted) {
		const orders = sortOrders.values().toArray();
		const positions = orders.map((_, index) => index).toSorted((left, right) => phpCompareStrings(orders[left], orders[right])
			|| phpCompareStrings(orderedSorts[left], orderedSorts[right])
			|| phpCompareStrings(orderedColumns[left], orderedColumns[right]));
		orderedColumns = positions.map(index => orderedColumns[index]);
		orderedSorts = positions.map(index => orderedSorts[index]);
	}
	const columnAt = (index: number): string | undefined => (sorted ? orderedColumns[index] : columns.get(index));
	const sortAt = (index: number): string | undefined => (sorted ? orderedSorts[index] : sorts.get(index));
	const clauses: string[] = [];
	for (let index = 0; index < columnCount; index++) {
		const column = columnAt(index);
		const sort = sortAt(index);
		if (isEmpty(column) && isEmpty(sort)) {
			continue;
		}
		// Columns picked with the * selector cannot be sorted (bug #570698).
		if (present(column).endsWith('.*') || isEmpty(sort)) {
			continue;
		}
		clauses.push(`${column} ${sort}`);
	}
	if (clauses.length === 0) {
		return '';
	}
	return `ORDER BY ${clauses.join(', ')}\n`;
}

/** Qbe::getWhereClauseTablesAndColumns(): the tables and columns whose criteria look like "= ..." or "IS ...". */
export function whereClauseTablesAndColumns(criteria: (string | undefined)[], criteriaColumn: (index: number) => string | undefined): { tables: Map<string, string>; columns: Map<string, string>; } {
	const tables = new Map<string, string>();
	const columns = new Map<string, string>();
	for (const [index, criterion = ''] of criteria.entries()) {
		const [tablePart, columnPart] = present(criteriaColumn(index)).split('.', 2);
		if (isEmpty(tablePart) || isEmpty(columnPart) || isEmpty(criterion)) {
			continue;
		}
		if (!criterion.startsWith('=') && !criterion.toLowerCase().includes('is')) {
			continue;
		}
		const table = tablePart.replaceAll('`', '');
		const column = `${table}.${columnPart.replaceAll('`', '')}`;
		columns.set(column, column);
		tables.set(table, table);
	}
	return { tables, columns };
}

/** Relations between tables: master table, then the referenced table and its join condition. */
export type Relations = Map<string, Map<string, string>>;

/** Qbe::fillJoinClauses(): adds every table reachable through a relation to `finalized`. */
export function fillJoinClauses(finalized: Map<string, string>, relations: Relations, searchTables: string[]): void {
	for (;;) {
		let added = false;
		for (const master of searchTables) {
			for (const [foreign, clause] of relations.get(master) ?? []) {
				if (!finalized.has(master) && finalized.has(foreign)) {
					finalized.set(master, clause);
					added = true;
				} else if (!finalized.has(foreign) && finalized.has(master) && searchTables.includes(foreign)) {
					finalized.set(foreign, clause);
					added = true;
				}
				if (added && finalized.size === searchTables.length) {
					return;
				}
			}
		}
		if (!added) {
			return;
		}
	}
}

/** array_diff($searchTables, array_keys($finalized)). */
export function unfinalizedTables(searchTables: string[], finalized: Map<string, string>): string[] {
	return searchTables.filter(table => !finalized.has(table));
}

/** The JOIN part of Qbe::getJoinForFromClause() once the tables are sorted into joined and unjoined ones. */
export function joinClause(unfinalized: string[], finalized: Map<string, string>): string {
	let join = unfinalized.map(table => backquote(table)).join(', ');
	let first = true;
	for (const [table, clause] of finalized) {
		if (first) {
			if (join !== '' && join !== '0') {
				join += ', ';
			}
			join += backquote(table);
			first = false;
		} else {
			join += `\n    LEFT JOIN ${backquote(table)} ON ${clause}`;
		}
	}
	return join;
}

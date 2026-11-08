// The SQL behind Node::getData()/getPresence(), NodeDatabase and NodeTable for an information_schema server (DisableIS = false).
import { escapeString } from './dbi-sql.ts';
import { sprintf } from './sprintf.ts';
import { backquote } from '../twig/sanitize.ts';

export type DatabaseChildType = 'tables' | 'views' | 'procedures' | 'functions' | 'events';
export type TableChildType = 'columns' | 'indexes' | 'triggers';

/** Node::getWhereClause() without hide_db and only_db, which production leaves empty. */
export function databaseWhereClause(searchClause: string): string {
	let where = 'WHERE TRUE ';
	if (searchClause !== '') {
		where += `AND \`SCHEMA_NAME\` LIKE '%${escapeString(searchClause)}%' `;
	}
	return where;
}

/** Node::getDataFromInfoSchema() with grouping: whole first-level groups of databases are paged. */
export function databaseListQuery(separator: string, searchClause: string, pos: number, maxItems: number): string {
	return sprintf(
		'SELECT `SCHEMA_NAME` FROM `INFORMATION_SCHEMA`.`SCHEMATA`, (SELECT DB_first_level'
		+ ' FROM ( SELECT DISTINCT SUBSTRING_INDEX(SCHEMA_NAME, \'%1$s\', 1) DB_first_level'
		+ ' FROM INFORMATION_SCHEMA.SCHEMATA %2$s) t'
		+ ' ORDER BY DB_first_level ASC LIMIT %3$d, %4$d) t2'
		+ ' %2$sAND 1 = LOCATE(CONCAT(DB_first_level, \'%1$s\'),'
		+ ' CONCAT(SCHEMA_NAME, \'%1$s\')) ORDER BY SCHEMA_NAME ASC',
		escapeString(separator),
		databaseWhereClause(searchClause),
		pos,
		maxItems,
	);
}

/** Node::getPresence() with grouping: the number of first-level groups; the separator is not escaped upstream. */
export function databaseCountQuery(separator: string, searchClause: string): string {
	return `SELECT COUNT(*) FROM ( SELECT DISTINCT SUBSTRING_INDEX(SCHEMA_NAME, '${separator}', 1) DB_first_level FROM INFORMATION_SCHEMA.SCHEMATA ${databaseWhereClause(searchClause)}) t `;
}

/** NavigationTree::getNavigationDbPos(): the first-level page that holds the current database. */
export function databasePositionQuery(separator: string, itemsPerPage: number, database: string): string {
	return sprintf(
		'SELECT (COUNT(DB_first_level) DIV %d) * %d from (  SELECT distinct SUBSTRING_INDEX(SCHEMA_NAME,  \'%s\', 1)  DB_first_level  FROM INFORMATION_SCHEMA.SCHEMATA  WHERE `SCHEMA_NAME` < \'%s\' ) t ',
		itemsPerPage,
		itemsPerPage,
		escapeString(separator),
		escapeString(database),
	);
}

/** NodeDatabase::getWhereClauseForSearch(). */
function searchCondition(searchClause: string, singleItem: boolean, column: string): string {
	if (singleItem) {
		return `${backquote(column)} = '${escapeString(searchClause)}'`;
	}
	return `${backquote(column)} LIKE '%${escapeString(searchClause)}%'`;
}

/** NodeDatabase::getPresence(): counts tables, views, routines or events; collate is Util::getCollateForIS(). */
export function databaseChildCountQuery(type: DatabaseChildType, database: string, collate: string, searchClause: string, singleItem = false): string {
	const db = escapeString(database);
	let query: string;
	let column: string;
	if (type === 'tables' || type === 'views') {
		const condition = type === 'tables' ? 'IN' : 'NOT IN';
		query = `SELECT COUNT(*) FROM \`INFORMATION_SCHEMA\`.\`TABLES\` WHERE \`TABLE_SCHEMA\`='${db}' AND \`TABLE_TYPE\` ${condition}('BASE TABLE', 'SYSTEM VERSIONED') `;
		column = 'TABLE_NAME';
	} else if (type === 'procedures') {
		// Upstream leaves out the space before AND for procedures only.
		query = `SELECT COUNT(*) FROM \`INFORMATION_SCHEMA\`.\`ROUTINES\` WHERE \`ROUTINE_SCHEMA\` ${collate}='${db}'AND \`ROUTINE_TYPE\`='PROCEDURE' `;
		column = 'ROUTINE_NAME';
	} else if (type === 'functions') {
		query = `SELECT COUNT(*) FROM \`INFORMATION_SCHEMA\`.\`ROUTINES\` WHERE \`ROUTINE_SCHEMA\` ${collate}='${db}' AND \`ROUTINE_TYPE\`='FUNCTION' `;
		column = 'ROUTINE_NAME';
	} else {
		query = `SELECT COUNT(*) FROM \`INFORMATION_SCHEMA\`.\`EVENTS\` WHERE \`EVENT_SCHEMA\` ${collate}='${db}' `;
		column = 'EVENT_NAME';
	}
	if (searchClause !== '') {
		query += `AND ${searchCondition(searchClause, singleItem, column)}`;
	}
	return query;
}

/** NodeDatabase::getData(): the names of tables, views, routines or events, before natural sorting and paging. */
export function databaseChildListQuery(type: DatabaseChildType, database: string, collate: string, searchClause: string): string {
	const db = escapeString(database);
	let query: string;
	let column: string;
	if (type === 'tables' || type === 'views') {
		const condition = type === 'tables' ? 'IN' : 'NOT IN';
		query = `SELECT \`TABLE_NAME\` AS \`name\` FROM \`INFORMATION_SCHEMA\`.\`TABLES\` WHERE \`TABLE_SCHEMA\`='${db}' AND \`TABLE_TYPE\` ${condition}('BASE TABLE', 'SYSTEM VERSIONED') `;
		column = 'TABLE_NAME';
	} else if (type === 'events') {
		query = `SELECT \`EVENT_NAME\` AS \`name\` FROM \`INFORMATION_SCHEMA\`.\`EVENTS\` WHERE \`EVENT_SCHEMA\` ${collate}='${db}' `;
		column = 'EVENT_NAME';
	} else {
		const routineType = type === 'procedures' ? 'PROCEDURE' : 'FUNCTION';
		query = `SELECT \`ROUTINE_NAME\` AS \`name\` FROM \`INFORMATION_SCHEMA\`.\`ROUTINES\` WHERE \`ROUTINE_SCHEMA\` ${collate}='${db}'AND \`ROUTINE_TYPE\`='${routineType}' `;
		column = 'ROUTINE_NAME';
	}
	if (searchClause !== '') {
		query += `AND \`${column}\` LIKE '%${escapeString(searchClause)}%'`;
	}
	return `${query}ORDER BY \`${column}\` ASC `;
}

export function indexListQuery(database: string, table: string): string {
	return `SHOW INDEXES FROM ${backquote(table)} FROM ${backquote(database)}`;
}

/** NodeTable::getPresence(); the indexes query is counted by rows rather than COUNT(*). */
export function tableChildCountQuery(type: TableChildType, database: string, table: string, collate: string): string {
	if (type === 'columns') {
		return `SELECT COUNT(*) FROM \`INFORMATION_SCHEMA\`.\`COLUMNS\` WHERE \`TABLE_NAME\`='${escapeString(table)}' AND \`TABLE_SCHEMA\`='${escapeString(database)}'`;
	}
	if (type === 'indexes') {
		return indexListQuery(database, table);
	}
	return `SELECT COUNT(*) FROM \`INFORMATION_SCHEMA\`.\`TRIGGERS\` WHERE \`EVENT_OBJECT_SCHEMA\` ${collate}='${escapeString(database)}' AND \`EVENT_OBJECT_TABLE\` ${collate}='${escapeString(table)}'`;
}

/** NodeTable::getData() for columns and triggers, which page in SQL. */
export function tableChildListQuery(type: 'columns' | 'triggers', database: string, table: string, collate: string, pos: number, maxItems: number): string {
	if (type === 'columns') {
		return 'SELECT `COLUMN_NAME` AS `name` ,`COLUMN_KEY` AS `key` ,`DATA_TYPE` AS `type` ,`COLUMN_DEFAULT` AS `default` '
			+ ',IF (`IS_NULLABLE` = \'NO\', \'\', \'nullable\') AS `nullable` FROM `INFORMATION_SCHEMA`.`COLUMNS` '
			+ `WHERE \`TABLE_NAME\`='${escapeString(table)}' AND \`TABLE_SCHEMA\`='${escapeString(database)}' ORDER BY \`COLUMN_NAME\` ASC LIMIT ${pos}, ${maxItems}`;
	}
	return `SELECT \`TRIGGER_NAME\` AS \`name\` FROM \`INFORMATION_SCHEMA\`.\`TRIGGERS\` WHERE \`EVENT_OBJECT_SCHEMA\` ${collate}='${escapeString(database)}' AND \`EVENT_OBJECT_TABLE\` ${collate}='${escapeString(table)}' ORDER BY \`TRIGGER_NAME\` ASC LIMIT ${pos}, ${maxItems}`;
}

/** NodeTable::getData() for indexes: distinct key names, paged in PHP. */
export function pageIndexNames(keyNames: string[], pos: number, maxItems: number): string[] {
	const result: string[] = [];
	let remaining = pos;
	for (const name of keyNames) {
		if (result.includes(name)) {
			continue;
		}
		if (remaining <= 0 && result.length < maxItems) {
			result.push(name);
		}
		remaining--;
	}
	return result;
}

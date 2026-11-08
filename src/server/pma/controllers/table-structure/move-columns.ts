// Port of Controllers\Table\Structure\MoveColumnsController (route /table/structure/move-columns): reorders columns with CHANGE ... AFTER.
import { render } from './common.ts';
import { Message } from '../../../../lib/pma/message.ts';
import { nestedParams, phpArray, phpValues } from '../../../../lib/pma/table-data/php-params.ts';
import { backquote } from '../../../../lib/twig/sanitize.ts';
import {
	Context,
	CreateDefinition,
	CreateStatement,
	Parser,
} from '../../../../sql-parser/index.ts';
import { Table } from '../../core/table.ts';

import type { PmaContext } from '../../core/context.ts';

/** MoveColumnsController::generateAlterTableSql(): null when the posted order does not fit the table or changes nothing. */
function generateAlterTableSql(createTableSql: string, moveColumns: string[]): string | null {
	const statement = new Parser(createTableSql).statements[0];
	if (!(statement instanceof CreateStatement) || !Array.isArray(statement.fields)) {
		return null;
	}
	const columns = new Map<string, CreateDefinition>();
	for (const field of statement.fields as CreateDefinition[]) {
		if (field.name === null || field.isConstraint === true || field.key !== null) {
			continue;
		}
		columns.set(String(field.name), field);
	}
	const columnNames = columns.keys().toArray();
	if (columnNames.length !== moveColumns.length || columnNames.some(name => !moveColumns.includes(name))) {
		return null;
	}
	const changes: string[] = [];
	for (const [index, columnName] of moveColumns.entries()) {
		if (columnNames[index] === columnName) {
			continue;
		}
		const position = index === 0 ? ' FIRST' : ` AFTER ${backquote(columnNames[index - 1])}`;
		changes.push(`CHANGE ${backquote(columnName)} ${CreateDefinition.build(columns.get(columnName) as CreateDefinition)}${position}`);
		columnNames.splice(columnNames.indexOf(columnName), 1);
		columnNames.splice(index, 0, columnName);
	}
	if (changes.length === 0 || statement.name === null) {
		return null;
	}
	return `ALTER TABLE ${backquote(statement.name.table)}\n  ${changes.join(',\n  ')}`;
}

export async function moveColumnsController(context: PmaContext): Promise<Response> {
	const { dbi, response } = context;
	const moveColumns = phpArray(nestedParams(context.request.post).move_columns);
	if (moveColumns === undefined || !response.isAjax) {
		response.setRequestStatus(false);
		return response.response();
	}
	const columns = phpValues(moveColumns).map(value => (typeof value === 'string' ? value : ''));
	await dbi.selectDb(context.db);
	const createTableSql = await Table.get(context, context.table, context.db).showCreate();
	// The parser keywords are global state, so they are loaded right before parsing.
	Context.loadClosest(`${dbi.isMariaDB() ? 'MariaDb' : 'MySql'}${dbi.getVersion()}`);
	const sqlQuery = generateAlterTableSql(createTableSql, columns);
	if (sqlQuery === null) {
		response.setRequestStatus(false);
		return response.response();
	}
	const preview = context.request.params.preview_sql;
	if (preview !== undefined && preview !== '' && preview !== '0') {
		response.addJSON('sql_data', await render(context, 'preview_sql', { query_data: sqlQuery }));
		return response.response();
	}
	await dbi.tryQuery(sqlQuery);
	const error = dbi.getError();
	if (error !== '') {
		response.setRequestStatus(false);
		response.addJSON('message', Message.error(error));
		return response.response();
	}
	response.addJSON('message', Message.success('The columns have been moved successfully.'));
	response.addJSON('columns', columns);
	return response.response();
}

export const controllers = { 'Table/Structure/MoveColumnsController': moveColumnsController };

// Ports of Controllers\Database\MultiTableQueryController, MultiTableQuery\TablesController and QueryController.
import { render, requestString } from './common.ts';
import { postedList } from './structure-multi.ts';
import { md5 } from '../../../../lib/pma/md5.ts';
import { getFromRoute } from '../../../../lib/twig/url.ts';
import { Sql, SqlExit, parseAnalyze } from '../../display/sql.ts';

import type { PmaContext } from '../../core/context.ts';

/** Database\MultiTableQueryController: MultiTableQuery::getFormHtml() with three columns. */
export async function multiTableQueryController(context: PmaContext): Promise<Response> {
	const { db, dbi, response } = context;
	response.addScriptFiles(['database/multi_table_query.js', 'database/query_generator.js']);
	const tables = new Map<string, { hash: string; columns: string[]; }>();
	for (const table of await dbi.getTables(db)) {
		const columns = await dbi.getColumns(db, table);
		tables.set(table, { hash: md5(table), columns: columns.keys().toArray() });
	}
	response.addHTML(await render(context, 'database/multi_table_query/form', { db, tables, default_no_of_columns: 3 }));
	return response.response();
}

/** Generator::getInformationSchemaForeignKeyConstraintsRequest(). */
function foreignKeyConstraintsQuery(escapedDatabase: string, tablesCsv: string): string {
	return 'SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME'
		+ ' FROM information_schema.key_column_usage WHERE referenced_table_name IS NOT NULL'
		+ ` AND TABLE_SCHEMA = '${escapedDatabase}' AND TABLE_NAME IN (${tablesCsv}) AND REFERENCED_TABLE_NAME IN (${tablesCsv});`;
}

/** Database\MultiTableQuery\TablesController: the foreign keys between the tables picked in the query generator. */
export async function multiTableQueryTablesController(context: PmaContext): Promise<Response> {
	const { dbi, request, response } = context;
	const tables = postedList(request.query.tables).map(table => `'${dbi.escapeString(table)}'`).join(',');
	const constraints = await dbi.fetchResult(foreignKeyConstraintsQuery(dbi.escapeString(requestString(request.query.db)), tables));
	response.addJSON({ foreignKeyConstrains: constraints });
	return response.response();
}

/** Database\MultiTableQuery\QueryController: MultiTableQuery::displayResults(). */
export async function multiTableQueryQueryController(context: PmaContext): Promise<Response> {
	const { request, response } = context;
	const sqlQuery = requestString(request.post.sql_query);
	let db = requestString(request.post.db ?? request.query.db);
	[, db] = parseAnalyze(context, sqlQuery, db);
	try {
		response.addHTML(await new Sql(context).executeQueryAndSendQueryResponse({
			analyzed: null,
			isGotoFile: false,
			db,
			table: null,
			findRealEnd: null,
			extraData: null,
			messageToShow: null,
			sqlData: null,
			goto: getFromRoute(context.urlState(), '/database/multi-table-query'),
			dispQuery: null,
			dispMessage: null,
			sqlQuery,
			completeQuery: null,
		}));
	} catch (error) {
		if (!(error instanceof SqlExit)) {
			throw error;
		}
	}
	return response.response();
}

export const controllers = {
	'Database/MultiTableQueryController': multiTableQueryController,
	'Database/MultiTableQuery/TablesController': multiTableQueryTablesController,
	'Database/MultiTableQuery/QueryController': multiTableQueryQueryController,
};

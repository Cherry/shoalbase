// Query rewrites the export pages apply to the SQL query they were opened with.
import { Parser, Query, SelectStatement } from '../../../sql-parser/index.ts';

/** Table\ExportController: drops LIMIT from a SELECT and, for picked rows, swaps in a WHERE matching them. */
export function tableExportQuery(sqlQuery: string, whereClause: string[] | null): string {
	const parser = new Parser(sqlQuery);
	const statement = parser.statements[0];
	if (!(statement instanceof SelectStatement)) {
		return sqlQuery;
	}
	const replaces: [string, string][] = [];
	if (whereClause !== null && whereClause.length > 0) {
		replaces.push(['WHERE', `WHERE (${whereClause.join(') OR (')})`]);
	}
	replaces.push(['LIMIT', '']);
	return Query.replaceClauses(statement, parser.list, replaces);
}

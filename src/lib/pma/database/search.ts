// Pure parts of PhpMyAdmin\Database\Search: the criteria parsing and the queries run for each table.
import { backquote } from '../../twig/sanitize.ts';
import { isNumericString } from '../php-compare.ts';

export const SEARCH_TYPES: Record<string, string> = {
	1: 'at least one of the words',
	2: 'all of the words',
	3: 'the exact phrase as substring',
	4: 'the exact phrase as whole field',
	5: 'as regular expression',
};

/** PHP 8's loose `==` between two strings: numeric strings compare as numbers. */
function looseEquals(left: string, right: string): boolean {
	if (isNumericString(left) && isNumericString(right)) {
		return Number(left) === Number(right);
	}
	return left === right;
}

/** Search::getWhereClause() for a table's column names; the search string and column name come escaped. */
export function searchWhereClause(fields: string[], searchType: number, escapedSearchString: string, escapedColumnName?: string): string {
	const operator = searchType === 5 ? 'REGEXP' : 'LIKE';
	const wildcard = searchType < 4 ? '%' : '';
	const words = searchType > 2 ? [escapedSearchString] : escapedSearchString.split(' ');
	const clauses: string[] = [];
	for (const word of words) {
		if (word === '') {
			continue;
		}
		const perColumn: string[] = [];
		for (const field of fields) {
			if (escapedColumnName !== undefined && escapedColumnName !== '' && !looseEquals(field, escapedColumnName)) {
				continue;
			}
			perColumn.push(`CONVERT(${backquote(field)} USING utf8) ${operator} '${wildcard}${word}${wildcard}'`);
		}
		if (perColumn.length > 0) {
			clauses.push(perColumn.join(' OR '));
		}
	}
	if (clauses.length === 0) {
		// The "inside column" may exist in none of the selected tables.
		return ' WHERE FALSE';
	}
	const glue = searchType === 1 ? ' OR ' : ' AND ';
	return ` WHERE (${clauses.join(`) ${glue} (`)})`;
}

/** Search::getSearchSqls(). */
export function searchSqls(db: string, table: string, whereClause: string): { select_columns: string; select_count: string; delete: string; } {
	const from = ` FROM ${backquote(db)}.${backquote(table)}`;
	return {
		select_columns: `SELECT *${from}${whereClause}`,
		select_count: `SELECT COUNT(*) AS \`count\`${from}${whereClause}`,
		delete: `DELETE${from}${whereClause}`,
	};
}

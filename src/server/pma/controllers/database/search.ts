// Ports of Controllers\Database\SearchController and Database\Search.
import { getDbInfo, hasDatabase, render } from './common.ts';
import { postedList } from './structure-multi.ts';
import { SEARCH_TYPES, searchSqls, searchWhereClause } from '../../../../lib/pma/database/search.ts';
import { phpEmpty } from '../../../../lib/pma/server/php.ts';
import { htmlspecialchars } from '../../../../lib/twig/php.ts';

import type { PmaContext } from '../../core/context.ts';

/** Search::setSearchParams(); `submit` is false when upstream unsets $_POST['submit_search']. */
async function searchParams(context: PmaContext) {
	const { db, dbi, request } = context;
	const post = request.post;
	const tablesNamesOnly = await dbi.getTables(db);
	let submit = post.submit_search !== undefined;
	let searchType = 1;
	let description: string | undefined;
	const postedType = post.criteriaSearchType;
	if (typeof postedType === 'string' && !phpEmpty(postedType) && Object.hasOwn(SEARCH_TYPES, postedType)) {
		searchType = Number(postedType);
		description = SEARCH_TYPES[postedType];
	} else {
		submit = false;
	}
	let searchString = '';
	if (typeof post.criteriaSearchString === 'string' && !phpEmpty(post.criteriaSearchString)) {
		searchString = post.criteriaSearchString;
	} else {
		submit = false;
	}
	let tables: string[] = [];
	if (Array.isArray(post.criteriaTables) && post.criteriaTables.length > 0) {
		tables = postedList(post.criteriaTables).filter(table => tablesNamesOnly.includes(table));
	} else {
		submit = false;
	}
	let columnName: string | undefined;
	if (typeof post.criteriaColumnName === 'string' && !phpEmpty(post.criteriaColumnName)) {
		columnName = dbi.escapeString(post.criteriaColumnName);
	}
	return { tablesNamesOnly, submit, searchType, description, searchString, tables, columnName };
}

type SearchParams = Awaited<ReturnType<typeof searchParams>>;

/** Search::getSearchResults(). */
async function getSearchResults(context: PmaContext, params: SearchParams): Promise<string> {
	const { db, dbi } = context;
	let resultTotal = 0;
	const rows: Record<string, unknown>[] = [];
	for (const table of params.tables) {
		const fields = (await dbi.getColumnNames(db, table));
		const sqls = searchSqls(db, table, searchWhereClause(fields, params.searchType, dbi.escapeString(params.searchString), params.columnName));
		const count = Math.trunc(Number(await dbi.fetchValue(sqls.select_count)) || 0);
		resultTotal += count;
		rows.push({ table: htmlspecialchars(table), new_search_sqls: sqls, result_count: count });
	}
	return render(context, 'database/search/results', {
		db,
		rows,
		result_total: resultTotal,
		criteria_tables: params.tables,
		criteria_search_string: htmlspecialchars(params.searchString),
		search_type_description: params.description ?? null,
	});
}

/** Database\SearchController; UseDbSearch is on in production, so its "Access denied!" branch is not ported. */
export async function searchController(context: PmaContext): Promise<Response> {
	const { response, request } = context;
	response.addScriptFiles(['database/search.js', 'sql.js', 'makegrid.js']);
	if (!await hasDatabase(context)) {
		return response.response();
	}
	const params = await searchParams(context);
	if (!response.isAjax) {
		await getDbInfo(context, '');
	}
	if (params.submit) {
		response.addHTML(await getSearchResults(context, params));
	}
	if (response.isAjax && phpEmpty(request.params.ajax_page_request)) {
		return response.response();
	}
	response.addHTML(await render(context, 'database/search/main', {
		db: context.db,
		criteria_search_string: params.searchString,
		criteria_search_type: params.searchType,
		criteria_tables: params.tables,
		tables_names_only: params.tablesNamesOnly,
		criteria_column_name: params.columnName ?? null,
	}));
	return response.response();
}

export const controllers = {
	'Database/SearchController': searchController,
};

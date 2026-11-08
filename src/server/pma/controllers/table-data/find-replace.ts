// Port of Controllers\Table\FindReplaceController (/table/find-replace).
import { requestGoto } from './change.ts';
import {
	findDelimiter,
	pregReplace,
	previewQuery,
	regexRowsQuery,
	replaceQuery,
} from '../../../../lib/pma/table-data/find-replace.ts';
import { nestedParams, phpScalar } from '../../../../lib/pma/table-data/php-params.ts';
import { getTypeClass } from '../../../../lib/pma/table-data/types.ts';
import { getMessage } from '../../core/generator.ts';
import { withMysqlDie } from '../server/mysql-die.ts';
import { checkDbTableExists, render } from '../table-structure/common.ts';

import type { PmaContext } from '../../core/context.ts';
import type { DbiValue } from '../../core/dbi.ts';
import type { Controller, ControllerContext } from '../../dispatcher.ts';

interface ColumnInfo {
	names: string[];
	types: string[];
}

async function loadColumns(context: PmaContext): Promise<ColumnInfo> {
	const info: ColumnInfo = { names: [], types: [] };
	const columns = await context.dbi.getColumns(context.db, context.table, true);
	for (const row of columns.values()) {
		info.names.push(row.Field ?? '');
		let type = row.Type ?? '';
		if (/^set/i.test(type) || /^enum/i.test(type)) {
			type = type.replaceAll(',', ', ');
		} else {
			if (!/BINARY\(/i.test(type)) {
				type = type.replaceAll(/binary/gi, '');
			}
			type = type.replaceAll(/zerofill/gi, '').replaceAll(/unsigned/gi, '').toLowerCase();
		}
		info.types.push(type === '' || type === '0' ? '&nbsp;' : type);
	}
	return info;
}

/** FindReplaceController::getRegexReplaceRows(): [original, replaced, count] rows, or false without a usable delimiter. */
async function getRegexReplaceRows(context: PmaContext, column: string, find: string, replaceWith: string, charSet: string): Promise<DbiValue[][] | false> {
	const rows = await context.dbi.fetchResult<DbiValue[]>(regexRowsQuery(column, context.db, context.table, find, charSet), 0);
	const delimiter = findDelimiter(find);
	if (delimiter === null) {
		return false;
	}
	return rows.values().map(row => [row[0], pregReplace(`${delimiter}${find}${delimiter}`, replaceWith, row[0] ?? ''), row[2]]).toArray();
}

async function findReplace(context: ControllerContext): Promise<Response> {
	const { response, dbi } = context;
	const post = nestedParams(context.request.post);
	const info = await loadColumns(context);
	const charSet = String(await dbi.fetchValue('SELECT @@character_set_connection') ?? '');
	const missing = await checkDbTableExists(context);
	if (missing !== null) {
		return missing;
	}

	const columnIndex = phpScalar(post.columnIndex) ?? '';
	const column = info.names[Number.parseInt(columnIndex, 10)] ?? '';
	const replaceWith = phpScalar(post.replaceWith) ?? '';
	if (post.find !== undefined) {
		const find = phpScalar(post.find) ?? '';
		const useRegex = phpScalar(post.useRegex) === 'on';
		let result: DbiValue[][] | false;
		if (useRegex) {
			result = await getRegexReplaceRows(context, column, find, replaceWith, charSet);
		} else {
			const rows = await dbi.fetchResult<DbiValue[]>(previewQuery(column, context.db, context.table, find, replaceWith, charSet), 0);
			result = rows.values().toArray();
		}
		response.addJSON('preview', await render(context, 'table/find_replace/replace_preview', {
			db: context.db,
			table: context.table,
			column_index: columnIndex,
			find,
			replace_with: replaceWith,
			use_regex: useRegex,
			result,
		}));
		return response.response();
	}

	response.addScriptFiles(['table/find_replace.js']);
	if (post.replace !== undefined) {
		const find = phpScalar(post.findString) ?? '';
		const useRegex = !['', '0', undefined].includes(phpScalar(post.useRegex));
		let toReplace: [string, string | null][] | false = false;
		if (useRegex) {
			const rows = await getRegexReplaceRows(context, column, find, replaceWith, charSet);
			toReplace = rows === false ? false : rows.map(row => [row[0] ?? '', row[1]]);
		}
		const sqlQuery = replaceQuery({ column, table: context.table, find, replaceWith, useRegex, charSet, toReplace });
		await dbi.query(sqlQuery);
		response.globals.sqlQuery = sqlQuery;
		response.addHTML(await getMessage(context, 'Your SQL query has been executed successfully.', { type: 'success' }));
	}

	const types = Object.fromEntries(info.names.map((name, index) => [name, info.types[index].replace(/\(.*/s, '')]));
	response.addHTML(await render(context, 'table/find_replace/index', {
		db: context.db,
		table: context.table,
		goto: requestGoto(context),
		column_names: info.names,
		types,
		sql_types: { getTypeClass: (type: string) => getTypeClass(type) },
	}));
	return response.response();
}

export const controllers: Record<string, Controller> = {
	'Table/FindReplaceController': async context => withMysqlDie(context, async () => findReplace(context)),
};

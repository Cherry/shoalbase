// Port of Controllers\Database\DataDictionaryController without relation or transformation storage.
import { checkRequestParameters, render } from './common.ts';
import { extractColumnSpec } from '../../../../lib/pma/table-structure/column-spec.ts';
import { getIndexesFromTable } from '../../core/index.ts';
import { Table } from '../../core/table.ts';

import type { PmaContext } from '../../core/context.ts';

export async function dataDictionaryController(context: PmaContext): Promise<Response> {
	const { db, dbi, response } = context;
	const missing = await checkRequestParameters(context, ['db']);
	if (missing !== null) {
		return missing;
	}
	await dbi.selectDb(db);
	const tables = new Map<string, Record<string, unknown>>();
	for (const tableName of await dbi.getTables(db)) {
		const comment = String(await Table.get(context, tableName, db).getStatusInfo('TABLE_COMMENT') || '');
		const primaryKeys = new Set<string>();
		for (const row of await dbi.getTableIndexes(db, tableName)) {
			if (row.Key_name === 'PRIMARY') {
				primaryKeys.add(String(row.Column_name));
			}
		}
		const columns = await dbi.getColumns(db, tableName, true);
		const rows = new Map<string, Record<string, unknown>>();
		for (const column of columns.values()) {
			const field = String(column.Field);
			const spec = extractColumnSpec(String(column.Type ?? ''));
			rows.set(field, {
				name: field,
				has_primary_key: primaryKeys.has(field),
				type: spec.type,
				print_type: spec.print_type,
				is_nullable: column.Null !== '' && column.Null !== 'NO',
				default: column.Default ?? null,
				// Relation::getComments() keeps only non-empty native column comments.
				comment: column.Comment || '',
				mime: '',
				relation: '',
			});
		}
		const indexes = await getIndexesFromTable(context, tableName, db);
		tables.set(tableName, {
			name: tableName,
			comment,
			has_relation: false,
			has_mime: false,
			columns: rows,
			indexes: indexes.values().toArray(),
		});
	}
	response.addHTML(await render(context, 'database/data_dictionary/index', { database: db, comment: '', tables }));
	return response.response();
}

export const controllers = {
	'Database/DataDictionaryController': dataDictionaryController,
};

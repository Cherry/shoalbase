// Port of Controllers\Table\StructureController (route /table/structure): columns, indexes, partitions and space usage.
import {
	RELATION_PARAMETERS,
	checkDbTableExists,
	getColumnsWithIndex,
	getPartitionNames,
	getPartitions,
	havePartitioning,
	isForeignKeySupported,
	render,
} from './common.ts';
import { isSystemSchema } from '../../../../lib/pma/dbi-sql.ts';
import { FlashMessages } from '../../../../lib/pma/flash-messages.ts';
import {
	INDEX_FULLTEXT,
	INDEX_INDEX,
	INDEX_SPATIAL,
	INDEX_UNIQUE,
} from '../../../../lib/pma/index.ts';
import { extractColumnSpec } from '../../../../lib/pma/table-structure/column-spec.ts';
import { tableStatSizes } from '../../../../lib/pma/table-structure/table-stats.ts';
import { getImage } from '../../../../lib/twig/html.ts';
import { toTwigValue } from '../../../../lib/twig/values.ts';
import { findCollationByName } from '../../core/charsets.ts';
import { findDuplicates, getIndexesFromTable, getPrimaryIndex } from '../../core/index.ts';
import { getPageSettings } from '../../core/page-settings.ts';
import { Table } from '../../core/table.ts';

import type { PmaContext } from '../../core/context.ts';
import type { DbiRow } from '../../core/dbi.ts';

interface TableInfo {
	isView: boolean;
	storageEngine: string;
	collation: string;
	numRows: number;
	status: DbiRow | null;
}

/** StructureController::getTableStats(). */
async function getTableStats(context: PmaContext, table: Table, info: TableInfo, systemSchema: boolean): Promise<string> {
	const status = info.status ?? await table.getStatus(true);
	const sizes = tableStatSizes(status, info.numRows, await table.isMerge());
	const filePerTable = await context.dbi.fetchValue('SHOW GLOBAL VARIABLES LIKE \'innodb_file_per_table\';', 1);
	let tableCollation: Record<string, string> | [] = [];
	const collation = await findCollationByName(context, info.collation);
	if (collation !== null) {
		tableCollation = { name: collation.getName(), description: collation.getDescription() };
	}
	return render(context, 'table/structure/display_table_stats', {
		db: context.db,
		table: context.table,
		...sizes,
		table_info_num_rows: info.numRows,
		tbl_is_view: info.isView,
		db_is_system_schema: systemSchema,
		tbl_storage_engine: info.storageEngine,
		table_collation: tableCollation,
		mergetable: await table.isMerge(),
		innodb_file_per_table: filePerTable === 'ON',
	});
}

/** StructureController::displayStructure(). */
async function displayStructure(context: PmaContext, table: Table, info: TableInfo, fields: Map<string, DbiRow>, columnsWithIndex: string[], systemSchema: boolean, flash: FlashMessages): Promise<string> {
	const { config, dbi, db } = context;
	const primary = await getPrimaryIndex(context, context.table, db);
	const commentsMap: Record<string, string> = {};
	if (config.ShowPropertyComments) {
		const columns = await dbi.getColumns(db, context.table, true);
		for (const column of columns.values()) {
			const comment = column.Comment ?? '';
			if (comment !== '' && comment !== '0') {
				commentsMap[column.Field ?? ''] = comment;
			}
		}
	}
	let tableStats: string | null = null;
	if (config.ShowStats) {
		tableStats = await getTableStats(context, table, info, systemSchema);
		context.response.addJSON('tableStat', tableStats);
	}

	const columnsList: string[] = [];
	// PHP arrays keyed by row number; Maps keep the integer keys Twig looks them up by.
	const attributes = new Map<number, string>();
	const displayedFields = new Map<number, Map<string, string>>();
	const rowComments = new Map<number, string>();
	const extractedColumnspecs = new Map<number, Map<string, unknown>>();
	const collations: Record<string, { name: string; description: string; }> = {};
	let rownum = 0;
	for (const field of fields.values()) {
		rownum++;
		const name = field.Field ?? '';
		columnsList.push(name);
		const spec = extractColumnSpec(field.Type ?? '', config.LimitChars);
		extractedColumnspecs.set(rownum, toTwigValue(spec) as Map<string, unknown>);
		attributes.set(rownum, spec.attribute);
		if ((field.Extra ?? '').includes('on update CURRENT_TIMESTAMP')) {
			attributes.set(rownum, 'on update CURRENT_TIMESTAMP');
		}
		let icon = '';
		const displayed = new Map<string, string>([['text', name]]);
		rowComments.set(rownum, '');
		if (commentsMap[name] !== undefined) {
			displayed.set('comment', commentsMap[name]);
			rowComments.set(rownum, commentsMap[name]);
		}
		if (primary !== false && primary.hasColumn(name)) {
			icon += getImage('b_primary', 'Primary');
		}
		if (columnsWithIndex.includes(name)) {
			icon += getImage('bd_primary', 'Index');
		}
		displayed.set('icon', icon);
		displayedFields.set(rownum, displayed);
		const collation = await findCollationByName(context, field.Collation ?? '');
		if (collation !== null) {
			collations[collation.getName()] = { name: collation.getName(), description: collation.getDescription() };
		}
	}

	const engine = await table.getStorageEngine();
	const partitioning = await havePartitioning(context);
	return render(context, 'table/structure/display_structure', {
		collations,
		is_foreign_key_supported: await isForeignKeySupported(context, engine),
		indexes: await getIndexesFromTable(context, context.table, db),
		indexes_duplicates: await findDuplicates(context, context.table, db),
		relation_parameters: RELATION_PARAMETERS,
		hide_structure_actions: config.HideStructureActions === true,
		db,
		table: context.table,
		db_is_system_schema: systemSchema,
		tbl_is_view: info.isView,
		mime_map: [],
		tbl_storage_engine: info.storageEngine,
		primary,
		columns_list: columnsList,
		table_stats: tableStats,
		fields: fields.values().toArray(),
		extracted_columnspecs: extractedColumnspecs,
		columns_with_index: columnsWithIndex,
		central_list: [],
		comments_map: commentsMap,
		browse_mime: config.BrowseMIME,
		show_column_comments: config.ShowColumnComments,
		show_stats: config.ShowStats,
		mysql_int_version: dbi.getVersion(),
		is_mariadb: dbi.isMariaDB(),
		text_dir: 'ltr',
		is_active: false,
		have_partitioning: partitioning,
		partitions: await getPartitions(context, db, context.table),
		partition_names: await getPartitionNames(context, db, context.table),
		default_sliders_state: config.InitialSlidersState,
		attributes,
		displayed_fields: displayedFields,
		row_comments: rowComments,
		route: context.route,
	}, { flashMessages: flash.getMessages() });
}

export async function structureController(context: PmaContext): Promise<Response> {
	const { dbi, response } = context;
	const flash = new FlashMessages(context.session.data);
	const table = Table.get(context, context.table, context.db);
	await dbi.selectDb(context.db);
	const status = await table.getStatus(true);
	const isView = await table.isView();
	const info: TableInfo = {
		isView,
		storageEngine: isView ? 'View' : await table.getStorageEngine(),
		collation: await table.getCollation(),
		numRows: await table.getNumRows(),
		status,
	};

	const pageSettings = await getPageSettings(context, 'TableStructure');
	if (pageSettings.saved) {
		return response.response();
	}
	response.addHTML(pageSettings.errorHtml);
	response.addHTML(pageSettings.html);
	await dbi.getUserPrivileges();
	response.addScriptFiles(['table/structure.js', 'indexes.js']);

	const systemSchema = isSystemSchema(context.db);
	const missing = await checkDbTableExists(context);
	if (missing !== null) {
		return missing;
	}
	const columnsWithIndex = await getColumnsWithIndex(context, context.table, context.db, INDEX_UNIQUE | INDEX_INDEX | INDEX_SPATIAL | INDEX_FULLTEXT);
	const fields = await dbi.getColumns(context.db, context.table, true);
	response.addHTML(await displayStructure(context, table, info, fields, columnsWithIndex, systemSchema, flash));
	return response.response();
}

export const controllers = { 'Table/StructureController': structureController };

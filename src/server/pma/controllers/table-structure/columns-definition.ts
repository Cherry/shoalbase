// Port of Table\ColumnsDefinition::displayForm(): the column editor shared by create table, add columns and change columns.
import { RELATION_PARAMETERS, havePartitioning } from './common.ts';
import { escapeString, getColumnsSql } from '../../../../lib/pma/dbi-sql.ts';
import { nestedParams } from '../../../../lib/pma/table-data/php-params.ts';
import {
	type ColumnMeta,
	contentCell,
	decorateColumnMetaDefault,
	regeneratedColumnMeta,
	valueByKey,
} from '../../../../lib/pma/table-structure/columns-definition.ts';
import { getPartitionDetails } from '../../../../lib/pma/table-structure/partition-definition.ts';
import {
	type ServerKind,
	getAttributes,
	isIntegersLengthRestricted,
	isVirtualColumnsSupported,
	supportsStoredKeywordForVirtualColumns,
} from '../../../../lib/pma/table-structure/types.ts';
import { getFromRoute } from '../../../../lib/twig/url.ts';
import { getCharsets, getCollations } from '../../core/charsets.ts';
import { getIndexesFromTable } from '../../core/index.ts';
import { getStorageEngineArray } from '../../core/storage-engine.ts';
import { Table } from '../../core/table.ts';

import type { PmaContext } from '../../core/context.ts';
import type { DbiRow } from '../../core/dbi.ts';

/** Util::getServerType() and the version, for the Types and Compatibility helpers. */
export function serverKind(context: PmaContext): ServerKind {
	const { dbi } = context;
	let type: ServerKind['type'] = 'MySQL';
	if (dbi.isMariaDB()) {
		type = 'MariaDB';
	} else if (dbi.isPercona()) {
		type = 'Percona Server';
	}
	return { type, version: dbi.getVersion() };
}

/** DatabaseInterface::attachIndexInfoToColumns(): later columns of a multi-column index get a Key too. */
async function attachIndexInfo(context: PmaContext, db: string, table: string, fields: Map<string, DbiRow>): Promise<Map<string, DbiRow>> {
	if (fields.size === 0) {
		return fields;
	}
	const indexes = await getIndexesFromTable(context, table, db);
	for (const [name, field] of fields) {
		if (field.Key !== null && field.Key !== undefined && field.Key !== '' && field.Key !== '0') {
			continue;
		}
		for (const index of indexes.values()) {
			const column = index.getColumns().get(name);
			if (column === undefined || Number(column.getSeqInIndex()) <= 1) {
				continue;
			}
			field.Key = index.isUnique() ? 'UNI' : 'MUL';
		}
	}
	return fields;
}

/** DatabaseInterface::getColumn(): one column's SHOW [FULL] COLUMNS row, or null. */
export async function getColumn(context: PmaContext, db: string, table: string, column: string, full = false): Promise<DbiRow | null> {
	const sql = getColumnsSql(db, table, context.dbi.escapeMysqlLikeString(column), full);
	const fields = await attachIndexInfo(context, db, table, await context.dbi.fetchResult(sql, 'Field') as Map<string, DbiRow>);
	return fields.values().next().value ?? null;
}

/** Table::getColumnGenerationExpression() for one column, via information_schema on MySQL. */
async function generationExpression(context: PmaContext, db: string, table: string, column: string): Promise<string | null> {
	const { dbi } = context;
	if (!dbi.isMariaDB() && dbi.getVersion() > 50705) {
		const sql = `SELECT
                \`COLUMN_NAME\` AS \`Field\`,
                \`GENERATION_EXPRESSION\` AS \`Expression\`
                FROM
                \`information_schema\`.\`COLUMNS\`
                WHERE
                \`TABLE_SCHEMA\` = '${escapeString(db)}'
                AND \`TABLE_NAME\` = '${escapeString(table)}' AND  \`COLUMN_NAME\` = '${escapeString(column)}'`;
		const expressions = await dbi.fetchResult(sql, 'Field', 'Expression') as Map<string, string | null>;
		return expressions.get(column) ?? null;
	}
	const { Parser, CreateStatement, Table: TableUtils } = await import('../../../../sql-parser/index.ts');
	const create = await Table.get(context, table, db).showCreate();
	if (create === '') {
		return null;
	}
	const statement = new Parser(create).statements[0];
	if (!(statement instanceof CreateStatement)) {
		return '';
	}
	const fields = TableUtils.getFields(statement) as Record<string, { expr?: string; }>;
	const expression = fields[column]?.expr;
	return expression === undefined ? '' : expression.slice(1, -1);
}

export interface ColumnsFormOptions {
	action: string;
	numFields: number;
	regenerate?: boolean;
	selected?: string[] | null;
	fieldsMeta?: DbiRow[] | null;
}

const VIRTUAL_EXTRAS = new Set(['VIRTUAL', 'PERSISTENT', 'VIRTUAL GENERATED', 'STORED GENERATED']);

/** ColumnsDefinition::displayForm(): the column_definitions_form.twig variables. */
export async function columnsFormData(context: PmaContext, options: ColumnsFormOptions): Promise<Record<string, unknown>> {
	const { config, dbi, db, table } = context;
	const post = nestedParams(context.request.post);
	const url = context.urlState();
	const createAction = getFromRoute(url, '/table/create');
	const addFieldAction = getFromRoute(url, '/table/add-field');
	const { action, numFields, fieldsMeta = null } = options;

	let formParams: Record<string, unknown> = { db };
	if (action === createAction) {
		formParams.reload = 1;
	} else {
		if (action === addFieldAction) {
			formParams.field_where = valueByKey(post, 'field_where');
			if (post.field_where !== undefined) {
				formParams.after_field = String(post.after_field ?? '');
			}
		}
		formParams.table = table;
	}
	formParams.orig_num_fields = numFields;
	formParams.orig_field_where = valueByKey(post, 'field_where');
	formParams.orig_after_field = valueByKey(post, 'after_field');
	if (Array.isArray(options.selected)) {
		for (const [index, value] of options.selected.entries()) {
			formParams[`selected[${index}]`] = value;
		}
	}
	const isBackup = action !== createAction && action !== addFieldAction;

	const commentsMap: Record<string, unknown> = {};
	if (table !== '') {
		const columns = await dbi.getColumns(db, table, true);
		for (const column of columns.values()) {
			const comment = column.Comment ?? '';
			if (comment !== '' && comment !== '0') {
				commentsMap[column.Field ?? ''] = comment;
			}
		}
	}
	let moveColumns: unknown[] = [];
	if (fieldsMeta !== null) {
		moveColumns = await Table.get(context, table, db).getColumnsMeta();
	}

	let regenerate = options.regenerate === true;
	if (post.submit_num_fields !== undefined || post.submit_partition_change !== undefined) {
		regenerate = true;
	}

	const contentCells: Record<string, unknown>[] = [];
	for (let column = 0; column < numFields; column++) {
		let meta: ColumnMeta = {};
		let length = '';
		let submitAttribute: unknown = null;
		if (regenerate) {
			meta = regeneratedColumnMeta(post, column);
			const typed = valueByKey(post, `field_length.${column}`, '');
			length = typeof typed === 'string' ? typed : '';
			submitAttribute = valueByKey(post, `field_attribute.${column}`, null) ?? false;
			commentsMap[String(meta.Field)] = valueByKey(post, `field_comments.${column}`);
		} else if (fieldsMeta?.[column] !== undefined) {
			meta = { ...fieldsMeta[column] };
			if (VIRTUAL_EXTRAS.has(String(meta.Extra))) {
				meta.Expression = await generationExpression(context, db, table, String(meta.Field));
			}
			meta = { ...meta, ...decorateColumnMetaDefault(meta) };
		}
		const cell = contentCell({ columnNumber: column, meta, length, isBackup, limitChars: config.LimitChars });
		formParams = { ...formParams, ...cell.backupParams };
		contentCells.push({
			column_number: column,
			column_meta: cell.meta,
			type_upper: cell.typeUpper,
			default_value: cell.defaultValue,
			length_values_input_size: 8,
			length: cell.length,
			extracted_columnspec: cell.extractedColumnspec,
			submit_attribute: submitAttribute,
			comments_map: commentsMap,
			fields_meta: fieldsMeta,
			is_backup: isBackup,
			move_columns: moveColumns,
			available_mime: [],
			mime_map: [],
		});
	}

	const charsets = await getCharsets(context);
	const collations = await getCollations(context);
	const charsetsList = charsets.values().map((charset) => {
		return {
			name: charset.getName(),
			description: charset.getDescription(),
			collations: (collations.get(charset.getName()) ?? new Map()).values().map((collation) => { return { name: collation.getName(), description: collation.getDescription() }; }).toArray(),
		};
	}).toArray();
	const server = serverKind(context);
	const privileges = await dbi.getUserPrivileges();
	const storageEngines = await getStorageEngineArray(context);
	const scalar = (name: string): unknown => post[name] ?? null;
	return {
		is_backup: isBackup,
		fields_meta: fieldsMeta,
		relation_parameters: RELATION_PARAMETERS,
		action,
		form_params: formParams,
		content_cells: contentCells,
		partition_details: getPartitionDetails(post),
		primary_indexes: scalar('primary_indexes'),
		unique_indexes: scalar('unique_indexes'),
		indexes: scalar('indexes'),
		fulltext_indexes: scalar('fulltext_indexes'),
		spatial_indexes: scalar('spatial_indexes'),
		table: scalar('table'),
		comment: scalar('comment'),
		tbl_collation: scalar('tbl_collation'),
		charsets: charsetsList,
		tbl_storage_engine: scalar('tbl_storage_engine'),
		storage_engines: storageEngines.values().toArray(),
		connection: scalar('connection'),
		change_column: context.request.post.change_column ?? context.request.query.change_column ?? null,
		is_virtual_columns_supported: isVirtualColumnsSupported(server),
		is_integers_length_restricted: isIntegersLengthRestricted(server),
		browse_mime: config.BrowseMIME,
		supports_stored_keyword: supportsStoredKeywordForVirtualColumns(server),
		server_version: dbi.getVersion(),
		max_rows: Math.trunc(Number(config.MaxRows)),
		char_editing: config.CharEditing,
		attribute_types: getAttributes(server),
		privs_available: privileges.colPriv && privileges.isReloadPriv,
		max_length: dbi.getVersion() >= 50503 ? 1024 : 255,
		have_partitioning: await havePartitioning(context),
		disable_is: config.Server.DisableIS,
	};
}

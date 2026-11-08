// Port of Controllers\Table\RelationController (route /table/relation) without configuration storage: only foreign key constraints.
import {
	RELATION_PARAMETERS,
	isForeignKeySupported,
	mysqlDieHtmlFor,
	render,
} from './common.ts';
import { FlashMessages } from '../../../../lib/pma/flash-messages.ts';
import { md5 } from '../../../../lib/pma/md5.ts';
import { Message } from '../../../../lib/pma/message.ts';
import { strnatcasecmp } from '../../../../lib/pma/php-compare.ts';
import {
	type PhpArray,
	type PhpValue,
	nestedParams,
	phpArray,
	phpEntries,
} from '../../../../lib/pma/table-data/php-params.ts';
import {
	type ExistingForeignKey,
	FOREIGN_KEY_ACTIONS,
	planForeignKeyUpdate,
	relationColumnArray,
	tablesWithEngine,
} from '../../../../lib/pma/table-structure/relation.ts';
import { formatSql } from '../../../../lib/pma/table-structure/sql-format.ts';
import { backquote } from '../../../../lib/twig/sanitize.ts';
import { generatorState, getMessage, showMySQLDocumentation } from '../../core/generator.ts';
import { getPrimaryIndex } from '../../core/index.ts';
import { Table } from '../../core/table.ts';
import { withMysqlDie } from '../server/mysql-die.ts';
import { getForeigners } from '../table-data/relation.ts';


import type { PmaContext } from '../../core/context.ts';
import type { DbiRow } from '../../core/dbi.ts';

const text = (value: PhpValue | undefined): string => (typeof value === 'string' ? value : '');

// A PHP list read from a posted array, keeping its keys.
function listOf(value: PhpValue | undefined): Map<string, string> {
	const array = phpArray(value);
	return new Map(array === undefined ? [] : phpEntries(array).map(([key, item]): [string, string] => [key, text(item)]));
}

/** Template-callable result of table_get(): the unique columns the foreign column dropdowns list. */
class ForeignTable {
	constructor(private readonly uniqueColumns: string[]) {}

	getUniqueColumns(): string[] {
		return this.uniqueColumns;
	}
}

/** Relation::getTables(). */
async function getTables(context: PmaContext, db: string, storageEngine: string): Promise<string[]> {
	const result = await context.dbi.query(`SHOW TABLE STATUS FROM ${backquote(db)}`);
	const rows = result.fetchAllAssoc();
	return tablesWithEngine(rows.map((row: DbiRow) => Object.values(row)), storageEngine, context.config.NaturalOrder);
}

/** RelationController::getDropdownValueForTable(). */
async function dropdownValuesForTable(context: PmaContext, post: PhpArray): Promise<void> {
	const foreignTable = text(post.foreignTable);
	const foreignDb = text(post.foreignDb);
	const table = Table.get(context, foreignTable, foreignDb);
	const columns = await table.isView() ? await table.getColumns(false, false) : await table.getIndexedColumns(false, false);
	if (context.config.NaturalOrder) {
		columns.sort(strnatcasecmp);
	}
	context.response.addJSON('columns', columns);
	const primary = await getPrimaryIndex(context, foreignTable, foreignDb);
	if (primary !== false) {
		context.response.addJSON('primary', primary.getColumns().keys().toArray());
	}
}

/** RelationController::getDropdownValueForDatabase(). */
async function dropdownValuesForDatabase(context: PmaContext, post: PhpArray, storageEngine: string): Promise<void> {
	const foreignDb = backquote(text(post.foreignDb));
	let tables: string[];
	if (post.foreign === 'true') {
		const result = await context.dbi.query(`SHOW TABLE STATUS FROM ${foreignDb}`);
		const rows = result.fetchAllAssoc();
		tables = rows.filter((row: DbiRow) => row.Engine !== undefined && row.Engine !== null && row.Engine.toUpperCase() === storageEngine).map(row => row.Name ?? '');
	} else {
		const result = await context.dbi.query(`SHOW TABLES FROM ${foreignDb}`);
		tables = result.fetchAllColumn().map(value => value ?? '');
	}
	if (context.config.NaturalOrder) {
		tables.sort(strnatcasecmp);
	}
	context.response.addJSON('tables', tables);
}

/** RelationController::updateForForeignKeys() through Table::updateForeignKeys(); returns false when it previewed the SQL. */
async function updateForeignKeys(context: PmaContext, post: PhpArray, existing: ExistingForeignKey[]): Promise<boolean> {
	const { dbi, response } = context;
	const destinationDbs = phpArray(post.destination_foreign_db);
	const preview = post.preview_sql !== undefined;
	let html = '';
	let previewSql = '';
	let displayQuery = '';
	let seenError = false;
	if (destinationDbs !== undefined && post.destination_foreign_table !== undefined && post.destination_foreign_column !== undefined) {
		for (const [index, foreignDb] of phpEntries(destinationDbs)) {
			const row = {
				foreignDb: text(foreignDb),
				foreignTable: text(phpArray(post.destination_foreign_table)?.[index]),
				fields: listOf(phpArray(post.foreign_key_fields_name)?.[index]),
				foreignFields: listOf(phpArray(post.destination_foreign_column)?.[index]),
				constraintName: text(phpArray(post.constraint_name)?.[index]),
				onDelete: text(phpArray(post.on_delete)?.[index]),
				onUpdate: text(phpArray(post.on_update)?.[index]),
			};
			const plan = planForeignKeyUpdate(context.table, context.db, row, existing[Number(index)]);
			if (plan.drop !== null) {
				if (preview) {
					previewSql += `${plan.drop}\n`;
				} else {
					displayQuery += `${plan.drop}\n`;
					await dbi.tryQuery(plan.drop);
					const error = dbi.getError();
					if (error !== '') {
						seenError = true;
						html += mysqlDieHtmlFor(context, error, plan.drop, false);
						continue;
					}
				}
			}
			if (plan.create === null) {
				continue;
			}
			let createError = '';
			if (preview) {
				previewSql += `${plan.create}\n`;
			} else {
				displayQuery += `${plan.create}\n`;
				await dbi.tryQuery(plan.create);
				createError = dbi.getError();
				if (createError !== '') {
					seenError = true;
					if (createError.slice(1, 5) === '1005') {
						const message = Message.error('Error creating foreign key on %1$s (check data types)');
						message.addParam(plan.fields.join(', '));
						html += message.getDisplay();
					} else {
						html += mysqlDieHtmlFor(context, createError, plan.create, false);
					}
					html += `${showMySQLDocumentation(generatorState(context), 'create-table-foreign-keys')}\n`;
				}
			}
			if (plan.recreate === null || createError === '') {
				continue;
			}
			if (preview) {
				previewSql += plan.recreate;
			} else {
				displayQuery += `${plan.recreate}\n`;
				await dbi.tryQuery(plan.recreate);
			}
		}
		response.addHTML(html);
	}
	if (preview) {
		// Core::previewSQL() followed by exit.
		response.addJSON('sql_data', `<div class="preview_sql">${previewSql === '' ? 'No change' : formatSql(previewSql)}</div>`);
		return false;
	}
	if (displayQuery !== '' && !seenError) {
		response.globals.displayQuery = displayQuery;
		response.addHTML(await getMessage(context, 'Your SQL query has been executed successfully.', { type: 'success' }));
	}
	return true;
}

/** Relation::getForeigners($db, $table, '', 'foreign')['foreign_keys_data']. */
async function existingForeignKeys(context: PmaContext): Promise<ExistingForeignKey[]> {
	const foreigners = await getForeigners(context, context.db, context.table, 'foreign');
	return foreigners.foreign_keys_data as ExistingForeignKey[] | undefined ?? [];
}

export async function relationController(context: PmaContext): Promise<Response> {
	const { config, dbi, response } = context;
	const post = nestedParams(context.request.post);
	const table = Table.get(context, context.table, context.db);
	const engineInfo = await table.getStatusInfo('Engine');
	const storageEngine = (typeof engineInfo === 'string' ? engineInfo : '').toUpperCase();
	const fkSupported = await isForeignKeySupported(context, storageEngine);
	let foreignKeys: ExistingForeignKey[] = [];
	if (fkSupported) {
		foreignKeys = await existingForeignKeys(context);
	}
	if (post.getDropdownValues === 'true') {
		if (post.foreignTable === undefined) {
			await dropdownValuesForDatabase(context, post, storageEngine);
		} else {
			await dropdownValuesForTable(context, post);
		}
		return response.response();
	}
	response.addScriptFiles(['table/relation.js', 'indexes.js']);
	await dbi.selectDb(context.db);
	if (!await updateForeignKeys(context, post, foreignKeys)) {
		return response.response();
	}
	if (post.destination_foreign_db !== undefined && fkSupported) {
		foreignKeys = await existingForeignKeys(context);
	}

	const columnMap = await dbi.getColumns(context.db, context.table);
	const columns = columnMap.values().toArray();
	const columnHashes: Record<string, string> = {};
	for (const column of columns) {
		columnHashes[column.Field ?? ''] = md5(column.Field ?? '');
	}
	const engine = await table.getStorageEngine();
	const tablesByDb = new Map<string, string[]>();
	const flash = new FlashMessages(context.session.data);
	const functionOverrides = {
		get_tables: async (db: unknown, tableEngine: unknown) => {
			const key = `${String(db)}\0${String(tableEngine)}`;
			if (!tablesByDb.has(key)) {
				tablesByDb.set(key, await getTables(context, String(db), String(tableEngine)));
			}
			return tablesByDb.get(key);
		},
		table_get: async (tableName: unknown, dbName: unknown) => new ForeignTable(await Table.get(context, String(tableName), String(dbName)).getUniqueColumns(false, false)),
	};
	response.addHTML(await render(context, 'table/relation/common_form', {
		is_foreign_key_supported: await isForeignKeySupported(context, engine),
		db: context.db,
		table: context.table,
		relation_parameters: RELATION_PARAMETERS,
		tbl_storage_engine: storageEngine,
		existrel: [],
		existrel_foreign: foreignKeys,
		options_array: FOREIGN_KEY_ACTIONS,
		column_array: relationColumnArray(columns, storageEngine, config.NaturalOrder),
		column_hash_array: columnHashes,
		save_row: columns,
		url_params: [],
		databases: await dbi.getDatabaseList(),
		default_sliders_state: config.InitialSlidersState,
		route: context.route,
	}, { flashMessages: flash.getMessages(), functionOverrides }));
	return response.response();
}

export const controllers = { 'Table/RelationController': async (context: PmaContext) => withMysqlDie(context, async () => relationController(context)) };

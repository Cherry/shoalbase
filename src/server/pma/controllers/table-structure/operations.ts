// Port of Controllers\Table\OperationsController (route /table/operations): rename, options, order, copy/move and maintenance.
import {
	checkDbTableExists,
	getPartitionMethod,
	getPartitionNames,
	havePartitioning,
	render,
} from './common.ts';
import { moveOrCopyTable, renameTable } from './move-copy.ts';
import { isSystemSchema } from '../../../../lib/pma/dbi-sql.ts';
import { Message } from '../../../../lib/pma/message.ts';
import { warningMessages } from '../../../../lib/pma/table-structure/maintenance.ts';
import {
	convertCollationQuery,
	partitionMaintenanceChoices,
	partitioningTableQuery,
	possibleRowFormats,
	reorderingTableQuery,
	tableAltersArray,
	userTableComment,
} from '../../../../lib/pma/table-structure/operations.ts';
import { getFromRoute } from '../../../../lib/twig/url.ts';
import { getCharsets, getCollations } from '../../core/charsets.ts';
import { getMessage } from '../../core/generator.ts';
import { getIndexesFromTable } from '../../core/index.ts';
import { getStorageEngineArray } from '../../core/storage-engine.ts';
import { Table } from '../../core/table.ts';
import { withMysqlDie } from '../server/mysql-die.ts';

import type { PmaContext } from '../../core/context.ts';

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const isEmpty = (value: unknown): boolean => value === undefined || value === null || value === '' || value === '0' || (Array.isArray(value) && value.length === 0);

interface TableState {
	status: Record<string, string | null> | null;
	isView: boolean;
	storageEngine: string;
	comment: string | null;
	collation: string;
	rowFormat: string;
	autoIncrement: string;
	createOptions: Record<string, string>;
}

async function readTableState(table: Table, forceRead: boolean): Promise<TableState> {
	const status = await table.getStatus(forceRead);
	const isView = await table.isView();
	await table.getNumRows();
	return {
		status,
		isView,
		storageEngine: isView ? 'View' : await table.getStorageEngine(),
		comment: isView ? null : await table.getComment(),
		collation: await table.getCollation(),
		rowFormat: await table.getRowFormat(),
		autoIncrement: await table.getAutoIncrement(),
		createOptions: await table.getCreateOptions(),
	};
}

// Aria's TRANSACTIONAL option is implicitly on unless the create options turn it off.
function normaliseAriaOptions(options: Record<string, string>): void {
	options.transactional = options.transactional === '0' ? '0' : '1';
	options.page_checksum ??= '';
}

/** Operations::getPossibleRowFormat(), which asks the InnoDB plugin about its file format. */
async function rowFormatsFor(context: PmaContext): Promise<Record<string, Record<string, string>>> {
	const { dbi } = context;
	const pluginVersion = await dbi.fetchValue('SELECT @@innodb_version;');
	let fileFormat = '';
	if (!isEmpty(pluginVersion)) {
		const value = await dbi.fetchValue('SHOW GLOBAL VARIABLES LIKE \'innodb_file_format\';', 1);
		fileFormat = typeof value === 'string' ? value : '';
	}
	let dynamic = fileFormat.toLowerCase() === 'barracuda';
	if (!dynamic && fileFormat === '') {
		dynamic = await dbi.fetchValue('SHOW GLOBAL VARIABLES LIKE \'innodb_file_per_table\';', 1) === 'ON';
	}
	return possibleRowFormats(dynamic);
}

/** InnoDB keeps rows in clustered index order, so ORDER BY is hidden for a primary or NOT NULL unique key. */
async function hideOrderTable(context: PmaContext, storageEngine: string): Promise<boolean> {
	if (storageEngine !== 'INNODB') {
		return false;
	}
	for (const [name, index] of await getIndexesFromTable(context, context.table, context.db)) {
		if (name === 'PRIMARY') {
			return true;
		}
		if (!isEmpty(index.getNonUnique())) {
			continue;
		}
		if (index.getColumns().values().every(column => isEmpty(column.getNull()))) {
			return true;
		}
	}
	return false;
}

/** The submitoptions branch; returns the message parts and whether the table info must be read again. */
async function submitOptions(context: PmaContext, table: Table, state: TableState, lowerCaseNames: boolean) {
	const { dbi, response } = context;
	const post = context.request.post;
	let message = '';
	let result: boolean | undefined;
	let reread = false;
	let sqlQuery = '';
	let warnings: string[] = [];
	let current = table;
	if (post.new_name !== undefined) {
		const newName = lowerCaseNames ? text(post.new_name).toLowerCase() : text(post.new_name);
		const renamed = await renameTable(context, current, newName);
		if (renamed.ok) {
			current = renamed.table;
			await dbi.selectDb(context.db);
			message += renamed.message;
			sqlQuery = renamed.sqlQuery;
			result = true;
			context.table = current.getName();
			reread = true;
			response.globals.reload = true;
		} else {
			message += renamed.message;
			if (renamed.sqlQuery !== '') {
				sqlQuery = renamed.sqlQuery;
			}
			result = false;
		}
	}
	const createOptions = state.createOptions;
	let newEngine = '';
	if (!isEmpty(post.new_tbl_storage_engine) && text(post.new_tbl_storage_engine).toUpperCase() !== state.storageEngine) {
		newEngine = text(post.new_tbl_storage_engine).toUpperCase();
		if (await current.isEngine('ARIA')) {
			normaliseAriaOptions(createOptions);
		}
	}
	const engine = await current.getStorageEngine();
	const alters = tableAltersArray({
		post,
		isEngine: engines => engines.includes(engine),
		storageEngine: state.storageEngine,
		packKeys: createOptions.pack_keys,
		checksum: isEmpty(createOptions.checksum) ? '0' : '1',
		pageChecksum: createOptions.page_checksum ?? '',
		delayKeyWrite: isEmpty(createOptions.delay_key_write) ? '0' : '1',
		rowFormat: createOptions.row_format ?? await current.getRowFormat(),
		newStorageEngine: newEngine,
		transactional: createOptions.transactional === '0' ? '0' : '1',
		collation: state.collation,
		autoIncrement: state.autoIncrement,
	});
	if (alters.length > 0) {
		sqlQuery = `ALTER TABLE ${current.getName(true)}\r\n${alters.join('\r\n')};`;
		response.globals.sqlQuery = sqlQuery;
		await dbi.query(sqlQuery);
		result = true;
		reread = true;
		warnings = warningMessages(await dbi.getWarnings(), post.new_tbl_storage_engine);
	}
	if (!isEmpty(post.tbl_collation) && !isEmpty(post.change_all_collations)) {
		await dbi.selectDb(context.db);
		await dbi.query(convertCollationQuery(context.table, text(post.tbl_collation)));
	}
	const collationMissing = post.tbl_collation !== undefined && isEmpty(post.tbl_collation) && response.isAjax;
	return { table: current, message, result, reread, sqlQuery, warnings, collationMissing };
}

export async function operationsController(context: PmaContext): Promise<Response> {
	const { config, dbi, response } = context;
	const post = context.request.post;
	const privileges = await dbi.getUserPrivileges();
	const lowerCaseNames = await dbi.getLowerCaseNames() === '1';
	if (lowerCaseNames) {
		context.table = context.table.toLowerCase();
	}
	response.addScriptFiles(['table/operations.js']);
	const systemSchema = isSystemSchema(context.db);
	const missing = await checkDbTableExists(context);
	if (missing !== null) {
		return missing;
	}
	const operationsUrl = getFromRoute(context.urlState(), '/table/operations');
	// PHP evaluates ['goto'] = ['back'] = ... right to left, so back comes first.
	const urlParams = { db: context.db, table: context.table, back: operationsUrl, goto: operationsUrl };

	await dbi.selectDb(context.db);
	let table = Table.get(context, context.table, context.db);
	let state = await readTableState(table, false);
	if (await table.isEngine('ARIA')) {
		normaliseAriaOptions(state.createOptions);
	}

	if (post.submit_move !== undefined || post.submit_copy !== undefined) {
		const message = await moveOrCopyTable(context);
		if (!response.isAjax) {
			return response.response();
		}
		response.addJSON('message', message);
		if (message.isSuccess()) {
			if (post.submit_move !== undefined && post.target_db !== undefined) {
				context.db = text(post.target_db);
			}
			response.addJSON('db', context.db);
			return response.response();
		}
		response.setRequestStatus(false);
		return response.response();
	}

	let messageText = '';
	let result: boolean | undefined;
	let reread = false;
	let sqlQuery = '';
	let warnings: string[] = [];
	if (post.submitoptions !== undefined) {
		const options = await submitOptions(context, table, state, lowerCaseNames);
		({ table, result, reread, sqlQuery, warnings } = options);
		messageText = options.message;
		if (options.collationMissing) {
			response.setRequestStatus(false);
			response.addJSON('message', Message.error('No collation provided.'));
			return response.response();
		}
	}
	if (post.submitorderby !== undefined && !isEmpty(post.order_field)) {
		sqlQuery = reorderingTableQuery(context.table, decodeURIComponent(text(post.order_field).replaceAll('+', ' ')), typeof post.order_order === 'string' ? post.order_order : null);
		response.globals.sqlQuery = sqlQuery;
		await dbi.query(sqlQuery);
		result = true;
	}
	if (post.submit_partition !== undefined && !isEmpty(post.partition_operation)) {
		const names = Array.isArray(post.partition_name) ? post.partition_name : [];
		sqlQuery = partitioningTableQuery(context.table, text(post.partition_operation), names);
		response.globals.sqlQuery = sqlQuery;
		await dbi.query(sqlQuery);
		result = true;
	}
	if (reread) {
		dbi.clearTableCache();
		await dbi.selectDb(context.db);
		state = await readTableState(table, true);
	}

	if (result !== undefined) {
		let message: Message;
		if (messageText === '') {
			if (sqlQuery === '') {
				message = Message.success('No change');
			} else {
				message = result ? Message.success() : Message.error();
			}
			if (response.isAjax) {
				response.setRequestStatus(message.isSuccess());
				response.addJSON('message', message);
				if (sqlQuery !== '') {
					response.addJSON('sql_query', await getMessage(context, '', { sqlQuery }));
				}
				return response.response();
			}
		} else {
			message = result ? Message.success(messageText) : Message.error(messageText);
		}
		if (warnings.length > 0) {
			message = new Message();
			message.addMessagesString(warnings);
			message.isError(true);
			if (response.isAjax) {
				response.setRequestStatus(false);
				response.addJSON('message', message);
				if (sqlQuery !== '') {
					response.addJSON('sql_query', await getMessage(context, '', { sqlQuery }));
				}
				return response.response();
			}
		}
		if (sqlQuery === '') {
			response.addHTML(message.getDisplay());
		} else {
			response.addHTML(await getMessage(context, message, { sqlQuery }));
		}
	}

	const columns = await dbi.getColumns(context.db, context.table);
	const engines = await getStorageEngineArray(context);
	const engine = await table.getStorageEngine();
	const isEngine = (names: string[]): boolean => names.includes(engine);
	const createOptions = state.createOptions;
	const databases = await dbi.getDatabaseList();
	let databaseList: { name: string; is_selected: boolean; }[] = [];
	if (databases.length <= config.MaxDbList) {
		databaseList = databases.filter(name => !isSystemSchema(name)).map((name) => { return { name, is_selected: name === context.db }; });
	}
	let partitions: (string | null)[] = [];
	let partitionsChoices: Record<string, string> = {};
	if (await havePartitioning(context)) {
		const names = await getPartitionNames(context, context.db, context.table);
		if (names[0] !== undefined && names[0] !== null) {
			partitions = names;
			partitionsChoices = partitionMaintenanceChoices(await getPartitionMethod(context, context.db, context.table));
		}
	}
	const rowFormats = await rowFormatsFor(context);
	const charsets = await getCharsets(context);
	response.addHTML(await render(context, 'table/operations/index', {
		db: context.db,
		table: context.table,
		url_params: urlParams,
		columns: columns.values().toArray(),
		hide_order_table: await hideOrderTable(context, state.storageEngine),
		table_comment: userTableComment(state.comment),
		storage_engine: state.storageEngine,
		storage_engines: engines.values().toArray(),
		charsets: charsets.values().toArray(),
		collations: await getCollations(context),
		tbl_collation: state.collation,
		row_formats: rowFormats[state.storageEngine] ?? [],
		row_format_current: state.status?.Row_format ?? null,
		has_auto_increment: state.autoIncrement !== '' && isEngine(['MYISAM', 'ARIA', 'INNODB', 'PBXT', 'ROCKSDB']),
		auto_increment: state.autoIncrement,
		has_pack_keys: createOptions.pack_keys !== undefined && isEngine(['MYISAM', 'ARIA', 'ISAM']),
		pack_keys: createOptions.pack_keys ?? '',
		has_transactional_and_page_checksum: isEngine(['ARIA']),
		has_checksum_and_delay_key_write: isEngine(['MYISAM', 'ARIA']),
		delay_key_write: isEmpty(createOptions.delay_key_write) ? '0' : '1',
		transactional: createOptions.transactional === '0' ? '0' : '1',
		page_checksum: createOptions.page_checksum ?? '',
		checksum: isEmpty(createOptions.checksum) ? '0' : '1',
		database_list: databaseList,
		has_foreign_keys: await table.showCreate() !== '',
		has_privileges: privileges.tablePriv && privileges.colPriv && privileges.isReloadPriv,
		switch_to_new: !isEmpty(context.session.data.pma_switch_to_new),
		is_system_schema: systemSchema,
		is_view: state.isView,
		partitions,
		partitions_choices: partitionsChoices,
		foreigners: [],
	}));
	return response.response();
}

export const controllers = { 'Table/OperationsController': async (context: PmaContext) => withMysqlDie(context, async () => operationsController(context)) };

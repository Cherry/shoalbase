// Ports of Controllers\Table\IndexesController and IndexRenameController with Table\Indexes::doSaveData().
import { serverKind } from './columns-definition.ts';
import { checkDbTableExists, render } from './common.ts';
import { mysqlDie } from './save.ts';
import { structureController } from './structure.ts';
import { escapeString } from '../../../../lib/pma/dbi-sql.ts';
import { Index, type IndexParams } from '../../../../lib/pma/index.ts';
import { Message } from '../../../../lib/pma/message.ts';
import {
	type PhpArray,
	nestedParams,
	phpArray,
	phpKeys,
} from '../../../../lib/pma/table-data/php-params.ts';
import { createIndexFieldCount, nameAndTypeOfColumns } from '../../../../lib/pma/table-structure/indexes.ts';
import { isCompatibleRenameIndex } from '../../../../lib/pma/table-structure/types.ts';
import { backquote } from '../../../../lib/twig/sanitize.ts';
import { DbiQueryError } from '../../core/dbi.ts';
import { getMessage } from '../../core/generator.ts';
import {
	findDuplicates,
	getIndexSingleton,
	getIndexesFromTable,
	getPrimaryIndex,
} from '../../core/index.ts';
import { Table } from '../../core/table.ts';
import { withMysqlDie } from '../server/mysql-die.ts';

import type { PmaContext } from '../../core/context.ts';

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** new Index($_POST['index']): the posted form fields plus its column names and sub parts. */
function indexFromForm(posted: PhpArray): Index {
	const params: IndexParams = {};
	for (const [key, value] of Object.entries(posted)) {
		if (typeof value === 'string') {
			params[key] = value;
		}
	}
	const index = new Index(params);
	const columns = phpArray(posted.columns);
	const names = phpArray(columns?.names);
	if (names !== undefined) {
		const subParts = phpArray(columns?.sub_parts) ?? {};
		for (const key of phpKeys(names)) {
			index.addColumn({ Column_name: text(names[key]), Sub_part: text(subParts[key]) });
		}
	}
	return index;
}

/** Index::hasPrimary(), resolved before rendering because templates cannot wait for the database. */
async function withHasPrimary(context: PmaContext, index: Index): Promise<Index> {
	let primary = false;
	if (index.getTable() !== '') {
		primary = await getPrimaryIndex(context, index.getTable(), index.getSchema()) !== false;
	}
	return Object.assign(index, { hasPrimary: () => primary });
}

// The old index name the form posts back, as a string or an index[Key_name] array.
function oldIndexName(post: PhpArray): string {
	const old = post.old_index;
	if (typeof old === 'object') {
		return text(old.Key_name);
	}
	return text(old);
}

/** Table::getSqlQueryForIndexCreateOrEdit(). */
async function indexCreateOrEditSql(context: PmaContext, post: PhpArray, index: Index): Promise<[string, Message | false]> {
	let error: Message | false = false;
	let sql = `ALTER TABLE ${backquote(context.db)}.${backquote(context.table)}`;
	const old = post.old_index;
	if (old !== undefined && old !== '' && old !== '0' && !(typeof old === 'object' && Object.keys(old).length === 0)) {
		const name = oldIndexName(post);
		sql += name === 'PRIMARY' ? ' DROP PRIMARY KEY,' : ` DROP INDEX ${backquote(name)},`;
	}
	const choice = index.getChoice();
	if (choice === 'PRIMARY') {
		if (index.getName() === '') {
			index.setName('PRIMARY');
		} else if (index.getName() !== 'PRIMARY') {
			error = Message.error('The name of the primary key must be "PRIMARY"!');
		}
		sql += ' ADD PRIMARY KEY';
	} else if (['FULLTEXT', 'UNIQUE', 'INDEX', 'SPATIAL'].includes(choice)) {
		if (index.getName() === 'PRIMARY') {
			error = Message.error('Can\'t rename index to PRIMARY!');
		}
		sql += ` ADD ${choice} `;
		if (index.getName() !== '') {
			sql += backquote(index.getName());
		}
	}
	const fields = index.getColumns().values()
		.map((column) => {
			const subPart = column.getSubPart();
			const field = backquote(column.getName());
			return subPart === null || ['', '0'].includes(subPart) ? field : `${field}(${subPart})`;
		})
		.toArray();
	if (fields.length === 0) {
		error = Message.error('No index parts defined!');
	} else {
		sql += ` (${fields.join(', ')})`;
	}
	const keyBlockSize = index.getKeyBlockSize();
	if (keyBlockSize !== null && keyBlockSize !== '' && keyBlockSize !== '0') {
		sql += ` KEY_BLOCK_SIZE = ${escapeString(keyBlockSize)}`;
	}
	const type = index.getType();
	if (choice !== 'SPATIAL' && choice !== 'FULLTEXT' && Index.getIndexTypes().includes(type) && !await Table.get(context, context.table, context.db).isEngine(['TOKUDB'])) {
		sql += ` USING ${type}`;
	}
	const parser = index.getParser();
	if (choice === 'FULLTEXT' && parser !== null && parser !== '' && parser !== '0') {
		sql += ` WITH PARSER ${escapeString(parser)}`;
	}
	const comment = index.getComment();
	if (comment !== '' && comment !== '0') {
		sql += ` COMMENT '${escapeString(comment)}'`;
	}
	return [`${sql};`, error];
}

/** Table\Indexes::doSaveData(). */
async function doSaveData(context: PmaContext, post: PhpArray, index: Index, renameMode: boolean): Promise<Response> {
	const { dbi, response } = context;
	let error: Message | false = false;
	let sqlQuery: string;
	if (renameMode && isCompatibleRenameIndex(serverKind(context))) {
		const oldName = text(post.old_index);
		if (oldName === 'PRIMARY') {
			if (index.getName() === '') {
				index.setName('PRIMARY');
			} else if (index.getName() !== 'PRIMARY') {
				error = Message.error('The name of the primary key must be "PRIMARY"!');
			}
		}
		sqlQuery = `ALTER TABLE ${backquote(context.db)}.${backquote(context.table)} RENAME INDEX ${backquote(oldName)} TO ${backquote(index.getName())};`;
	} else {
		[sqlQuery, error] = await indexCreateOrEditSql(context, post, index);
	}
	if (post.preview_sql !== undefined) {
		response.addJSON('sql_data', await render(context, 'preview_sql', { query_data: sqlQuery }));
		return response.response();
	}
	if (error !== false) {
		response.setRequestStatus(false);
		response.addJSON('message', error);
		return response.response();
	}
	try {
		await dbi.query(sqlQuery);
	} catch (queryError) {
		if (!(queryError instanceof DbiQueryError)) {
			throw queryError;
		}
		return mysqlDie(context, queryError);
	}
	if (!response.isAjax) {
		return structureController(context);
	}
	const message = Message.success('Table %1$s has been altered successfully.');
	message.addParam(context.table);
	response.addJSON('message', await getMessage(context, message, { sqlQuery, type: 'success' }));
	response.addJSON('index_table', await render(context, 'indexes', {
		url_params: { db: context.db, table: context.table },
		indexes: await getIndexesFromTable(context, context.table, context.db),
		indexes_duplicates: await findDuplicates(context, context.table, context.db),
	}));
	return response.response();
}

export async function indexesController(context: PmaContext): Promise<Response> {
	const { dbi, response } = context;
	const post = nestedParams(context.request.post);
	const createEditTable = post.create_edit_table !== undefined;
	if (!createEditTable) {
		const missing = await checkDbTableExists(context);
		if (missing !== null) {
			return missing;
		}
	}
	let index: Index;
	const postedIndex = post.index;
	if (typeof postedIndex === 'object') {
		index = indexFromForm(postedIndex);
	} else if (postedIndex === undefined) {
		index = new Index();
	} else {
		index = await getIndexSingleton(context, context.db, context.table, postedIndex);
	}
	if (post.do_save_data !== undefined) {
		return doSaveData(context, post, index, false);
	}

	await dbi.selectDb(context.db);
	let addFields = 0;
	if (typeof postedIndex === 'object') {
		const names = phpArray(phpArray(postedIndex.columns)?.names);
		if (names !== undefined) {
			addFields = Object.keys(names).length - index.getColumnCount();
		}
		if (post.add_fields !== undefined) {
			addFields += Number(post.added_fields ?? 0);
		}
	} else if (post.create_index !== undefined) {
		addFields = createIndexFieldCount(post.added_fields);
	}
	let fields: unknown;
	if (createEditTable) {
		const decoded: unknown = JSON.parse(text(post.columns) || 'null');
		fields = decoded;
		index.set({ Non_unique: text(phpArray(postedIndex)?.Index_choice) === 'UNIQUE' ? '0' : '1' });
		addFields = decoded !== null && typeof decoded === 'object' ? Object.keys(decoded).length : 0;
	} else {
		const columns = await dbi.getColumnsFull(context.db, context.table);
		fields = nameAndTypeOfColumns(columns.values());
	}
	const formParams: Record<string, unknown> = { db: context.db, table: context.table };
	if (post.create_index !== undefined) {
		formParams.create_index = 1;
	} else if (post.old_index !== undefined) {
		formParams.old_index = post.old_index;
	} else if (postedIndex !== undefined) {
		formParams.old_index = postedIndex;
	}
	response.addScriptFiles(['indexes.js']);
	response.addHTML(await render(context, 'table/index_form', {
		fields,
		index: await withHasPrimary(context, index),
		form_params: formParams,
		add_fields: addFields,
		create_edit_table: createEditTable,
		default_sliders_state: context.config.InitialSlidersState,
		is_from_nav: post.is_from_nav !== undefined,
	}));
	return response.response();
}

export async function indexRenameController(context: PmaContext): Promise<Response> {
	const { dbi, response } = context;
	const post = nestedParams(context.request.post);
	if (post.create_edit_table === undefined) {
		const missing = await checkDbTableExists(context);
		if (missing !== null) {
			return missing;
		}
	}
	let index: Index;
	const postedIndex = post.index;
	if (typeof postedIndex === 'object') {
		const original = await getIndexSingleton(context, context.db, context.table, oldIndexName(post));
		// clone keeps the registry's index under its old name.
		index = Object.assign(Object.create(Object.getPrototypeOf(original) as object) as Index, original);
		index.setName(text(postedIndex.Key_name));
	} else if (postedIndex === undefined) {
		index = new Index();
	} else {
		index = await getIndexSingleton(context, context.db, context.table, postedIndex);
	}
	if (post.do_save_data !== undefined) {
		return doSaveData(context, post, index, true);
	}
	await dbi.selectDb(context.db);
	const formParams: Record<string, unknown> = { db: context.db, table: context.table };
	if (post.old_index !== undefined) {
		formParams.old_index = post.old_index;
	} else if (postedIndex !== undefined) {
		formParams.old_index = postedIndex;
	}
	response.addScriptFiles(['indexes.js']);
	response.addHTML(await render(context, 'table/index_rename_form', { index, form_params: formParams }));
	return response.response();
}

export const controllers = {
	'Table/IndexesController': async (context: PmaContext) => withMysqlDie(context, async () => indexesController(context)),
	'Table/IndexRenameController': async (context: PmaContext) => withMysqlDie(context, async () => indexRenameController(context)),
};

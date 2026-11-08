// Port of Controllers\Table\Structure\PartitioningController (route /table/structure/partitioning): edit and save partitioning.
import { serverKind } from './columns-definition.ts';
import { render } from './common.ts';
import { structureController } from './structure.ts';
import { Message } from '../../../../lib/pma/message.ts';
import { nestedParams } from '../../../../lib/pma/table-data/php-params.ts';
import { CreateAddField } from '../../../../lib/pma/table-structure/create-add-field.ts';
import {
	type ParsedPartitioning,
	type PartitionDetails,
	getPartitionDetails,
	partitionDetailsFromStatement,
} from '../../../../lib/pma/table-structure/partition-definition.ts';
import { backquote } from '../../../../lib/twig/sanitize.ts';
import { Context, CreateStatement, Parser } from '../../../../sql-parser/index.ts';
import { getMessage } from '../../core/generator.ts';
import { getPageSettings } from '../../core/page-settings.ts';
import { getStorageEngineArray } from '../../core/storage-engine.ts';
import { Table } from '../../core/table.ts';

import type { PmaContext } from '../../core/context.ts';

/** PartitioningController::extractPartitionDetails(). */
async function extractPartitionDetails(context: PmaContext): Promise<PartitionDetails | null> {
	const { dbi } = context;
	const createTable = await Table.get(context, context.table, context.db).showCreate();
	if (createTable === '') {
		return null;
	}
	// The parser keywords are global state, so they are loaded right before parsing.
	Context.loadClosest(`${dbi.isMariaDB() ? 'MariaDb' : 'MySql'}${dbi.getVersion()}`);
	const statement = new Parser(createTable).statements[0];
	return partitionDetailsFromStatement(statement instanceof CreateStatement ? statement as unknown as ParsedPartitioning : {});
}

/** PartitioningController::updatePartitioning(). */
async function updatePartitioning(context: PmaContext): Promise<void> {
	const { dbi, response } = context;
	const createAddField = new CreateAddField(nestedParams(context.request.post), serverKind(context));
	const sqlQuery = `ALTER TABLE ${backquote(context.table)} ${createAddField.getPartitionsDefinition()}`;
	if (await dbi.tryQuery(sqlQuery) === false) {
		response.setRequestStatus(false);
		response.addJSON('message', Message.rawError(`Query error:<br>${dbi.getError()}`));
		return;
	}
	const message = Message.success('Table %1$s has been altered successfully.');
	message.addParam(context.table);
	response.addHTML(await getMessage(context, message, { sqlQuery, type: 'success' }));
}

export async function partitioningController(context: PmaContext): Promise<Response> {
	const { response } = context;
	if (context.request.post.save_partitioning !== undefined) {
		await context.dbi.selectDb(context.db);
		await updatePartitioning(context);
		return structureController(context);
	}
	const pageSettings = await getPageSettings(context, 'TableStructure');
	if (pageSettings.saved) {
		return response.response();
	}
	response.addHTML(pageSettings.errorHtml);
	response.addHTML(pageSettings.html);
	response.addScriptFiles(['table/structure.js', 'indexes.js']);
	let details: PartitionDetails | null = null;
	if (context.request.post.partition_by === undefined) {
		details = await extractPartitionDetails(context);
	}
	const engines = await getStorageEngineArray(context);
	const storageEngines = engines.values().toArray();
	response.addHTML(await render(context, 'table/structure/partition_definition_form', {
		db: context.db,
		table: context.table,
		partition_details: details ?? getPartitionDetails(nestedParams(context.request.post)),
		storage_engines: storageEngines,
	}));
	return response.response();
}

export const controllers = { 'Table/Structure/PartitioningController': partitioningController };

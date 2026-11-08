// Index::getFromTable() and friends: loads SHOW INDEXES once per table and request, like upstream's static registry.
import {
	Index,
	type IndexParams,
	filterIndexesByChoice,
	findDuplicateIndexes,
} from '../../../lib/pma/index.ts';

import type { PmaContext } from './context.ts';
import type { DatabaseInterface } from './dbi.ts';

// Keyed by the request's dbi so DatabaseInterface::getColumns() shares the registry without a context.
const registries = new WeakMap<DatabaseInterface, Map<string, Map<string, Index>>>();

/** Index::getFromTable() for a request's DatabaseInterface. */
export async function getIndexesFromDbi(dbi: DatabaseInterface, table: string, schema: string): Promise<Map<string, Index>> {
	let registry = registries.get(dbi);
	if (registry === undefined) {
		registry = new Map();
		registries.set(dbi, registry);
	}
	const key = JSON.stringify([schema, table]);
	let indexes = registry.get(key);
	if (indexes === undefined) {
		indexes = Index.fromRows(await dbi.getTableIndexes(schema, table) as IndexParams[], schema);
		registry.set(key, indexes);
	}
	return indexes;
}

/** Index::getFromTable(): the table's indexes keyed by name, in SHOW INDEXES order. */
export async function getIndexesFromTable(context: PmaContext, table: string, schema: string): Promise<Map<string, Index>> {
	return getIndexesFromDbi(context.dbi, table, schema);
}

/** Index::getFromTableByChoice() with the Index::PRIMARY | UNIQUE | ... bit mask. */
export async function getIndexesByChoice(context: PmaContext, table: string, schema: string, choices = 31): Promise<Index[]> {
	const indexes = await getIndexesFromTable(context, table, schema);
	return filterIndexesByChoice(indexes.values(), choices);
}

/** Index::getPrimary(). */
export async function getPrimaryIndex(context: PmaContext, table: string, schema: string): Promise<Index | false> {
	const indexes = await getIndexesFromTable(context, table, schema);
	return indexes.get('PRIMARY') ?? false;
}

/** Index::singleton(): an existing index, or a new one registered under the given name. */
export async function getIndexSingleton(context: PmaContext, schema: string, table: string, indexName = ''): Promise<Index> {
	const indexes = await getIndexesFromTable(context, table, schema);
	const existing = indexes.get(indexName);
	if (existing !== undefined) {
		return existing;
	}
	const index = new Index();
	if (indexName !== '') {
		index.setName(indexName);
		indexes.set(indexName, index);
	}
	return index;
}

/** Index::findDuplicates(). */
export async function findDuplicates(context: PmaContext, table: string, schema: string): Promise<string> {
	const indexes = await getIndexesFromTable(context, table, schema);
	return findDuplicateIndexes(indexes.values());
}

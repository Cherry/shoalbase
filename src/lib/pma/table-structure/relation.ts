// Pure parts of Controllers\Table\RelationController and Table::updateForeignKeys(), for foreign keys without configuration storage.
import { backquote } from '../../twig/sanitize.ts';
import { strnatcasecmp } from '../php-compare.ts';
import { looseEquals } from '../table-data/relation.ts';

/** RelationController's $options: the referential actions by their form value. */
export const FOREIGN_KEY_ACTIONS: Record<string, string> = {
	CASCADE: 'CASCADE',
	SET_NULL: 'SET NULL',
	NO_ACTION: 'NO ACTION',
	RESTRICT: 'RESTRICT',
};

/** The column choices of the foreign key form: every column for InnoDB, else only indexed ones, after an empty choice. */
export function relationColumnArray(columns: { Field?: string | null; Key?: string | null; }[], storageEngine: string, naturalOrder: boolean): Map<string, string> {
	const names: string[] = [''];
	for (const column of columns) {
		const key = column.Key ?? '';
		if (storageEngine.toUpperCase() !== 'INNODB' && (key === '' || key === '0')) {
			continue;
		}
		names.push(column.Field ?? '');
	}
	if (naturalOrder) {
		names.sort(strnatcasecmp);
	}
	return new Map(names.map(name => [name, name]));
}

/** Relation::getTables(): the tables of SHOW TABLE STATUS rows ([name, engine, ...]) using the given storage engine. */
export function tablesWithEngine(rows: (string | null)[][], storageEngine: string, naturalOrder: boolean): string[] {
	const tables = rows.filter(row => row[1] !== null && row[1] !== undefined && row[1].toUpperCase() === storageEngine).map(row => row[0] ?? '');
	if (naturalOrder) {
		tables.sort(strnatcasecmp);
	}
	return tables;
}

const isBlank = (value: string | null | undefined): boolean => [undefined, null, '', '0'].includes(value);

export interface ForeignKeySql {
	table: string;
	/** Table::$dbName: the referenced database is only written out when it differs. */
	currentDb: string;
	fields: string[];
	foreignDb: string;
	foreignTable: string;
	foreignFields: string[];
	name?: string | null;
	onDelete?: string | null;
	onUpdate?: string | null;
}

/** Table::getSQLToCreateForeignKey(). */
export function createForeignKeyQuery(input: ForeignKeySql): string {
	let sql = `ALTER TABLE ${backquote(input.table)} ADD `;
	if (!isBlank(input.name)) {
		sql += ` CONSTRAINT ${backquote(input.name as string)}`;
	}
	const database = looseEquals(input.currentDb, input.foreignDb) ? '' : `${backquote(input.foreignDb)}.`;
	sql += ` FOREIGN KEY (${input.fields.map(field => backquote(field)).join(', ')}) REFERENCES ${database}${backquote(input.foreignTable)}(${input.foreignFields.map(field => backquote(field)).join(', ')})`;
	if (!isBlank(input.onDelete)) {
		sql += ` ON DELETE ${input.onDelete as string}`;
	}
	if (!isBlank(input.onUpdate)) {
		sql += ` ON UPDATE ${input.onUpdate as string}`;
	}
	return `${sql};`;
}

/** One existing foreign key, as Sql-parser's Table::getForeignKeys() describes it. */
export interface ExistingForeignKey {
	constraint?: string | null;
	index_list?: string[];
	ref_db_name?: string | null;
	ref_table_name?: string | null;
	ref_index_list?: string[];
	on_delete?: string;
	on_update?: string;
}

/** One posted row of the foreign key form; the lists keep PHP's keys. */
export interface ForeignKeyRow {
	foreignDb: string;
	foreignTable: string;
	fields: Map<string, string>;
	foreignFields: Map<string, string>;
	constraintName: string;
	onDelete: string;
	onUpdate: string;
}

export interface ForeignKeyPlan {
	drop: string | null;
	create: string | null;
	/** Run when the create fails after the old key was dropped. */
	recreate: string | null;
	/** The local columns, for the "check data types" error. */
	fields: string[];
}

// PHP's loose == on two arrays: the same keys, each with loosely equal values.
function looseArrayEquals(left: Map<string, string>, right: string[]): boolean {
	if (left.size !== right.length) {
		return false;
	}
	return [...left].every(([key, value]) => /^\d+$/.test(key) && Number(key) < right.length && looseEquals(value, right[Number(key)]));
}

/** The decisions of Table::updateForeignKeys() for one posted row. */
export function planForeignKeyUpdate(table: string, currentDb: string, row: ForeignKeyRow, existing: ExistingForeignKey | undefined): ForeignKeyPlan {
	const fields = new Map(row.fields);
	const foreignFields = new Map(row.foreignFields);
	let emptyFields = false;
	for (const [key, field] of row.fields) {
		const foreignField = foreignFields.get(key);
		if ((field !== '' && (foreignField === undefined || foreignField === '')) || (field === '' && foreignField !== undefined && foreignField !== '')) {
			emptyFields = true;
		}
		if (field !== '' || (foreignField !== undefined && foreignField !== '')) {
			continue;
		}
		fields.delete(key);
		foreignFields.delete(key);
	}
	let drop = false;
	let create = false;
	if (row.foreignDb !== '' && row.foreignTable !== '' && !emptyFields) {
		if (existing === undefined) {
			create = true;
		} else {
			const refDb = existing.ref_db_name ?? currentDb;
			const onDelete = isBlank(existing.on_delete) ? 'RESTRICT' : existing.on_delete as string;
			const onUpdate = isBlank(existing.on_update) ? 'RESTRICT' : existing.on_update as string;
			const changed = !looseEquals(refDb, row.foreignDb)
				|| !looseEquals(existing.ref_table_name ?? '', row.foreignTable)
				|| !looseArrayEquals(foreignFields, existing.ref_index_list ?? [])
				|| !looseArrayEquals(fields, existing.index_list ?? [])
				|| !looseEquals(row.constraintName, existing.constraint ?? '')
				|| !looseEquals(row.onDelete, onDelete)
				|| !looseEquals(row.onUpdate, onUpdate);
			drop = changed;
			create = changed;
		}
	} else if (existing !== undefined) {
		drop = true;
	}
	const plan: ForeignKeyPlan = { drop: null, create: null, recreate: null, fields: fields.values().toArray() };
	if (drop && existing !== undefined) {
		plan.drop = `ALTER TABLE ${backquote(table)} DROP FOREIGN KEY ${backquote(existing.constraint ?? '')};`;
	}
	if (!create) {
		return plan;
	}
	plan.create = createForeignKeyQuery({
		table,
		currentDb,
		fields: fields.values().toArray(),
		foreignDb: row.foreignDb,
		foreignTable: row.foreignTable,
		foreignFields: foreignFields.values().toArray(),
		name: row.constraintName,
		onDelete: FOREIGN_KEY_ACTIONS[row.onDelete] ?? null,
		onUpdate: FOREIGN_KEY_ACTIONS[row.onUpdate] ?? null,
	});
	if (drop && existing !== undefined) {
		plan.recreate = `# Restoring the dropped constraint...\n${createForeignKeyQuery({
			table,
			currentDb,
			fields: existing.index_list ?? [],
			foreignDb: existing.ref_db_name ?? currentDb,
			foreignTable: existing.ref_table_name ?? '',
			foreignFields: existing.ref_index_list ?? [],
			name: existing.constraint,
			onDelete: FOREIGN_KEY_ACTIONS[existing.on_delete ?? ''] ?? null,
			onUpdate: FOREIGN_KEY_ACTIONS[existing.on_update ?? ''] ?? null,
		})}`;
	}
	return plan;
}

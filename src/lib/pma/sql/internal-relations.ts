// PhpMyAdmin\InternalRelations: the relations Relation::getForeigners() emulates for information_schema and mysql tables.
import data from './internal-relations.json' with { type: 'json' };

// JSON imports type arrays rather than tuples, so each relation is a string[] of length three.
type Relations = Record<string, Record<string, Record<string, string[]>>>;

const relations: Relations = data;

/** [foreign db, foreign table, foreign column] by column; the table name is matched case-sensitively like upstream. */
export function internalRelations(db: string, table: string): Record<string, string[]> {
	const lower = db.toLowerCase();
	if (lower !== 'information_schema' && lower !== 'mysql') {
		return {};
	}
	return relations[lower][table] ?? {};
}

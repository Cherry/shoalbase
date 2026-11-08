// Port of PhpMyAdmin\Index and IndexColumn: a table index built from SHOW INDEXES rows. Loading lives in server/pma/core/index.ts.
import { Message } from './message.ts';
import { htmlspecialchars } from '../twig/php.ts';

/** Index::PRIMARY ... Index::FULLTEXT, combinable as a bit mask for getFromTableByChoice(). */
export const INDEX_PRIMARY = 1;
export const INDEX_UNIQUE = 2;
export const INDEX_INDEX = 4;
export const INDEX_SPATIAL = 8;
export const INDEX_FULLTEXT = 16;

/** A SHOW INDEXES row, or the same keys from the index form. */
export type IndexParams = Record<string, string | null | undefined>;

const isSet = (value: string | null | undefined): value is string => value !== undefined && value !== null;

export class IndexColumn {
	private name = '';
	private seqInIndex = '1';
	private collation: string | null = null;
	private subPart: string | null = null;
	private nullValue = '';
	private cardinality: string | null = null;
	private expression: string | null = null;

	constructor(params: IndexParams = {}) {
		this.set(params);
	}

	set(params: IndexParams): void {
		if (isSet(params.Column_name)) {
			this.name = params.Column_name;
		}
		if (isSet(params.Seq_in_index)) {
			this.seqInIndex = params.Seq_in_index;
		}
		if (isSet(params.Collation)) {
			this.collation = params.Collation;
		}
		if (isSet(params.Cardinality)) {
			this.cardinality = params.Cardinality;
		}
		if (isSet(params.Sub_part)) {
			this.subPart = params.Sub_part;
		}
		if (isSet(params.Expression)) {
			this.expression = params.Expression;
		}
		if (isSet(params.Null)) {
			this.nullValue = params.Null;
		}
	}

	hasExpression(): boolean {
		return this.expression !== null;
	}

	getExpression(): string | null {
		return this.expression;
	}

	getName(): string {
		return this.name;
	}

	getCollation(): string | null {
		return this.collation;
	}

	getCardinality(): string | null {
		return this.cardinality;
	}

	getNull(asText = false): string {
		if (!asText) {
			return this.nullValue;
		}
		if (['', '0', 'NO'].includes(this.nullValue)) {
			return 'No';
		}
		return 'Yes';
	}

	getSeqInIndex(): number {
		return Number(this.seqInIndex);
	}

	getSubPart(): string | null {
		return this.subPart;
	}

	getCompareData(): Record<string, string | null> {
		return { Column_name: this.name, Seq_in_index: this.seqInIndex, Collation: this.collation, Sub_part: this.subPart, Null: this.nullValue };
	}
}

export class Index {
	static getIndexTypes(): string[] {
		return ['BTREE', 'HASH'];
	}

	/** Index::loadIndexes() for one table: SHOW INDEXES rows grouped into indexes, keyed by name in row order. */
	static fromRows(rows: IndexParams[], schema: string): Map<string, Index> {
		const indexes = new Map<string, Index>();
		for (const row of rows) {
			const keyName = row.Key_name ?? '';
			let index = indexes.get(keyName);
			if (index === undefined) {
				index = new Index({ ...row, Schema: schema });
				indexes.set(keyName, index);
			}
			index.addColumn(row);
		}
		return indexes;
	}

	private schema = '';
	private table = '';
	private name = '';
	/** Keyed by column name (or expression plus sequence), as a Map so Twig loops keep upstream's array order. */
	private readonly columns = new Map<string, IndexColumn>();
	private type = '';
	private choice = '';
	private remarks = '';
	private comment = '';
	private nonUnique = '0';
	private packed: string | null = null;
	private keyBlockSize: string | null = null;
	private parser: string | null = null;

	constructor(params: IndexParams = {}, columns: IndexParams[] = []) {
		this.set(params);
		this.addColumns(columns);
	}

	// FULLTEXT and SPATIAL are choices rather than index types.
	private choiceFrom(requested: string | null | undefined): string {
		if (isSet(requested)) {
			return requested;
		}
		if (this.name === 'PRIMARY') {
			return 'PRIMARY';
		}
		if (this.type === 'FULLTEXT' || this.type === 'SPATIAL') {
			const choice = this.type;
			this.type = '';
			return choice;
		}
		if (this.nonUnique === '0') {
			return 'UNIQUE';
		}
		return 'INDEX';
	}

	addColumn(params: IndexParams): void {
		let key = params.Column_name ?? params.Expression ?? '';
		if (isSet(params.Expression)) {
			// An expression alone does not make the key unique, so the sequence number is added.
			key += params.Seq_in_index ?? '';
		}
		if (key === '') {
			return;
		}
		this.columns.set(key, new IndexColumn(params));
	}

	/** Index::addColumns() for SHOW INDEXES rows; the index form posts names and sub_parts lists instead. */
	addColumns(columns: IndexParams[] | { names: string[]; sub_parts?: string[]; }): void {
		if (Array.isArray(columns)) {
			for (const column of columns) {
				this.addColumn(column);
			}
			return;
		}
		for (const [key, name] of columns.names.entries()) {
			this.addColumn({ Column_name: name, Sub_part: columns.sub_parts?.[key] ?? '' });
		}
	}

	hasColumn(column: string | { toString(): string; }): boolean {
		// Templates pass an escaped Twig Markup, which PHP's Twig would have handed over as a string.
		return this.columns.has(String(column));
	}

	set(params: IndexParams): void {
		if (isSet(params.Schema)) {
			this.schema = params.Schema;
		}
		if (isSet(params.Table)) {
			this.table = params.Table;
		}
		if (isSet(params.Key_name)) {
			this.name = params.Key_name;
		}
		if (isSet(params.Index_type)) {
			this.type = params.Index_type;
		}
		if (isSet(params.Comment)) {
			this.remarks = params.Comment;
		}
		if (isSet(params.Index_comment)) {
			this.comment = params.Index_comment;
		}
		if (isSet(params.Non_unique)) {
			this.nonUnique = params.Non_unique;
		}
		if (isSet(params.Packed)) {
			this.packed = params.Packed;
		}
		this.choice = this.choiceFrom(params.Index_choice);
		if (isSet(params.Key_block_size)) {
			this.keyBlockSize = params.Key_block_size;
		}
		if (isSet(params.Parser)) {
			this.parser = params.Parser;
		}
	}

	getSchema(): string {
		return this.schema;
	}

	getTable(): string {
		return this.table;
	}

	getColumnCount(): number {
		return this.columns.size;
	}

	getComment(): string {
		return this.comment;
	}

	getRemarks(): string {
		return this.remarks;
	}

	getKeyBlockSize(): string | null {
		return this.keyBlockSize;
	}

	getParser(): string | null {
		return this.parser;
	}

	getComments(): string {
		let comments = this.remarks;
		if (comments !== '') {
			comments += '\n';
		}
		return comments + this.comment;
	}

	getType(): string {
		return this.type;
	}

	getChoice(): string {
		return this.choice;
	}

	getPacked(): string | null {
		return this.packed;
	}

	isPacked(): string {
		if (this.packed === null) {
			return 'No';
		}
		return htmlspecialchars(this.packed);
	}

	getNonUnique(): string {
		return this.nonUnique;
	}

	isUnique(asText = false): boolean | string {
		const unique = this.nonUnique === '0';
		if (asText) {
			return unique ? 'Yes' : 'No';
		}
		return unique;
	}

	getName(): string {
		return this.name;
	}

	setName(name: string): void {
		this.name = name;
	}

	getColumns(): Map<string, IndexColumn> {
		return this.columns;
	}

	getCompareData(): string {
		return JSON.stringify({ Packed: this.packed, Index_choice: this.choice, columns: this.columns.values().map(column => column.getCompareData()).toArray() });
	}
}

/** Index::getFromTableByChoice() over already loaded indexes. */
export function filterIndexesByChoice(indexes: Iterable<Index>, choices = 31): Index[] {
	const bits: Record<string, number> = { PRIMARY: INDEX_PRIMARY, UNIQUE: INDEX_UNIQUE, INDEX: INDEX_INDEX, SPATIAL: INDEX_SPATIAL, FULLTEXT: INDEX_FULLTEXT };
	return [...indexes].filter(index => (choices & (bits[index.getChoice()] ?? 0)) !== 0);
}

/** Index::findDuplicates(): a notice for each index that has an identical twin. */
export function findDuplicateIndexes(indexes: Iterable<Index>): string {
	const stack = [...indexes];
	let output = '';
	if (stack.length < 2) {
		return output;
	}
	for (let index = stack.pop(); index !== undefined; index = stack.pop()) {
		const twin = stack.find(other => other.getCompareData() === index.getCompareData());
		if (twin === undefined) {
			continue;
		}
		const message = Message.notice('The indexes %1$s and %2$s seem to be equal and one of them could possibly be removed.');
		message.addParam(twin.getName());
		message.addParam(index.getName());
		output += message.getDisplay();
	}
	return output;
}

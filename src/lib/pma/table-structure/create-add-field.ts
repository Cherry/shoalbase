// Port of PhpMyAdmin\CreateAddField: CREATE TABLE and ALTER TABLE ... ADD statements from the column definition form.
import { generateFieldSpec, getCharsetQueryPart } from './field-spec.ts';
import { backquote } from '../../twig/sanitize.ts';
import { escapeString } from '../dbi-sql.ts';
import {
	type PhpArray,
	type PhpValue,
	phpArray,
	phpEmpty,
	phpGet,
} from '../table-data/php-params.ts';

import type { ServerKind } from './types.ts';

interface IndexDefinition {
	Key_name?: string;
	Index_choice?: string;
	Index_type?: string;
	Key_block_size?: string | number;
	Parser?: string;
	Index_comment?: string;
	columns?: { col_index: number | string; size?: string | number; }[];
}

const text = (value: PhpValue | undefined): string => (typeof value === 'string' ? value : '');

// PHP's truthiness of a decoded JSON value.
const truthy = (value: unknown): boolean => value !== undefined && value !== null && value !== '' && value !== '0' && value !== 0 && value !== false;

function decodeIndexes(post: PhpArray, name: string): IndexDefinition[] {
	try {
		const decoded: unknown = JSON.parse(text(post[name]));
		if (Array.isArray(decoded)) {
			return decoded as IndexDefinition[];
		}
		if (decoded !== null && typeof decoded === 'object') {
			return Object.values(decoded) as IndexDefinition[];
		}
	} catch {
		// json_decode() gives null for invalid JSON, which upstream then fails to iterate.
	}
	return [];
}

export class CreateAddField {
	constructor(private readonly post: PhpArray, private readonly server: ServerKind) {}

	private field(name: string, index: number): PhpValue | undefined {
		return phpGet(this.post, name, index);
	}

	private prefix(isCreateTable: boolean): string {
		return isCreateTable ? '' : 'ADD ';
	}

	private suffix(previousField: number, isCreateTable: boolean): string {
		if (isCreateTable || text(this.post.field_where) === 'last') {
			return ' ';
		}
		if (previousField === -1) {
			if (text(this.post.field_where) === 'first') {
				return ' FIRST';
			}
			if (!phpEmpty(this.post.after_field)) {
				return ` AFTER ${backquote(text(this.post.after_field))}`;
			}
			return ' ';
		}
		return ` AFTER ${backquote(text(this.field('field_name', previousField)))}`;
	}

	private columnStatements(fieldCount: number, isCreateTable: boolean): string[] {
		const definitions: string[] = [];
		let previousField = -1;
		for (let index = 0; index < fieldCount; index++) {
			const name = text(this.field('field_name', index));
			if (name === '') {
				continue;
			}
			const extra = this.field('field_extra', index);
			const nullable = this.field('field_null', index);
			let definition = this.prefix(isCreateTable) + generateFieldSpec({
				name: name.trimEnd(),
				type: text(this.field('field_type', index)),
				length: text(this.field('field_length', index)),
				attribute: text(this.field('field_attribute', index)),
				collation: text(this.field('field_collation', index)),
				nullable: nullable === undefined ? 'NO' : text(nullable),
				defaultType: text(this.field('field_default_type', index)),
				defaultValue: text(this.field('field_default_value', index)),
				extra: extra === undefined ? false : text(extra),
				comment: text(this.field('field_comments', index)),
				virtuality: text(this.field('field_virtuality', index)),
				expression: text(this.field('field_expression', index)),
			}, this.server);
			definition += this.suffix(previousField, isCreateTable);
			previousField = index;
			definitions.push(definition);
		}
		return definitions;
	}

	private indexStatement(index: IndexDefinition, choice: string, isCreateTable: boolean): string {
		if (Object.keys(index).length === 0) {
			return '';
		}
		let sql = this.prefix(isCreateTable) + choice;
		if (truthy(index.Key_name) && index.Key_name !== 'PRIMARY') {
			sql += ` ${backquote(index.Key_name)}`;
		}
		const fields = (index.columns ?? []).map((column) => {
			let field = backquote(text(this.field('field_name', Number(column.col_index))).trimEnd());
			if (truthy(column.size)) {
				field += `(${String(column.size)})`;
			}
			return field;
		});
		sql += ` (${fields.join(', ')})`;
		if (truthy(index.Key_block_size)) {
			sql += ` KEY_BLOCK_SIZE = ${escapeString(String(index.Key_block_size))}`;
		}
		if (index.Index_choice !== 'SPATIAL' && index.Index_choice !== 'FULLTEXT' && (index.Index_type === 'BTREE' || index.Index_type === 'HASH')) {
			sql += ` USING ${index.Index_type}`;
		}
		if (index.Index_choice === 'FULLTEXT' && truthy(index.Parser)) {
			sql += ` WITH PARSER ${escapeString(String(index.Parser))}`;
		}
		if (truthy(index.Index_comment)) {
			sql += ` COMMENT '${escapeString(String(index.Index_comment))}'`;
		}
		return sql;
	}

	private creationStatements(isCreateTable: boolean): string {
		const names = phpArray(this.post.field_name);
		const fieldCount = names === undefined ? 0 : Object.keys(names).length;
		const definitions = this.columnStatements(fieldCount, isCreateTable);
		const primary = decodeIndexes(this.post, 'primary_indexes');
		if (primary[0] !== undefined) {
			definitions.push(this.indexStatement(primary[0], 'PRIMARY KEY', isCreateTable));
		}
		for (const [name, choice] of [['indexes', 'INDEX'], ['unique_indexes', 'UNIQUE'], ['fulltext_indexes', 'FULLTEXT'], ['spatial_indexes', 'SPATIAL']]) {
			for (const index of decodeIndexes(this.post, name)) {
				definitions.push(this.indexStatement(index, choice, isCreateTable));
			}
		}
		return definitions.join(', ').replace(/, $/, '');
	}

	private partitionDefinition(partition: PhpArray, isSubPartition = false): string {
		const value = (name: string): string => text(partition[name]);
		const filled = (name: string): boolean => !phpEmpty(partition[name]);
		let sql = ` ${isSubPartition ? 'SUB' : ''}PARTITION ${value('name')}`;
		if (filled('value_type')) {
			sql += ` VALUES ${value('value_type')}`;
			if (value('value_type') !== 'LESS THAN MAXVALUE') {
				sql += ` (${value('value')})`;
			}
		}
		const options: [string, (raw: string) => string][] = [
			['engine', raw => ` ENGINE = ${raw}`],
			['comment', raw => ` COMMENT = '${raw}'`],
			['data_directory', raw => ` DATA DIRECTORY = '${raw}'`],
			['index_directory', raw => ` INDEX_DIRECTORY = '${raw}'`],
			['max_rows', raw => ` MAX_ROWS = ${raw}`],
			['min_rows', raw => ` MIN_ROWS = ${raw}`],
			['tablespace', raw => ` TABLESPACE = ${raw}`],
			['node_group', raw => ` NODEGROUP = ${raw}`],
		];
		for (const [name, clause] of options) {
			if (filled(name)) {
				sql += clause(value(name));
			}
		}
		const subpartitions = phpArray(partition.subpartitions);
		if (subpartitions !== undefined && Object.keys(subpartitions).length > 0) {
			sql += ` (${Object.values(subpartitions).map(item => this.partitionDefinition(phpArray(item) ?? {}, true)).join(', ')})`;
		}
		return sql;
	}

	/** CreateAddField::getPartitionsDefinition(). */
	getPartitionsDefinition(): string {
		const { post } = this;
		let sql = '';
		if (!phpEmpty(post.partition_by) && !phpEmpty(post.partition_expr) && !phpEmpty(post.partition_count) && Number(post.partition_count) > 1) {
			sql += ` PARTITION BY ${text(post.partition_by)} (${text(post.partition_expr)}) PARTITIONS ${text(post.partition_count)}`;
		}
		if (!phpEmpty(post.subpartition_by) && !phpEmpty(post.subpartition_expr) && !phpEmpty(post.subpartition_count) && Number(post.subpartition_count) > 1) {
			sql += ` SUBPARTITION BY ${text(post.subpartition_by)} (${text(post.subpartition_expr)}) SUBPARTITIONS ${text(post.subpartition_count)}`;
		}
		const partitions = phpArray(post.partitions);
		if (partitions !== undefined && Object.keys(partitions).length > 0) {
			sql += ` (${Object.values(partitions).map(item => this.partitionDefinition(phpArray(item) ?? {})).join(', ')})`;
		}
		return sql;
	}

	/** CreateAddField::getTableCreationQuery(); `validEngine` is StorageEngine::isValid() for the posted engine. */
	getTableCreationQuery(db: string, table: string, validEngine: boolean): string {
		const { post } = this;
		let sql = `CREATE TABLE ${backquote(db)}.${backquote(table.trim())} (${this.creationStatements(true)})`;
		const engine = text(post.tbl_storage_engine);
		if (!phpEmpty(post.tbl_storage_engine) && engine !== 'Default' && validEngine) {
			sql += ` ENGINE = ${engine}`;
		}
		if (!phpEmpty(post.tbl_collation)) {
			sql += getCharsetQueryPart(text(post.tbl_collation));
		}
		if (!phpEmpty(post.connection) && engine === 'FEDERATED') {
			sql += ` CONNECTION = '${escapeString(text(post.connection))}'`;
		}
		if (!phpEmpty(post.comment)) {
			sql += ` COMMENT = '${escapeString(text(post.comment))}'`;
		}
		return `${sql}${this.getPartitionsDefinition()};`;
	}

	/** CreateAddField::getColumnCreationQuery(). */
	getColumnCreationQuery(table: string): string {
		let sql = `ALTER TABLE ${backquote(table)} ${this.creationStatements(false)}`;
		if (this.post.online_transaction !== undefined) {
			sql += ', ALGORITHM=INPLACE, LOCK=NONE';
		}
		return `${sql};`;
	}

	/** CreateAddField::getNumberOfFieldsFromRequest(). */
	getNumberOfFieldsFromRequest(): number {
		const { post } = this;
		const int = (value: PhpValue | undefined): number => Math.trunc(Number.parseFloat(text(value))) || 0;
		let count = 4;
		if (post.submit_num_fields !== undefined) {
			count = int(post.orig_num_fields) + int(post.added_fields);
		} else if (post.orig_num_fields !== undefined) {
			count = int(post.orig_num_fields);
		} else if (post.num_fields !== undefined && int(post.num_fields) > 0) {
			count = int(post.num_fields);
		}
		return Math.min(count, 4096);
	}
}

import { describe, expect, it } from 'vitest';

import { CreateAddField } from './create-add-field.ts';
import { nestedParams } from '../table-data/php-params.ts';

import type { RequestParams } from '../../pma-request.ts';

const mysql8 = { type: 'MySQL', version: 80400 } as const;

function create(params: RequestParams): CreateAddField {
	return new CreateAddField(nestedParams(params), mysql8);
}

const twoColumns: RequestParams = {
	'field_name[0]': 'id',
	'field_type[0]': 'INT',
	'field_default_type[0]': 'NONE',
	'field_extra[0]': 'AUTO_INCREMENT',
	'field_name[1]': 'label ',
	'field_type[1]': 'VARCHAR',
	'field_length[1]': '10',
	'field_null[1]': 'YES',
	'field_default_type[1]': 'NULL',
};

describe('CreateAddField.getTableCreationQuery', () => {
	it('builds the CREATE TABLE with indexes, engine, collation and comment', () => {
		const query = create({
			...twoColumns,
			primary_indexes: '[{"Key_name":"PRIMARY","Index_choice":"PRIMARY","columns":[{"col_index":"0","size":""}]}]',
			unique_indexes: '[{"Key_name":"uq","Index_choice":"UNIQUE","Index_type":"BTREE","Key_block_size":"8","Index_comment":"it\'s","columns":[{"col_index":1,"size":"5"}]}]',
			fulltext_indexes: '{"a":{"Key_name":"","Index_choice":"FULLTEXT","Index_type":"HASH","Parser":"ngram","columns":[{"col_index":1}]}}',
			indexes: '[{}]',
			spatial_indexes: 'not json',
			tbl_storage_engine: 'InnoDB',
			tbl_collation: 'utf8mb4_bin',
			comment: 'c',
		}).getTableCreationQuery('db', ' t ', true);
		expect(query).toBe(
			'CREATE TABLE `db`.`t` (`id` INT NOT NULL AUTO_INCREMENT , `label` VARCHAR(10) NULL DEFAULT NULL , PRIMARY KEY (`id`), , '
			+ 'UNIQUE `uq` (`label`(5)) KEY_BLOCK_SIZE = 8 USING BTREE COMMENT \'it\\\'s\', FULLTEXT (`label`) WITH PARSER ngram) '
			+ 'ENGINE = InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin COMMENT = \'c\';',
		);
	});

	it('leaves out an invalid or default engine and adds the FEDERATED connection', () => {
		expect(create({ 'field_name[0]': 'a', 'field_type[0]': 'INT', 'field_default_type[0]': 'NONE', 'tbl_storage_engine': 'Default' }).getTableCreationQuery('d', 't', true))
			.toBe('CREATE TABLE `d`.`t` (`a` INT NOT NULL );');
		expect(create({ tbl_storage_engine: 'FEDERATED', connection: 'mysql://x' }).getTableCreationQuery('d', 't', false))
			.toBe('CREATE TABLE `d`.`t` () CONNECTION = \'mysql://x\';');
	});

	it('appends the partition definition', () => {
		const query = create({
			'partition_by': 'RANGE',
			'partition_expr': 'id',
			'partition_count': '2',
			'subpartition_by': 'HASH',
			'subpartition_expr': 'id',
			'subpartition_count': '2',
			'partitions[0][name]': 'p0',
			'partitions[0][value_type]': 'LESS THAN',
			'partitions[0][value]': '10',
			'partitions[0][engine]': 'InnoDB',
			'partitions[0][comment]': 'c',
			'partitions[0][data_directory]': '/d',
			'partitions[0][index_directory]': '/i',
			'partitions[0][max_rows]': '9',
			'partitions[0][min_rows]': '1',
			'partitions[0][tablespace]': 'ts',
			'partitions[0][node_group]': 'ng',
			'partitions[0][subpartitions][0][name]': 's0',
			'partitions[1][name]': 'p1',
			'partitions[1][value_type]': 'LESS THAN MAXVALUE',
		}).getPartitionsDefinition();
		expect(query).toBe(' PARTITION BY RANGE (id) PARTITIONS 2 SUBPARTITION BY HASH (id) SUBPARTITIONS 2 ('
			+ ' PARTITION p0 VALUES LESS THAN (10) ENGINE = InnoDB COMMENT = \'c\' DATA DIRECTORY = \'/d\' INDEX_DIRECTORY = \'/i\''
			+ ' MAX_ROWS = 9 MIN_ROWS = 1 TABLESPACE = ts NODEGROUP = ng ( SUBPARTITION s0),  PARTITION p1 VALUES LESS THAN MAXVALUE)');
	});

	it('skips partitioning for a single partition', () => {
		expect(create({ partition_by: 'HASH', partition_expr: 'id', partition_count: '1', subpartition_by: 'HASH', subpartition_expr: 'id', subpartition_count: '1' }).getPartitionsDefinition()).toBe('');
	});
});

describe('CreateAddField.getColumnCreationQuery', () => {
	it('tolerates an index without columns and a partition posted as text', () => {
		expect(create({ indexes: '[{"Key_name":"k"}]', field_where: 'last' }).getColumnCreationQuery('t')).toBe('ALTER TABLE `t` ADD INDEX `k` ();');
		expect(create({ 'partition_by': 'HASH', 'partition_expr': 'id', 'partition_count': '2', 'partitions[0]': 'x', 'partitions[1][name]': 'p1', 'partitions[1][subpartitions][0]': 'y' }).getPartitionsDefinition())
			.toBe(' PARTITION BY HASH (id) PARTITIONS 2 ( PARTITION ,  PARTITION p1 ( SUBPARTITION ))');
	});
	it('places new columns after the chosen column, chaining the rest', () => {
		expect(create({ ...twoColumns, field_where: 'after', after_field: 'x', online_transaction: 'ONLINE_TRANSACTION_ENABLED' }).getColumnCreationQuery('t'))
			.toBe('ALTER TABLE `t` ADD `id` INT NOT NULL AUTO_INCREMENT AFTER `x`, ADD `label` VARCHAR(10) NULL DEFAULT NULL AFTER `id`, ALGORITHM=INPLACE, LOCK=NONE;');
	});

	it('supports first and last positions and an empty after_field', () => {
		const one = { 'field_name[0]': 'a', 'field_type[0]': 'INT', 'field_default_type[0]': 'NONE' };
		expect(create({ ...one, field_where: 'first' }).getColumnCreationQuery('t')).toBe('ALTER TABLE `t` ADD `a` INT NOT NULL FIRST;');
		expect(create({ ...one, field_where: 'last' }).getColumnCreationQuery('t')).toBe('ALTER TABLE `t` ADD `a` INT NOT NULL ;');
		expect(create({ ...one, field_where: 'after', after_field: '' }).getColumnCreationQuery('t')).toBe('ALTER TABLE `t` ADD `a` INT NOT NULL ;');
	});

	it('skips unnamed columns', () => {
		expect(create({ 'field_name[0]': '', 'field_name[1]': 'b', 'field_type[1]': 'INT', 'field_default_type[1]': 'NONE', 'field_where': 'last' }).getColumnCreationQuery('t'))
			.toBe('ALTER TABLE `t` ADD `b` INT NOT NULL ;');
	});
});

describe('CreateAddField.getNumberOfFieldsFromRequest', () => {
	it('follows the request fields in upstream order and caps at 4096', () => {
		expect(create({}).getNumberOfFieldsFromRequest()).toBe(4);
		expect(create({ submit_num_fields: '1', orig_num_fields: '3', added_fields: '2' }).getNumberOfFieldsFromRequest()).toBe(5);
		expect(create({ orig_num_fields: '6' }).getNumberOfFieldsFromRequest()).toBe(6);
		expect(create({ num_fields: '9000' }).getNumberOfFieldsFromRequest()).toBe(4096);
		expect(create({ num_fields: 'x' }).getNumberOfFieldsFromRequest()).toBe(4);
	});
});

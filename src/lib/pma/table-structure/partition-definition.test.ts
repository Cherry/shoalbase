import { describe, expect, it } from 'vitest';

import { getPartitionDetails, partitionDetailsFromStatement } from './partition-definition.ts';
import { nestedParams } from '../table-data/php-params.ts';

// Drops the PHP key order symbol that posted arrays carry.
const plain = (value: unknown): unknown => structuredClone(value);

const blank = { engine: '', comment: '', data_directory: '', index_directory: '', max_rows: '', min_rows: '', tablespace: '', node_group: '' };

describe('getPartitionDetails', () => {
	it('returns the bare details for one partition or a non-numeric count', () => {
		expect(getPartitionDetails(nestedParams({ partition_by: 'HASH', partition_count: '1' }))).toEqual({
			partition_by: 'HASH',
			partition_expr: null,
			subpartition_by: null,
			subpartition_expr: null,
			partition_count: 1,
			subpartition_count: 0,
			can_have_subpartitions: false,
			value_enabled: false,
		});
		expect(getPartitionDetails(nestedParams({ partition_count: 'x' })).partition_count).toBe(0);
	});

	it('fills missing partitions and sub partitions for range partitioning', () => {
		const details = getPartitionDetails(nestedParams({
			'partition_by': 'RANGE',
			'partition_count': ' 2 ',
			'subpartition_count': '2',
			'partitions[0][name]': 'a',
			'partitions[0][value_type]': 'LESS THAN',
			'partitions[0][value]': '5',
			'partitions[0][engine]': 'InnoDB',
			'partitions[0][subpartitions][0][name]': 'a0',
			'partitions[0][subpartitions][0][engine]': 'InnoDB',
			'partitions[1][name]': 'b',
		}));
		expect(details.can_have_subpartitions).toBe(true);
		expect(details.value_enabled).toBe(true);
		expect(plain(details.partitions)).toEqual([
			{
				name: 'a',
				value_type: 'LESS THAN',
				value: '5',
				engine: 'InnoDB',
				prefix: 'partitions[0]',
				subpartition_count: 2,
				subpartitions: [
					{ name: 'a0', engine: 'InnoDB', prefix: 'partitions[0][subpartitions][0]' },
					{ name: 'a_s1', ...blank, prefix: 'partitions[0][subpartitions][1]' },
				],
			},
			{
				name: 'b',
				value_type: '',
				value: '',
				...blank,
				prefix: 'partitions[1]',
				subpartition_count: 2,
				subpartitions: [
					{ name: 'b_s0', ...blank, prefix: 'partitions[1][subpartitions][0]' },
					{ name: 'b_s1', ...blank, prefix: 'partitions[1][subpartitions][1]' },
				],
			},
		]);
	});

	it('drops sub partitions for hash partitioning and caps the count', () => {
		const details = getPartitionDetails(nestedParams({ 'partition_by': 'HASH', 'partition_count': '9000', 'subpartition_count': '2', 'partitions[0][subpartitions][0][name]': 'x' }));
		expect(details.partition_count).toBe(8192);
		// A posted partition keeps its own fields, so it has no name here.
		expect(plain(details.partitions?.[0])).toEqual({ value_type: '', value: '', ...blank, prefix: 'partitions[0]' });
	});
});

describe('partitionDetailsFromStatement', () => {
	it('counts no sub partitions when the first partition has none', () => {
		expect(partitionDetailsFromStatement({ partitionBy: 'RANGE (a)', subpartitionBy: 'HASH (b)', partitions: [{ name: 'p0', options: null }] }).subpartition_count).toBe(0);
	});
	it('ignores sub partitions posted as text and casts a true parser value', () => {
		const posted = getPartitionDetails(nestedParams({ 'partition_by': 'LIST', 'partition_count': '2', 'subpartition_count': '2', 'partitions[0][name]': 'a', 'partitions[0][subpartitions]': 'x' }));
		expect(plain(posted.partitions?.[0].subpartitions)).toEqual([
			{ name: 'a_s0', ...blank, prefix: 'partitions[0][subpartitions][0]' },
			{ name: 'a_s1', ...blank, prefix: 'partitions[0][subpartitions][1]' },
		]);
		const parsed = partitionDetailsFromStatement({ partitionBy: 'LIST (a)', partitions: [{ name: 'p0', type: true, expr: null, options: null }] });
		expect(parsed.partitions?.[0]).toMatchObject({ value_type: '1', value: '' });
	});
	const options = (values: Record<string, unknown>) => {
		return { has: (key: string): unknown => values[key] ?? false };
	};

	it('reads the partitioning clauses and partition options', () => {
		const details = partitionDetailsFromStatement({
			partitionBy: 'RANGE (year(created))',
			subpartitionBy: 'HASH (id)',
			subpartitionsNum: 2,
			partitions: [
				{
					name: 'p0',
					type: 'LESS THAN',
					expr: '(2020)',
					options: options({ 'ENGINE': 'InnoDB', 'COMMENT': '\'c\'', 'DATA DIRECTORY': '\'/d\'', 'MAX_ROWS': true }),
					subpartitions: [{ name: 's0', options: null }],
				},
				{ name: 'p1', type: 'LESS THAN', expr: 'MAXVALUE', options: null, subpartitions: null },
			],
		});
		expect(details).toMatchObject({
			partition_by: 'RANGE',
			partition_expr: 'year(created)',
			partition_count: 2,
			subpartition_by: 'HASH',
			subpartition_expr: 'id',
			subpartition_count: 2,
			can_have_subpartitions: true,
			value_enabled: true,
		});
		expect(details.partitions?.[0]).toMatchObject({ name: 'p0', value_type: 'LESS THAN', value: '2020', engine: 'InnoDB', comment: 'c', data_directory: '/d', max_rows: true, prefix: 'partitions[0]' });
		expect(details.partitions?.[0].subpartitions).toEqual([
			{ name: 's0', engine: false, comment: '', data_directory: '', index_directory: '', max_rows: false, min_rows: false, tablespace: false, node_group: false, prefix: 'partitions[0][subpartitions][0]' },
			{ name: 'p0_s1', ...blank, prefix: 'partitions[0][subpartitions][1]' },
		]);
		expect(details.partitions?.[1]).toMatchObject({ name: 'p1', value_type: 'LESS THAN MAXVALUE', value: '' });
	});

	it('defaults to the parsed partition count and fills missing partitions', () => {
		const details = partitionDetailsFromStatement({ partitionBy: 'HASH (id)', partitionsNum: 2, partitions: [] });
		expect(details.can_have_subpartitions).toBe(false);
		expect(plain(details.partitions)).toEqual([
			{ name: 'p0', value_type: '', value: '', ...blank, prefix: 'partitions[0]' },
			{ name: 'p1', value_type: '', value: '', ...blank, prefix: 'partitions[1]' },
		]);
	});

	it('ignores clauses without brackets and an unpartitioned table', () => {
		expect(partitionDetailsFromStatement({ partitionBy: 'KEY', subpartitionBy: '0' })).toMatchObject({ partition_by: '', partition_count: 0, partitions: [] });
		expect(partitionDetailsFromStatement({}).partitions).toEqual([]);
	});

	it('takes the sub partition count from the first partition', () => {
		const details = partitionDetailsFromStatement({
			partitionBy: 'LIST (a)',
			subpartitionBy: 'KEY (b)',
			partitions: [{ name: 'p0', options: null, subpartitions: [{ name: 'x', options: null }] }, { name: 'p1', options: null }],
		});
		expect(details.subpartition_count).toBe(1);
		expect(details.partitions?.[0]).not.toHaveProperty('subpartitions');
	});
});

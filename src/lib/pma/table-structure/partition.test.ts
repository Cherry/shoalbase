import { describe, expect, it } from 'vitest';

import { partitionsFromRows } from './partition.ts';

describe('partitionsFromRows', () => {
	it('reports the sizes of a sub partition itself', () => {
		const [partition] = partitionsFromRows([{ PARTITION_NAME: 'p0', SUBPARTITION_NAME: 's0', TABLE_ROWS: '4', DATA_LENGTH: '8', INDEX_LENGTH: '2' }]);
		const [sub] = partition.getSubPartitions();
		expect([sub.getRows(), sub.getDataLength(), sub.getIndexLength()]).toEqual(['4', '8', '2']);
	});
	it('groups sub partitions under their partition and sums their sizes', () => {
		const [p0, p1] = partitionsFromRows([
			{ PARTITION_NAME: 'p0', PARTITION_ORDINAL_POSITION: '1', PARTITION_METHOD: 'RANGE', PARTITION_EXPRESSION: 'year', PARTITION_DESCRIPTION: '2020', SUBPARTITION_NAME: 'p0sp0', SUBPARTITION_ORDINAL_POSITION: '1', SUBPARTITION_METHOD: 'HASH', SUBPARTITION_EXPRESSION: 'id', TABLE_ROWS: '2', DATA_LENGTH: '16384', INDEX_LENGTH: '0', PARTITION_COMMENT: 'c' },
			{ PARTITION_NAME: 'p0', SUBPARTITION_NAME: 'p0sp1', TABLE_ROWS: '3', DATA_LENGTH: '16384', INDEX_LENGTH: null },
			{ PARTITION_NAME: 'p1', PARTITION_DESCRIPTION: 'MAXVALUE', SUBPARTITION_NAME: null, TABLE_ROWS: '5', DATA_LENGTH: '100', INDEX_LENGTH: '10' },
			{ PARTITION_NAME: null },
		]);
		expect(p0.getName()).toBe('p0');
		expect(p0.getOrdinal()).toBe('1');
		expect(p0.getMethod()).toBe('RANGE');
		expect(p0.getExpression()).toBe('year');
		expect(p0.getDescription()).toBe('2020');
		expect(p0.hasSubPartitions()).toBe(true);
		expect(p0.getRows()).toBe(5);
		expect(p0.getDataLength()).toBe(32768);
		expect(p0.getIndexLength()).toBe(0);
		// With sub partitions the partition row itself carries no comment.
		expect(p0.getComment()).toBeNull();
		const [sub] = p0.getSubPartitions();
		expect([sub.getName(), sub.getOrdinal(), sub.getMethod(), sub.getExpression(), sub.getComment()]).toEqual(['p0sp0', '1', 'HASH', 'id', 'c']);

		expect(p1.hasSubPartitions()).toBe(false);
		expect([p1.getRows(), p1.getDataLength(), p1.getIndexLength()]).toEqual(['5', '100', '10']);
	});

	it('returns nothing for unpartitioned tables', () => {
		expect(partitionsFromRows([{ PARTITION_NAME: null, TABLE_ROWS: '1' }])).toEqual([]);
	});
});

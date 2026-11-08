import { describe, expect, it } from 'vitest';

import {
	INDEX_FULLTEXT,
	INDEX_PRIMARY,
	INDEX_UNIQUE,
	Index,
	IndexColumn,
	filterIndexesByChoice,
	findDuplicateIndexes,
} from './index.ts';

const row = (keyName: string, column: string, extra: Record<string, string | null> = {}) => {
	return { Table: 't', Non_unique: '1', Key_name: keyName, Seq_in_index: '1', Column_name: column, Collation: 'A', Cardinality: '2', Sub_part: null, Packed: null, Null: '', Index_type: 'BTREE', Comment: '', Index_comment: '', ...extra };
};

describe('Index.fromRows', () => {
	it('groups SHOW INDEXES rows by key and derives the choice like Index::set()', () => {
		const indexes = Index.fromRows([
			row('PRIMARY', 'id', { Non_unique: '0', Null: '' }),
			row('ua', 'a', { Non_unique: '0', Null: 'YES' }),
			row('ab', 'a'),
			row('ab', 'b', { Seq_in_index: '2' }),
			row('ft', 'c', { Index_type: 'FULLTEXT', Cardinality: null }),
			row('sp', 'g', { Index_type: 'SPATIAL', Sub_part: '32' }),
			row('expr', null as unknown as string, { Expression: '(`a` + 1)', Seq_in_index: '1' }),
		], 'db');
		expect(indexes.values().map(index => [index.getName(), index.getChoice(), index.getType(), index.getColumnCount()]).toArray()).toEqual([
			['PRIMARY', 'PRIMARY', 'BTREE', 1],
			['ua', 'UNIQUE', 'BTREE', 1],
			['ab', 'INDEX', 'BTREE', 2],
			['ft', 'FULLTEXT', '', 1],
			['sp', 'SPATIAL', '', 1],
			['expr', 'INDEX', 'BTREE', 1],
		]);
		const ab = indexes.get('ab') as Index;
		expect(ab.getColumns().keys().toArray()).toEqual(['a', 'b']);
		expect(ab.getColumns().get('b')?.getSeqInIndex()).toBe(2);
		expect(ab.getSchema()).toBe('db');
		expect(ab.getTable()).toBe('t');
		expect(ab.hasColumn('a')).toBe(true);
		// The structure template passes `row['Field']|e`, a Twig Markup object rather than a string.
		expect(ab.hasColumn({ toString: () => 'b' })).toBe(true);
		expect(ab.hasColumn({ toString: () => 'c' })).toBe(false);
		expect(indexes.get('expr')?.getColumns().get('(`a` + 1)1')
			?.getExpression()).toBe('(`a` + 1)');
	});

	it('answers the template getters like upstream, including text forms', () => {
		const index = new Index({ Key_name: 'k', Non_unique: '0', Packed: '<p>', Comment: 'disabled', Index_comment: 'note', Key_block_size: '8', Parser: 'ngram' });
		expect(index.isUnique()).toBe(true);
		expect(index.isUnique(true)).toBe('Yes');
		expect(new Index({ Non_unique: '1' }).isUnique(true)).toBe('No');
		expect(index.isPacked()).toBe('&lt;p&gt;');
		expect(new Index().isPacked()).toBe('No');
		expect(index.getComments()).toBe('disabled\nnote');
		expect(new Index({ Index_comment: 'only' }).getComments()).toBe('only');
		expect([index.getRemarks(), index.getComment(), index.getKeyBlockSize(), index.getParser(), index.getPacked(), index.getNonUnique()]).toEqual(['disabled', 'note', '8', 'ngram', '<p>', '0']);
		expect(new Index({ Index_choice: 'FULLTEXT', Key_name: 'x' }).getChoice()).toBe('FULLTEXT');
		expect(Index.getIndexTypes()).toEqual(['BTREE', 'HASH']);
	});

	it('takes form-posted column lists and skips nameless columns', () => {
		const index = new Index({ Key_name: 'n' }, []);
		index.addColumns({ names: ['a', '', 'b'], sub_parts: ['10'] });
		expect(index.getColumns().keys().toArray()).toEqual(['a', 'b']);
		expect(index.getColumns().get('a')?.getSubPart()).toBe('10');
		index.addColumns({ names: ['c'] });
		expect(index.getColumns().get('c')?.getSubPart()).toBe('');
		index.addColumns([{ Column_name: 'd', Seq_in_index: '4' }, {}, { Expression: 'e' }]);
		expect(index.getColumns().keys().toArray()).toEqual(['a', 'b', 'c', 'd', 'e']);
		expect(Index.fromRows([{ Column_name: 'x' }], 's').get('')?.getColumnCount()).toBe(1);
		expect(filterIndexesByChoice([new Index({ Index_choice: 'ODD' })])).toEqual([]);
		expect(index.getColumns().get('d')?.getSeqInIndex()).toBe(4);
		index.setName('renamed');
		expect(index.getName()).toBe('renamed');
	});
});

describe('IndexColumn', () => {
	it('reports NULL like IndexColumn::getNull()', () => {
		expect(new IndexColumn({ Null: 'YES' }).getNull(true)).toBe('Yes');
		expect(new IndexColumn({ Null: 'NO' }).getNull(true)).toBe('No');
		expect(new IndexColumn().getNull(true)).toBe('No');
		expect(new IndexColumn({ Null: 'YES' }).getNull()).toBe('YES');
		const column = new IndexColumn({ Column_name: 'c', Collation: 'D', Cardinality: '5' });
		expect([column.getName(), column.getCollation(), column.getCardinality(), column.hasExpression()]).toEqual(['c', 'D', '5', false]);
	});
});

describe('choices and duplicates', () => {
	const indexes = Index.fromRows([row('PRIMARY', 'id', { Non_unique: '0' }), row('a1', 'a'), row('a2', 'a'), row('u', 'u', { Non_unique: '0' }), row('f', 'f', { Index_type: 'FULLTEXT' })], 'db');

	it('filters by the Index::PRIMARY | UNIQUE | ... mask', () => {
		expect(filterIndexesByChoice(indexes.values(), INDEX_PRIMARY | INDEX_UNIQUE).map(index => index.getName())).toEqual(['PRIMARY', 'u']);
		expect(filterIndexesByChoice(indexes.values(), INDEX_FULLTEXT).map(index => index.getName())).toEqual(['f']);
		expect(filterIndexesByChoice(indexes.values()).length).toBe(5);
	});

	it('reports each index that has an identical twin, with the 5.2.3 notice', () => {
		expect(findDuplicateIndexes(indexes.values())).toBe('<div class="alert alert-primary" role="alert">\n  <img src="themes/dot.gif" title="" alt="" class="icon ic_s_notice"> The indexes a1 and a2 seem to be equal and one of them could possibly be removed.\n</div>\n');
		expect(findDuplicateIndexes([new Index()])).toBe('');
	});
});

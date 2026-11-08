import { describe, expect, it } from 'vitest';

import {
	buildForeignDropdown,
	foreignDropdown,
	looseEquals,
	searchColumnInForeigners,
} from './relation.ts';

const config = { NaturalOrder: true, LimitChars: 5, ForeignKeyMaxLimit: 100, ForeignKeyDropdownOrder: ['content-id', 'id-content'] };

describe('searchColumnInForeigners', () => {
	const foreigners = {
		foreign_keys_data: [
			{ constraint: 'fk_a', index_list: ['a', 'b'], ref_table_name: 'parent', ref_index_list: ['pa', 'pb'], on_delete: 'CASCADE' },
			{ constraint: 'fk_c', index_list: ['c'], ref_db_name: 'other', ref_table_name: 'remote', ref_index_list: ['id'], on_update: 'SET NULL' },
		],
	};

	it('maps a column of a multi-column key to the matching referenced column in the current database', () => {
		expect(searchColumnInForeigners(foreigners, 'b', 'customer_db')).toEqual({
			foreign_field: 'pb', foreign_db: 'customer_db', foreign_table: 'parent', constraint: 'fk_a', on_update: 'RESTRICT', on_delete: 'CASCADE',
		});
		expect(searchColumnInForeigners(foreigners, 'c', 'customer_db')).toMatchObject({ foreign_db: 'other', foreign_table: 'remote', foreign_field: 'id', on_update: 'SET NULL', on_delete: 'RESTRICT' });
	});

	it('prefers internal relations and reports columns without a key', () => {
		const internal = { c: { foreign_db: 'x', foreign_table: 'y', foreign_field: 'z' } };
		expect(searchColumnInForeigners(internal, 'c', 'db')).toBe(internal.c);
		expect(searchColumnInForeigners(foreigners, 'missing', 'db')).toBe(false);
		expect(searchColumnInForeigners({}, 'a', 'db')).toBe(false);
		expect(searchColumnInForeigners({ foreign_keys_data: [{ constraint: 'fk_d', index_list: ['d'] }] }, 'd', 'db')).toMatchObject({ foreign_field: '', foreign_table: '', foreign_db: 'db' });
	});
});

describe('foreign drop-down', () => {
	it('compares numeric strings loosely', () => {
		expect(looseEquals('1', '01')).toBe(true);
		expect(looseEquals('a', 'A')).toBe(false);
	});

	it('sorts naturally or bytewise and truncates long display values', () => {
		const rows: [string, string][] = [['10', 'ten'], ['9', 'nine'], ['b', 'longer text']];
		expect(buildForeignDropdown(rows, '9', 'id-only', config)).toEqual([
			'<option value="9" selected="selected">9</option>',
			'<option value="10">10</option>',
			'<option value="b">b</option>',
		]);
		const bytewise = buildForeignDropdown(rows, '', 'id-content', { ...config, NaturalOrder: false });
		expect(bytewise[0]).toBe('<option value="9">9&nbsp;-&nbsp;nine</option>');
		expect(bytewise[2]).toBe('<option value="b">b&nbsp;-&nbsp;longe...</option>');
		const byContent = buildForeignDropdown([['2', 'b'], ['1', 'a']], '', 'content-id', { ...config, NaturalOrder: false });
		expect(byContent[0]).toBe('<option value="1">a&nbsp;-&nbsp;1</option>');
		expect(buildForeignDropdown(rows, '', 'unknown', config)).toEqual([]);
	});

	it('shows binary keys and values as hex', () => {
		expect(buildForeignDropdown([['\u{1}', '\u{2}']], '0x01', 'id-content', config)).toEqual(['<option value="0x01" selected="selected">0x01&nbsp;-&nbsp;0x02</option>']);
		expect(buildForeignDropdown([['\u{1}', 'x']], '01', 'id-only', config)).toEqual(['<option value="0x01" selected="selected">0x01</option>']);
	});

	it('builds both sections around a separator, or only ids without a display column', () => {
		const rows = [{ id: '1', label: 'one' }, { id: '2', label: 'two' }];
		expect(foreignDropdown(rows, 'id', 'label', '2', config)).toBe('<option value="">&nbsp;</option>'
			+ '<option value="1">one&nbsp;-&nbsp;1</option><option value="2" selected="selected">two&nbsp;-&nbsp;2</option>'
			+ '<option value="">&nbsp;</option>'
			+ '<option value="1">1&nbsp;-&nbsp;one</option><option value="2" selected="selected">2&nbsp;-&nbsp;two</option>');
		expect(foreignDropdown(rows, 'id', '', null, config)).toBe('<option value="">&nbsp;</option><option value="1">1</option><option value="2">2</option>');
	});

	it('honours the configured order, the default order and the row limit', () => {
		const rows = [{ id: '1', label: null }];
		expect(foreignDropdown(rows, 'id', 'label', undefined, { ...config, ForeignKeyDropdownOrder: { 1: 'id-only' } })).toBe('<option value="">&nbsp;</option><option value="1">1</option>');
		expect(foreignDropdown(rows, 'id', 'label', '', { ...config, ForeignKeyDropdownOrder: [false, ''] })).toBe('<option value="">&nbsp;</option>');
		expect(foreignDropdown(rows, 'id', 'label', '', { ...config, ForeignKeyDropdownOrder: null })).toBe('<option value="">&nbsp;</option><option value="1">1&nbsp;-&nbsp;</option><option value="">&nbsp;</option><option value="1">&nbsp;-&nbsp;1</option>');
		expect(foreignDropdown([{ id: null, label: 'x' }], 'id', '', '', config, 1)).toBe('<option value="">&nbsp;</option>');
		expect(foreignDropdown(rows, 'id', '', '', config, -1)).toBe('<option value="">&nbsp;</option><option value="1">1</option>');
	});
});

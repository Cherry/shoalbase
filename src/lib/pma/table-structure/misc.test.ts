import { describe, expect, it } from 'vitest';

import { createIndexFieldCount, nameAndTypeOfColumns } from './indexes.ts';
import { formatSql } from './sql-format.ts';
import { tableStatSizes } from './table-stats.ts';
import { createViewQuery } from './view.ts';
import { nestedParams } from '../table-data/php-params.ts';

describe('nameAndTypeOfColumns', () => {
	it('spaces ENUM and SET values and escapes doubled quotes', () => {
		const columns = nameAndTypeOfColumns([
			{ Field: 'k', Type: 'enum(\'a\',\'b\'\'c\')' },
			{ Field: 'n', Type: 'int' },
			{ Field: null, Type: null },
			{ Field: null, Type: 'set(\'x\')' },
		]);
		// Both unnamed rows share the '' key, so the later one wins as in a PHP array.
		expect([...columns]).toEqual([['k', String.raw`enum('a', 'b\'c')`], ['n', 'int'], ['', 'set(\'x\')']]);
	});
});

describe('createIndexFieldCount', () => {
	it('adds between 2 and 16 rows for a numeric request, else one', () => {
		expect(createIndexFieldCount('3.7')).toBe(3);
		expect(createIndexFieldCount('40')).toBe(16);
		expect(createIndexFieldCount('1')).toBe(1);
		expect(createIndexFieldCount('x')).toBe(1);
		expect(createIndexFieldCount(undefined)).toBe(1);
	});
});

describe('formatSql', () => {
	it('escapes the query and truncates only when asked', () => {
		expect(formatSql('SELECT "<a>"')).toBe('<code class="sql" dir="ltr"><pre>\nSELECT &quot;&lt;a&gt;&quot;\n</pre></code>');
		expect(formatSql('abcdef', true, 3)).toBe('<code class="sql" dir="ltr"><pre>\nabc[...]\n</pre></code>');
		expect(formatSql('abcdef', false, 3)).toContain('abcdef');
	});
});

describe('tableStatSizes', () => {
	it('computes the space usage figures', () => {
		const sizes = tableStatSizes({ Type: 'InnoDB', Data_length: '16384', Index_length: '16384', Data_free: '0', Rows: '2' }, 2, false);
		expect(sizes).toMatchObject({
			is_innodb: true,
			data_size: '16.0',
			data_unit: 'KiB',
			index_size: '16.0',
			free_size: '0',
			free_unit: 'B',
			effect_size: '32.0',
			tot_size: '32.0',
			avg_size: '16,384',
			avg_unit: 'B',
		});
	});

	it('defaults missing sizes and skips the index for merge tables', () => {
		const sizes = tableStatSizes(null, 0, true);
		expect(sizes.showtable).toEqual({ Data_length: 0, Index_length: 0 });
		expect(sizes).toMatchObject({ is_innodb: false, index_size: null, index_unit: null, free_size: null, avg_size: '', effect_size: '0', tot_size: '0' });
	});
});

describe('createViewQuery', () => {
	it('builds CREATE OR REPLACE with every option', () => {
		const view = nestedParams({
			'view[or_replace]': '1',
			'view[algorithm]': 'MERGE',
			'view[definer]': 'u@%',
			'view[sql_security]': 'INVOKER',
			'view[name]': 'v',
			'view[column_names]': 'a, b',
			'view[as]': 'SELECT 1, 2',
			'view[with]': 'LOCAL',
		}).view;
		expect(createViewQuery(view as never, true)).toBe('CREATE OR REPLACE\r\n ALGORITHM = MERGE\r\nDEFINER=`u`@`%` \r\n SQL SECURITY INVOKER\r\n VIEW `v`\r\n (a, b)\r\n AS SELECT 1, 2\r\n WITH LOCAL  CHECK OPTION');
	});

	it('builds ALTER with a bare definer and skips unknown options', () => {
		const view = { algorithm: 'merge', definer: 'u', sql_security: 'x', name: 'v', column_names: '', as: 'SELECT 1', with: 'NONE' };
		expect(createViewQuery(view, false)).toBe('ALTER\r\nDEFINER=`u`\r\n VIEW `v`\r\n AS SELECT 1');
		expect(createViewQuery({ name: 'v' }, true)).toBe('CREATE\r\n VIEW `v`\r\n AS ');
	});
});

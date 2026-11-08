import { describe, expect, it } from 'vitest';

import { searchSqls, searchWhereClause } from './search.ts';

describe('searchWhereClause', () => {
	const fields = ['id', 'name'];

	it('ORs every word across all columns for "at least one of the words"', () => {
		expect(searchWhereClause(fields, 1, 'a  b')).toBe(' WHERE (CONVERT(`id` USING utf8) LIKE \'%a%\' OR CONVERT(`name` USING utf8) LIKE \'%a%\') '
			+ ' OR  (CONVERT(`id` USING utf8) LIKE \'%b%\' OR CONVERT(`name` USING utf8) LIKE \'%b%\')');
	});

	it('ANDs the words for "all of the words"', () => {
		expect(searchWhereClause(['name'], 2, 'a b')).toBe(' WHERE (CONVERT(`name` USING utf8) LIKE \'%a%\')  AND  (CONVERT(`name` USING utf8) LIKE \'%b%\')');
	});

	it('keeps the phrase whole, without wildcards for whole fields and with REGEXP for expressions', () => {
		expect(searchWhereClause(['name'], 3, 'a b')).toBe(' WHERE (CONVERT(`name` USING utf8) LIKE \'%a b%\')');
		expect(searchWhereClause(['name'], 4, 'a b')).toBe(' WHERE (CONVERT(`name` USING utf8) LIKE \'a b\')');
		expect(searchWhereClause(['name'], 5, '^a')).toBe(' WHERE (CONVERT(`name` USING utf8) REGEXP \'^a\')');
	});

	it('limits the search to the inside column, compared loosely like PHP', () => {
		expect(searchWhereClause(['id', '10'], 3, 'x', 'id')).toBe(' WHERE (CONVERT(`id` USING utf8) LIKE \'%x%\')');
		expect(searchWhereClause(['id', '10'], 3, 'x', '1e1')).toBe(' WHERE (CONVERT(`10` USING utf8) LIKE \'%x%\')');
		expect(searchWhereClause(['id'], 3, 'x', '')).toBe(' WHERE (CONVERT(`id` USING utf8) LIKE \'%x%\')');
	});

	it('finds nothing when the inside column is missing or no word is left', () => {
		expect(searchWhereClause(fields, 3, 'x', 'nope')).toBe(' WHERE FALSE');
		expect(searchWhereClause(fields, 1, ' ')).toBe(' WHERE FALSE');
	});
});

describe('searchSqls', () => {
	it('builds the browse, count and delete queries for a table', () => {
		expect(searchSqls('d`b', 't', ' WHERE FALSE')).toEqual({
			select_columns: 'SELECT * FROM `d``b`.`t` WHERE FALSE',
			select_count: 'SELECT COUNT(*) AS `count` FROM `d``b`.`t` WHERE FALSE',
			delete: 'DELETE FROM `d``b`.`t` WHERE FALSE',
		});
	});
});

import { describe, expect, it } from 'vitest';

import { nestedParams } from './php-params.ts';
import { buildSearchQuery, getWhereClause } from './search.ts';

const version = 80400;

describe('getWhereClause', () => {
	it('quotes text, LIKE and date values but not numbers', () => {
		expect(getWhereClause('5', 'id', 'int', '>', undefined, version)).toBe('`id` > 5');
		expect(getWhereClause('5', 'id', 'int', 'LIKE', undefined, version)).toBe('`id` LIKE \'5\'');
		expect(getWhereClause('a\'b', 'name', 'varchar(10)', '=', undefined, version)).toBe('`name` = \'a\\\'b\'');
		expect(getWhereClause('x', 'name', 'text', 'LIKE %...%', undefined, version)).toBe('`name` LIKE \'%x%\'');
		expect(getWhereClause('x', 'name', 'text', 'NOT LIKE %...%', undefined, version)).toBe('`name` NOT LIKE \'%x%\'');
		expect(getWhereClause('x', 'name', 'text', 'REGEXP ^...$', undefined, version)).toBe('`name` REGEXP \'^x$\'');
	});

	it('handles unary operators and empty values', () => {
		expect(getWhereClause(undefined, 'name', 'text', 'IS NULL', undefined, version)).toBe('`name` IS NULL');
		expect(getWhereClause('', 'name', 'text', '=', undefined, version)).toBe('');
		expect(getWhereClause(undefined, 'name', 'text', '=', undefined, version)).toBe('');
	});

	it('builds IN lists with NULL for empty items and BETWEEN ranges', () => {
		expect(getWhereClause('a, ,b', 'c', 'varchar(5)', 'IN (...)', undefined, version)).toBe('`c` IN (\'a\',\'\',\'b\')');
		expect(getWhereClause('a,,b', 'c', 'varchar(5)', 'NOT IN (...)', undefined, version)).toBe('(`c` NOT IN (\'a\',\'b\') OR `c` IS NULL)');
		expect(getWhereClause(',', 'c', 'int', 'IN (...)', undefined, version)).toBe('(`c` IN (NULL) OR `c` IS NULL)');
		expect(getWhereClause('1,5', 'c', 'int', 'BETWEEN', undefined, version)).toBe('`c` BETWEEN 1 AND 5');
		expect(getWhereClause('1', 'c', 'int', 'NOT BETWEEN', undefined, version)).toBe('`c` NOT BETWEEN 1 AND ');
		expect(getWhereClause(nestedParams({ v: ['1', '2'] }).v, 'c', 'int', 'IN (...)', undefined, version)).toBe('`c` IN (1,2)');
		expect(getWhereClause(nestedParams({ v: [''] }).v, 'c', 'int', 'IN (...)', undefined, version)).toBe('`c` IS NULL');
		expect(getWhereClause(nestedParams({ v: ['x'] }).v, 'c', 'int', 'LIKE %...%', undefined, version)).toBe('`c` LIKE \'%Array%\'');
	});

	it('stringifies array values like PHP, so crafted requests build the same SQL', () => {
		const list = nestedParams({ 'v[0]': 'x', 'v[1][0]': 'nested' }).v;
		expect(getWhereClause(list, 'c', 'text', 'NOT LIKE %...%', undefined, version)).toBe('`c` NOT LIKE \'%Array%\'');
		expect(getWhereClause(list, 'c', 'text', 'REGEXP ^...$', undefined, version)).toBe('`c` REGEXP \'^Array$\'');
		expect(getWhereClause(list, 'c', 'text', '=', undefined, version)).toBe('`c` = \'\'');
		expect(getWhereClause(list, 'c', 'varchar(5)', 'IN (...)', undefined, version)).toBe('(`c` IN (\'x\') OR `c` IS NULL)');
		expect(getWhereClause({}, 'c', 'int', 'BETWEEN', undefined, version)).toBe('`c` BETWEEN  AND ');
	});

	it('turns enum selections into = or IN', () => {
		expect(getWhereClause('a', 'e', 'enum(\'a\', \'b\')', '=', undefined, version)).toBe('`e` = \'a\'');
		expect(getWhereClause('a,b', 'e', 'enum(\'a\', \'b\')', '=', undefined, version)).toBe('`e` IN (\'a\', \'b\')');
		expect(getWhereClause(nestedParams({ v: ['a', 'b'] }).v, 'e', 'ENUM(\'a\')', '!=', undefined, version)).toBe('`e` NOT IN (\'a\', \'b\')');
		expect(getWhereClause('a,b', 'e', 'enum(\'a\', \'b\')', 'LIKE', undefined, version)).toBe('`e` LIKE \'a\', \'b\'');
	});

	it('applies spatial functions', () => {
		expect(getWhereClause('', 'g', 'geometry', 'IS NULL', 'Dimension', version)).toBe('`g` IS NULL');
		expect(getWhereClause('POINT(1 1)', 'g', 'geometry', '=', 'ST_Contains', version)).toBe('ST_Contains(`g`, ST_GeomFromText(\'POINT(1 1)\'))');
		expect(getWhereClause('', 'g', 'geometry', '=', 'IsEmpty', version)).toBe('IsEmpty(`g`)');
		expect(getWhereClause('POINT(1 1)', 'g', 'linestring', '=', 'EndPoint', version)).toBe('EndPoint(`g`) = ST_GeomFromText(\'POINT(1 1)\')');
		expect(getWhereClause('2', 'g', 'geometry', '>', 'Dimension', version)).toBe('Dimension(`g`) > \'2\'');
		expect(getWhereClause('', 'g', 'geometry', '>', 'Dimension', version)).toBe('');
		expect(getWhereClause(nestedParams({ v: ['x'] }).v, 'g', 'geometry', '>', 'Unknown', version)).toBe('');
	});
});

describe('buildSearchQuery', () => {
	it('selects the chosen columns with criteria in posted order', () => {
		const post = nestedParams({
			'table': 'players',
			'distinct': 'DISTINCT',
			'columnsToDisplay': ['id', 'name'],
			'criteriaColumnOperators[0]': '>',
			'criteriaColumnNames[0]': 'id',
			'criteriaColumnTypes[0]': 'int',
			'criteriaValues[0]': '1',
			'criteriaColumnOperators[3]': 'IS NOT NULL',
			'criteriaColumnNames[3]': 'name',
			'criteriaColumnOperators[2]': '=',
			'criteriaColumnNames[2]': 'score',
			'criteriaColumnTypes[2]': 'int',
			'criteriaValues[2]': '',
			'orderByColumn': 'name',
			'order': 'DESC',
		});
		expect(buildSearchQuery(post, version)).toBe('SELECT DISTINCT `id`, `name` FROM `players` WHERE `id` > 1 AND `name` IS NOT NULL ORDER BY `name` DESC');
	});

	it('uses SELECT * for zoom search and a custom WHERE body when given', () => {
		expect(buildSearchQuery(nestedParams({ table: 't', zoom_submit: 'Go', customWhereClause: ' a = 1 ', orderByColumn: '--nil--' }), version)).toBe('SELECT * FROM `t` WHERE  a = 1 ');
		expect(buildSearchQuery(nestedParams({ table: 't', displayAllColumns: '1', customWhereClause: '  ' }), version)).toBe('SELECT * FROM `t`');
		expect(buildSearchQuery(nestedParams({ 'table': 't', 'criteriaColumnOperators[0]': '=', 'criteriaValues[0]': '' }), version)).toBe('SELECT  FROM `t`');
		expect(buildSearchQuery(nestedParams({ 'columnsToDisplay[0][x]': 'y' }), version)).toBe('SELECT  FROM ');
		expect(buildSearchQuery(nestedParams({ 'table': 't', 'displayAllColumns': '1', 'orderByColumn': 'a', 'criteriaColumnOperators[0][x]': 'IS NULL' }), version)).toBe('SELECT * FROM `t` ORDER BY `a` ');
	});
});

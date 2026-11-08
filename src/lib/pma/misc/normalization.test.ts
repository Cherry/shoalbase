import { describe, expect, it } from 'vitest';

import {
	columnsListHtml,
	distinctValuesQuery,
	isPartialDependency,
	moveRepeatingGroupQueries,
	newTables2NfHtml,
	newTables2NfQueries,
	newTables3Nf,
	newTables3NfQueries,
	normalizeTableHtml,
	oneNfStep1Html,
	oneNfStep2,
	oneNfStep3,
	oneNfStep4,
	partialDependenciesHtml,
	partialDependencyQuery,
	partialKeyCombinations,
	threeNfStep1,
	twoNfStep1,
} from './normalization.ts';

describe('columnsListHtml', () => {
	const columns = [{ name: 'a<', type: 'varchar(10)' }, { name: 'n', type: 'int(11) unsigned' }];

	it('filters by column type and escapes names', () => {
		expect(columnsListHtml(columns, ['VARCHAR'], 'dropdown')).toBe('<option value="a&lt;">a&lt; [ varchar(10) ]</option>');
		expect(columnsListHtml(columns, [], 'checkbox')).toBe('<input type="checkbox" value="a&lt;">a&lt; [ varchar(10) ]<br><input type="checkbox" value="n">n [ int(11) unsigned ]<br>');
	});
});

describe('1NF steps', () => {
	it('carries the target normal form and the column choices into the forms', () => {
		expect(oneNfStep1Html('3nf', '<option>x</option>')).toContain('<div id=\'mainContent\' data-normalizeto=\'3nf\'>');
		expect(oneNfStep1Html('3nf', '<option>x</option>')).toContain('No such column</option><option>x</option></select>');
		expect(oneNfStep4('<input>').extra.startsWith('<input><br><input class="btn btn-secondary" type="submit" id="removeRedundant"')).toBe(true);
		expect(normalizeTableHtml('index.php?route=/normalization', '<hidden>')).toMatch(/^<form method="post" action="index.php\?route=\/normalization" name="normalize" id="normalizeTable" ><hidden>/);
	});

	it('offers to add a primary key only when there is none', () => {
		expect(oneNfStep2(true, 'icon')).toMatchObject({ hasPrimaryKey: '1', extra: '' });
		expect(oneNfStep2(false, 'icon')).toMatchObject({ hasPrimaryKey: '0', subText: '<a href="#" id="createPrimaryKey">icon</a>' });
		expect(oneNfStep3('', ['a/b']).primary_key).toBe(String.raw`["a\/b"]`);
	});
});

describe('twoNfStep1', () => {
	it('only asks about partial dependencies for composite keys with other columns', () => {
		expect(twoNfStep1(['id'], ['id', 'x']).extra).toBe('<h3>Table is already in second normal form.</h3>');
		expect(twoNfStep1(['a', 'b'], ['a', 'b']).headText).toContain('is composed of all the columns');
		const asked = twoNfStep1(['a', 'b'], ['a', 'b', 'c']);
		expect(asked.primary_key).toBe('a, b');
		expect(asked.extra).toBe('<b>\'c\' depends on:</b><br><form id="pk_1" data-colname="c" class="smallIndent">'
			+ '<input type="checkbox" name="pd" value="a">a<input type="checkbox" name="pd" value="b">b</form><br><br>');
	});
});

describe('2NF tables', () => {
	const dependencies = { 'id': ['city'], 'id, part': ['note'] };

	it('names the new tables after the original one', () => {
		expect(newTables2NfHtml({ id: [], part: ['x'] }, 't')).toBe('<p><b>In order to put the original table \'t\' into Second normal form we need to create the following tables:</b></p>'
			+ '<p><input type="text" name="id" value="t">( <u>id</u> )<p><input type="text" name="part" value="table2">( <u>part</u>, x )');
	});

	it('creates the split tables, then drops moved columns or the original table', () => {
		expect(newTables2NfQueries({ id: [] }, { id: 'x' }, 't')).toEqual([]);
		expect(newTables2NfQueries(dependencies, { 'id': 't2', 'id, part': 't' }, 't')).toEqual([
			'CREATE TABLE `t2` SELECT DISTINCT `id`, `city` FROM `t`;',
			'ALTER TABLE `t2` ADD PRIMARY KEY(`id`);',
			'ALTER TABLE `t` DROP `city`;',
		]);
		expect(newTables2NfQueries({ a: [], b: ['c'] }, { a: 'x', b: 'y' }, 't')).toEqual([
			'CREATE TABLE `x` SELECT DISTINCT `a` FROM `t`;',
			'ALTER TABLE `x` ADD PRIMARY KEY(`a`);',
			'CREATE TABLE `y` SELECT DISTINCT `b`, `c` FROM `t`;',
			'ALTER TABLE `y` ADD PRIMARY KEY(`b`);',
			'DROP TABLE `t`',
		]);
	});
});

describe('3NF tables', () => {
	it('skips tables without transitive dependencies and repeated column sets', () => {
		const result = newTables3Nf({ t: ['b'], c: ['d'], e: [] }, { t: ['t', 'c', 'c'], u: ['u', 'u'] }, { t: ['a'] });
		expect(result.newTables).toEqual({ t: { t: { pk: 'a', nonpk: 'b' }, table2: { pk: 'c', nonpk: 'd' } } });
		expect(result.html).toContain('<input type="text" name="table2" value="table2">( <u>c</u>, d )');
		expect(newTables3Nf({}, { v: ['v', 'x'] }, {}).newTables).toEqual({ v: { v: { pk: '', nonpk: '' }, table2: { pk: 'x', nonpk: '' } } });
	});

	it('creates the new tables and keeps only the listed columns of the original', () => {
		const queries = newTables3NfQueries({ t: { t: { pk: 'a', nonpk: 'b' }, t2: { pk: 'c', nonpk: 'd, e' } }, u: { u2: { pk: 'x', nonpk: 'y' } } }, () => ['a', 'b', 'c', 'd']);
		expect(queries).toEqual([
			'CREATE TABLE `t2` SELECT DISTINCT `c`, `d`, `e` FROM `t`;',
			'ALTER TABLE `t2` ADD PRIMARY KEY(`c`);',
			'ALTER TABLE `t` DROP `c`, DROP `d`;',
			'CREATE TABLE `u2` SELECT DISTINCT `x`, `y` FROM `u`;',
			'ALTER TABLE `u2` ADD PRIMARY KEY(`x`);',
			'DROP TABLE `u`',
		]);
	});

	it('asks about transitive dependencies of tables with two or more non-key columns', () => {
		expect(threeNfStep1([{ name: 't', primaryKey: ['a'], columns: ['a', 'b'] }]).extra).toBe('<h3>Table is already in Third normal form!</h3>');
		const step = threeNfStep1([{ name: 't', primaryKey: ['a'], columns: ['a', 'b', 'c'] }]);
		expect(step.extra).toContain('<form id="td_2" data-colname="c" data-tablename="t" class="smallIndent"><input type="checkbox" name="pd" value="b"><span>b</span>');
	});
});

describe('repeating groups', () => {
	it('unions the repeated columns into a new table and drops them', () => {
		expect(moveRepeatingGroupQueries('a1, a2', 'id,k', 'n', 'v', 't')).toEqual([
			'CREATE TABLE `n` SELECT `id`,`k`,`a1` as `v` FROM `t` UNION  SELECT `id`,`k`,`a2` as `v` FROM `t`',
			'ALTER TABLE `t` DROP `a1`, DROP `a2`',
		]);
	});
});

describe('partial dependencies', () => {
	it('builds every proper subset of the key', () => {
		expect(partialKeyCombinations(['`a`', '`b`', '`c`'])).toEqual(['', '`a`', '`b`', '`b`,`a`', '`c`', '`c`,`a`', '`c`,`b`']);
		expect(distinctValuesQuery(['`a`', '', '`b`,`a`'], 't')).toBe('SELECT COUNT(DISTINCT `a`) as \'`a`_cnt\', COUNT(DISTINCT `b`,`a`) as \'`b`,`a`_cnt\' FROM (SELECT * FROM `t` LIMIT 500) as dt;');
		expect(partialDependencyQuery('`a`', '`x`', 't')).toBe('SELECT COUNT(DISTINCT `a`,`x`) as pkColCnt FROM (SELECT * FROM `t` LIMIT 500) as dt;');
	});

	it('decides from the distinct counts like checkPartialDependency()', () => {
		expect(isPartialDependency('3', '3', '3', '4')).toBe(true);
		expect(isPartialDependency('3', '2', '3', '3')).toBe(true);
		expect(isPartialDependency('0', '0', '0', '0')).toBe(false);
		expect(isPartialDependency(null, null, null, null)).toBe(false);
	});

	it('lists the found dependencies without backquotes', () => {
		expect(partialDependenciesHtml(new Map())).toContain('No partial dependencies found!');
		expect(partialDependenciesHtml(new Map([['`a`', ['`b`', '`c`']]]))).toContain('<span class="determinants">a</span> -> <span class="dependents">b, c</span>');
	});
});

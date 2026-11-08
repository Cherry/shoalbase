import { describe, expect, it } from 'vitest';

import {
	DesignerTable,
	columnsType,
	rawurlencode,
	scriptContr,
	scriptTabs,
} from './designer.ts';

const innodb = new DesignerTable('d b', 'parent', 'InnoDB', 'name');
const myisam = new DesignerTable('d b', 'child', 'MyISAM', null);

describe('DesignerTable', () => {
	it('exposes its names and whether its engine has foreign keys', () => {
		expect(innodb.getDatabaseName()).toBe('d b');
		expect(innodb.getTableName()).toBe('parent');
		expect(innodb.getDbTableString()).toBe('d b.parent');
		expect(innodb.getTableEngine()).toBe('InnoDB');
		expect(innodb.getDisplayField()).toBe('name');
		expect(innodb.supportsForeignkeys()).toBe(true);
		expect(myisam.supportsForeignkeys()).toBe(false);
	});
});

describe('columnsType', () => {
	it('picks the key icon for unique columns and a type icon for the others', () => {
		const tabColumn = new Map([['d b.parent', {
			COLUMN_ID: [0, 1, 2, 3, 4, 5],
			COLUMN_NAME: ['id', 'name', 'price', 'born', 'blob', 'body'],
			TYPE: ['int(11)', 'varchar(5)', 'decimal(5,2)', 'datetime', 'blob', 'mediumtext'],
			NULLABLE: ['NO', 'YES', 'YES', 'YES', 'YES', 'YES'],
		}]]);
		const types = columnsType([innodb, myisam], tabColumn, new Map([['d b.parent.id', 1]]));
		expect([...types]).toEqual([
			['d b.parent.id', 'designer/FieldKey_small'],
			['d b.parent.name', 'designer/Field_small_char'],
			['d b.parent.price', 'designer/Field_small_int'],
			['d b.parent.born', 'designer/Field_small_date'],
			['d b.parent.blob', 'designer/Field_small'],
			['d b.parent.body', 'designer/Field_small_char'],
		]);
	});
});

describe('scriptTabs', () => {
	it('encodes each table and flags foreign key support', () => {
		expect(scriptTabs([innodb, myisam])).toEqual({ j_tabs: { 'd%20b.parent': 1, 'd%20b.child': 0 }, h_tabs: { 'd%20b.parent': 1, 'd%20b.child': 1 } });
	});

	it('gives empty lists, as PHP encodes empty arrays, without tables', () => {
		expect(scriptTabs([])).toEqual({ j_tabs: [], h_tabs: [] });
	});
});

describe('rawurlencode', () => {
	it('escapes the characters encodeURIComponent() keeps', () => {
		expect(rawurlencode('a b!*\'()~')).toBe('a%20b%21%2A%27%28%29~');
	});
});

describe('scriptContr', () => {
	it('keeps the columns of constraints between shown tables only', () => {
		const constraint = { name: 'fk', sourceTable: 'd%20b.child', sourceColumn: 'pid', targetTable: 'd%20b.parent', targetColumn: 'id' };
		const hidden = { ...constraint, name: 'fk2', targetTable: 'd%20b.gone' };
		expect(scriptContr([constraint, hidden], [innodb, myisam])).toEqual([
			{ fk: { 'd%20b.child': { pid: ['d%20b.parent', 'id'] } } },
			{ fk2: [] },
		]);
	});
});

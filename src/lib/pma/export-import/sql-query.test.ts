import { describe, expect, it } from 'vitest';

import { tableExportQuery } from './sql-query.ts';

describe('tableExportQuery', () => {
	it('drops LIMIT from a SELECT', () => {
		expect(tableExportQuery('SELECT * FROM `t` LIMIT 0, 25', null)).toBe('SELECT * FROM `t`  ');
	});

	it('replaces the WHERE clause with the picked rows', () => {
		expect(tableExportQuery('SELECT * FROM `t` WHERE a = 1 LIMIT 5', ['`t`.`id` = 1', '`t`.`id` = 2'])).toBe('SELECT * FROM `t` WHERE (`t`.`id` = 1) OR (`t`.`id` = 2)   ');
	});

	it('leaves anything but a SELECT alone', () => {
		expect(tableExportQuery('SHOW TABLES', ['x'])).toBe('SHOW TABLES');
	});
});

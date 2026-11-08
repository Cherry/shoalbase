import { describe, expect, it } from 'vitest';

import {
	getAllFunctions,
	getFunctions,
	getFunctionsClass,
	getIntegerRange,
	getTypeClass,
	getTypeOperators,
	getTypeOperatorsHtml,
	isUnaryOperator,
} from './types.ts';

const mysql84 = { isMariaDB: false, version: 80400 };

describe('getTypeClass', () => {
	it('classifies types case-insensitively', () => {
		expect(getTypeClass('int')).toBe('NUMBER');
		expect(getTypeClass('Timestamp')).toBe('DATE');
		expect(getTypeClass('INET6')).toBe('CHAR');
		expect(getTypeClass('point')).toBe('SPATIAL');
		expect(getTypeClass('json')).toBe('JSON');
		expect(getTypeClass('uuid')).toBe('UUID');
		expect(getTypeClass('unknown')).toBe('');
		expect(getTypeClass(null)).toBe('');
	});
});

describe('function lists', () => {
	it('drops the INET6 functions on servers without them', () => {
		expect(getFunctionsClass('CHAR', mysql84)).toContain('INET6_NTOA');
		expect(getFunctionsClass('CHAR', { isMariaDB: false, version: 50602 })).not.toContain('INET6_NTOA');
		expect(getFunctionsClass('NUMBER', { isMariaDB: true, version: 100011 })).not.toContain('INET6_ATON');
		expect(getFunctionsClass('NUMBER', mysql84)).toContain('INET6_ATON');
	});

	it('uses the ST_ spatial names from MySQL 5.6', () => {
		expect(getFunctionsClass('SPATIAL', mysql84)[0]).toBe('ST_GeomFromText');
		expect(getFunctionsClass('SPATIAL', { isMariaDB: false, version: 50599 })[0]).toBe('GeomFromText');
		expect(getFunctions('date', mysql84)).toContain('NOW');
		expect(getFunctions('json', mysql84)).toEqual([]);
	});

	it('sorts all functions bytewise like PHP sort()', () => {
		const all = getAllFunctions(mysql84);
		expect(all.slice(0, 3)).toEqual(['ABS', 'ACOS', 'AES_DECRYPT']);
		expect(all.indexOf('SQRT')).toBeLessThan(all.indexOf('ST_GeomCollFromText'));
		expect(all).toHaveLength(117);
	});
});

describe('integer ranges and operators', () => {
	it('returns signed and unsigned ranges, and empty strings for other types', () => {
		expect(getIntegerRange('tinyint')).toEqual(['-128', '127']);
		expect(getIntegerRange('bigint', false)).toEqual(['0', '18446744073709551615']);
		expect(getIntegerRange('float')).toEqual(['', '']);
	});

	it('lists operators by type and nullability', () => {
		expect(getTypeOperators('enum', false)).toEqual(['=', '!=']);
		expect(getTypeOperators('varchar', true).at(-1)).toBe('IS NOT NULL');
		expect(getTypeOperators('uuid', false)).toHaveLength(8);
		expect(getTypeOperators('int', false)[1]).toBe('>');
		expect(isUnaryOperator('IS NULL')).toBe(true);
		expect(isUnaryOperator('=')).toBe(false);
	});

	it('renders operator options with the selected one marked', () => {
		const html = getTypeOperatorsHtml('enum', false, '!=');
		expect(html).toBe('<option value="=">=</option><option value="!=" selected="selected">!=</option>');
		expect(getTypeOperatorsHtml('enum', false)).not.toContain('selected');
	});
});

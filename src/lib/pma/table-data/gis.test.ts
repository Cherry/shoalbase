import { describe, expect, it } from 'vitest';

import { createGisData, getGisFunctions } from './gis.ts';

describe('getGisFunctions', () => {
	it('mixes display separators with named functions in PHP array order', () => {
		const functions = getGisFunctions('point', true, true, 80400);
		expect(functions.slice(0, 2)).toEqual([['0', { display: ' ' }], ['Dimension', { params: 1, type: 'int' }]]);
		expect(functions.map(([key]) => key)).toContain('ST_X');
		expect(functions.filter(([, item]) => item.display === '--------')).toHaveLength(3);
		expect(functions.at(-1)).toEqual(['MBRWithin', { params: 2, type: 'int' }]);
	});

	it('adds the type specific unary functions without the ST_ prefix on old servers', () => {
		const names = (type: string): string[] => getGisFunctions(type, false, false, 50600).map(([key]) => key);
		expect(names('linestring')).toContain('IsRing');
		expect(names('multilinestring')).toContain('IsClosed');
		expect(names('polygon')).toContain('ExteriorRing');
		expect(names('multipolygon')).toContain('Centroid');
		expect(names('geometrycollection')).toContain('NumGeometries');
		expect(names('point')).toContain('X');
		expect(names('geometry')).toHaveLength(6);
		expect(getGisFunctions(null, true, false, 50600).map(([key]) => key)).toContain('Crosses');
		expect(getGisFunctions('multipoint', false, true, 80400)).toHaveLength(7);
	});
});

describe('createGisData', () => {
	it('wraps WKT with or without an SRID', () => {
		expect(createGisData(' \'POINT(1 2)\',4326 ', 80400)).toBe('ST_GeomFromText(\'POINT(1 2)\',4326)');
		expect(createGisData('point(1 2)', 50500)).toBe('GeomFromText(\'point(1 2)\')');
		expect(createGisData('1', 80400)).toBe('1');
	});
});

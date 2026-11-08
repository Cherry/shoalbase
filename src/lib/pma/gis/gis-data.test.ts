import { describe, expect, it } from 'vitest';

import {
	type GisArray,
	type GisValue,
	arrayMerge,
	generateParams,
	generateWkt,
	gisDataToTwig,
	gisGet,
	gisType,
	toGisArray,
	validateGisData,
} from './gis-data.ts';
import { nestedParams } from '../table-data/php-params.ts';

/** gis_data from posted fields, as the editor form sends them. */
function posted(fields: Record<string, string>): GisArray {
	const params = nestedParams(Object.fromEntries(Object.entries(fields).map(([name, value]) => [`gis_data${name}`, value])));
	return toGisArray(params.gis_data as Exclude<typeof params.gis_data, string>);
}

describe('generateParams and generateWkt', () => {
	it.each([
		['POINT', 'POINT(1.5 -2)'],
		['MULTIPOINT', 'MULTIPOINT(1 1,2 2,3 3)'],
		['LINESTRING', 'LINESTRING(0 0,5 5,10 0)'],
		['MULTILINESTRING', 'MULTILINESTRING((0 0,1 1),(2 2,3 3,4 5))'],
		['POLYGON', 'POLYGON((0 0,10 0,10 10,0 0),(1 1,2 1,2 2,1 1))'],
		['MULTIPOLYGON', 'MULTIPOLYGON(((0 0,10 0,10 10,0 10,0 0),(2 2,3 2,3 3,2 2)),((20 20,30 20,30 30,20 20)))'],
		['GEOMETRYCOLLECTION', 'GEOMETRYCOLLECTION(POINT(1 2),LINESTRING(0 0,5 5),POLYGON((0 0,4 0,4 4,0 0)))'],
	] as const)('turns %s back into the same WKT', (type, wkt) => {
		const params = generateParams(type, wkt);
		expect(params.get('srid')).toBe(0);
		expect(generateWkt(type, params, 0)).toBe(wkt);
	});

	it('reads the SRID of a quoted value and the WKT inside the quotes', () => {
		const params = generateParams('POINT', '\'POINT(3 4)\',4326');
		expect(params.get('srid')).toBe(4326);
		expect(gisGet(params, 0, 'POINT', 'x')).toBe(3);
		expect(generateWkt('POINT', params, 0)).toBe('POINT(3 4)');
	});

	it('falls back to zero coordinates for a value that is not WKT', () => {
		const params = generateParams('LINESTRING', 'junk');
		expect(gisGet(params, 0, 'LINESTRING', 'no_of_points')).toBe(1);
		expect(generateWkt('LINESTRING', params, 0)).toBe('LINESTRING(0 0, )');
	});

	it('pads blank coordinates with the given filler and enforces the minimum point counts', () => {
		const data = posted({ '[0][POLYGON][no_of_lines]': '1', '[0][POLYGON][0][no_of_points]': '2', '[0][POLYGON][0][0][x]': '1', '[0][POLYGON][0][0][y]': ' ' });
		expect(generateWkt('POLYGON', data, 0)).toBe('POLYGON((1 , , , ))');
		expect(generateWkt('POLYGON', data, 0, '0')).toBe('POLYGON((1 0,0 0,0 0,0 0))');
	});

	it('ignores the filler for points and multipoints', () => {
		expect(generateWkt('POINT', new Map(), 0, '0')).toBe('POINT( )');
		expect(generateWkt('MULTIPOINT', new Map(), 0, '0')).toBe('MULTIPOINT( )');
	});

	it('uses the default count for non-numeric counts and bounds huge ones', () => {
		expect(generateWkt('MULTILINESTRING', posted({ '[0][MULTILINESTRING][no_of_lines]': 'abc' }), 0, '0')).toBe('MULTILINESTRING((0 0,0 0))');
		const huge = generateWkt('LINESTRING', posted({ '[0][LINESTRING][no_of_points]': '1e9' }), 0);
		expect(huge.split(',')).toHaveLength(10000);
	});

	it('loops a fractional count up to the next whole point', () => {
		expect(generateWkt('MULTIPOINT', new Map([['0', new Map<string, GisValue>([['MULTIPOINT', new Map<string, GisValue>([['no_of_points', 2.5]])]])]]), 0)).toBe('MULTIPOINT( , , )');
	});

	it('prints a posted array coordinate the way PHP casts it', () => {
		expect(generateWkt('POINT', posted({ '[0][POINT][x][a]': '1', '[0][POINT][y]': '2' }), 0)).toBe('POINT(Array 2)');
	});

	it('builds a collection from posted members, skipping unknown types', () => {
		const data = posted({ '[GEOMETRYCOLLECTION][geom_count]': '3', '[0][gis_type]': 'POINT', '[0][POINT][x]': '1', '[0][POINT][y]': '2', '[1][gis_type]': 'CIRCLE', '[2][gis_type]': 'MULTIPOLYGON' });
		expect(generateWkt('GEOMETRYCOLLECTION', data, 0, '0')).toBe('GEOMETRYCOLLECTION(POINT(1 2),MULTIPOLYGON(((0 0,0 0,0 0,0 0))))');
	});

	it('keeps the trailing comma when the first member has no type, as upstream does', () => {
		const data = posted({ '[GEOMETRYCOLLECTION][geom_count]': '2', '[1][gis_type]': 'POINT', '[1][POINT][x]': '3' });
		expect(generateWkt('GEOMETRYCOLLECTION', data, 0)).toBe('GEOMETRYCOLLECTION(POINT(3 ),)');
	});

	it('stops at one level when a member is itself a collection', () => {
		const data = posted({ '[0][gis_type]': 'GEOMETRYCOLLECTION' });
		expect(generateWkt('GEOMETRYCOLLECTION', data, 0)).toBe('GEOMETRYCOLLECTION()');
	});

	it('merges a nested collection over the outer one and skips parts without a known type', () => {
		const params = generateParams('GEOMETRYCOLLECTION', 'GEOMETRYCOLLECTION(POINT(1 2),GEOMETRYCOLLECTION(POINT(3 4),LINESTRING(1 1,2 2)),BOX(1),POINT(5 6))');
		expect(gisGet(params, 'GEOMETRYCOLLECTION', 'geom_count')).toBe(2);
		expect([0, 1, 2, 3].map(index => gisGet(params, index, 'gis_type'))).toEqual(['POINT', 'POINT', 'LINESTRING', 'POINT']);
		expect(gisGet(params, 3, 'POINT', 'x')).toBe(5);
	});
});

describe('arrayMerge', () => {
	it('renumbers integer keys and replaces string keys in place', () => {
		const merged = arrayMerge(new Map<string, GisValue>([['0', 'a'], ['gis_type', 'POINT'], ['5', 'b']]), new Map<string, GisValue>([['gis_type', 'LINESTRING'], ['0', 'c'], ['07', 'd']]));
		expect([...merged]).toEqual([['0', 'a'], ['gis_type', 'LINESTRING'], ['1', 'b'], ['2', 'c'], ['07', 'd']]);
	});
});

describe('gisType and gisGet', () => {
	it('accepts the geometry names in any case', () => {
		expect(gisType('multiPoint')).toBe('MULTIPOINT');
		expect(gisType('GEOMETRY')).toBeNull();
	});

	it('stops at scalars', () => {
		expect(gisGet(new Map([['a', 'text']]), 'a', 'b')).toBeUndefined();
	});
});

describe('validateGisData', () => {
	it('keeps a valid posted type', () => {
		expect(validateGisData(posted({ '[gis_type]': 'POLYGON' }), 'point', 'POINT(1 1)')).toBe('POLYGON');
	});

	it('prefers the type the value starts with over the column type', () => {
		const data: GisArray = new Map();
		expect(validateGisData(data, 'geometry', '\'LINESTRING(1 1,2 2)\',0')).toBe('LINESTRING');
		expect(data.get('gis_type')).toBe('LINESTRING');
	});

	it('uses the column type and falls back to POINT', () => {
		expect(validateGisData(new Map(), 'multipolygon', '  ')).toBe('MULTIPOLYGON');
		expect(validateGisData(new Map(), 'geometry', 'point(1 2)')).toBe('POINT');
		expect(validateGisData(posted({ '[gis_type]': 'BOX' }), '', undefined)).toBe('POINT');
	});
});

describe('gisDataToTwig', () => {
	it('turns integer keys into numbers and reads missing keys as null or as empty nested arrays', () => {
		const twig = gisDataToTwig(posted({ '[0][LINESTRING][0][x]': '1' })) as Map<string | number, unknown>;
		expect(twig.has('anything')).toBe(true);
		expect(twig.get(1)).toBeNull();
		const geometry = twig.get(0) as Map<string | number, unknown>;
		const line = geometry.get('LINESTRING') as Map<string | number, unknown>;
		expect((line.get(0) as Map<string, unknown>).get('x')).toBe('1');
		expect((line.get(1) as Map<string, unknown>).get('add_point')).toBeNull();
		expect((geometry.get('POLYGON') as Map<string, unknown>).size).toBe(0);
		expect(line.get('add_point')).toBeNull();
	});

	it('passes scalars through', () => {
		expect(gisDataToTwig('POINT')).toBe('POINT');
	});
});

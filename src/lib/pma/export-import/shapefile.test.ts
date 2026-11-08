import { describe, expect, it } from 'vitest';

import {
	multiLineStringShape,
	multiPointShape,
	multiPolygonShape,
	pointShape,
	readShapeFile,
	shapeName,
} from './shapefile.ts';

const doubles = (...values: number[]): number[] => {
	const buffer = new ArrayBuffer(values.length * 8);
	const view = new DataView(buffer);
	for (const [index, value] of values.entries()) {
		view.setFloat64(index * 8, value, true);
	}
	return [...new Uint8Array(buffer)];
};
const uint32 = (littleEndian: boolean, ...values: number[]): number[] => {
	const buffer = new ArrayBuffer(values.length * 4);
	const view = new DataView(buffer);
	for (const [index, value] of values.entries()) {
		view.setUint32(index * 4, value, littleEndian);
	}
	return [...new Uint8Array(buffer)];
};

/** A .shp file: the 100 byte header, then each record with its big-endian number and length in 16-bit words. */
function shapeFile(type: number, records: [number, number[]][], measure: [number, number] = [0, 0]): Uint8Array {
	const header = [...uint32(false, 9994),
		...Array.from({ length: 20 }, () => 0),
		...uint32(false, 0),
		...uint32(true, 1000, type),
		...doubles(0, 0, 10, 10, 0, 0, ...measure)];
	const body = records.flatMap(([recordType, content], index) => {
		const data = [...uint32(true, recordType), ...content];
		return [...uint32(false, index + 1, data.length / 2), ...data];
	});
	return new Uint8Array([...header, ...body]);
}
const box = doubles(0, 0, 10, 10);
type Point = [number, number];
const poly = (...rings: Point[][]): number[] => {
	let start = 0;
	const starts = rings.map((ring) => {
		const first = start;
		start += ring.length;
		return first;
	});
	return [...box, ...uint32(true, rings.length, start), ...uint32(true, ...starts), ...doubles(...rings.flat().flat())];
};

// The WKT here matches what the 5.2.3 oracle sent to MySQL for the same files.
describe('readShapeFile', () => {
	it('reads points', () => {
		const result = readShapeFile(shapeFile(1, [[1, doubles(1.5, 2)], [1, doubles(-3, 0.1 + 0.2)]]));
		expect(result.lastError).toBe('');
		expect(result.records.map(record => pointShape(record))).toEqual(['POINT(1.5 2)', 'POINT(-3 0.3)']);
	});

	it('reads polygons, putting a hole into the clockwise ring around it', () => {
		const outer: Point[] = [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]];
		const hole: Point[] = [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]];
		const second: Point[] = [[20, 20], [20, 30], [30, 30], [20, 20]];
		const [record] = readShapeFile(shapeFile(5, [[5, poly(outer, hole, second)]])).records;
		expect(multiPolygonShape(record)).toBe('MULTIPOLYGON(((0 0,0 10,10 10,10 0,0 0),(2 2,4 2,4 4,2 4,2 2)),((20 20,20 30,30 30,20 20)))');
	});

	it('reads lines and multipoints', () => {
		const [lines] = readShapeFile(shapeFile(3, [[3, poly([[0, 0], [1, 1]], [[2, 2], [3, 3], [4, 5]])]])).records;
		expect(multiLineStringShape(lines)).toBe('MULTILINESTRING((0 0,1 1),(2 2,3 3,4 5))');
		const [points] = readShapeFile(shapeFile(8, [[8, [...box, ...uint32(true, 2), ...doubles(0, 0, 1, 1)]]])).records;
		expect(multiPointShape(points)).toBe('MULTIPOINT(0 0,1 1)');
	});

	it('reads the Z and M variants, with M only when the file has a measure range', () => {
		expect(readShapeFile(shapeFile(11, [[11, doubles(1, 2, 3, 4)]])).records[0]).toEqual({ x: 1, y: 2, z: 3, m: 4 });
		expect(readShapeFile(shapeFile(21, [[21, doubles(1, 2, 4)]])).records[0]).toEqual({ x: 1, y: 2, m: 4 });
		const multi = readShapeFile(shapeFile(18, [[18, [...box, ...uint32(true, 1), ...doubles(5, 6, 0, 1, 7, 0, 1, 8)]]], [0, 1])).records[0];
		expect(multi.points).toEqual([{ x: 5, y: 6, z: 7, m: 8 }]);
		const measured = readShapeFile(shapeFile(28, [[28, [...box, ...uint32(true, 1), ...doubles(5, 6)]]])).records[0];
		expect(measured.points).toEqual([{ x: 5, y: 6 }]);
		const line = readShapeFile(shapeFile(13, [[13, [...poly([[0, 0], [1, 1]]), ...doubles(0, 1, 7, 8, 0, 1, 2, 3)]]], [0, 1])).records[0];
		expect(line.parts).toEqual([{ points: [{ x: 0, y: 0, z: 7, m: 2 }, { x: 1, y: 1, z: 8, m: 3 }] }]);
		expect(readShapeFile(shapeFile(23, [[23, poly([[0, 0], [1, 1]])]])).lastError).toBe('');
	});

	it('spreads Z and M values over the parts of a line', () => {
		const content = [...poly([[0, 0], [1, 1]], [[2, 2]]), ...doubles(0, 1, 7, 8, 9)];
		const [line] = readShapeFile(shapeFile(13, [[13, content]])).records;
		expect(line.parts).toEqual([{ points: [{ x: 0, y: 0, z: 7 }, { x: 1, y: 1, z: 8 }, { z: 9 }] }, { points: [{ x: 2, y: 2 }] }]);
	});

	it('drops the Z values of a line whose first part never received a point', () => {
		// Both parts start at point 0, so every point lands in the second part and the first stays a bare start index.
		const content = [...poly([], [[0, 0], [1, 1]]), ...doubles(0, 1, 7, 8)];
		const [line] = readShapeFile(shapeFile(13, [[13, content]])).records;
		expect(line.parts).toEqual([0, { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }]);
	});

	it('reports a record cut off inside its header', () => {
		const file = shapeFile(1, [[1, doubles(1, 2)]]);
		expect(readShapeFile(new Uint8Array([...file, 0, 0, 0, 2])).lastError).toBe('Failed to parse record, read=4, size=0');
	});

	it('keeps null shapes as empty records', () => {
		expect(readShapeFile(shapeFile(0, [[0, []]])).records).toEqual([{}]);
	});

	it('reports a file that is not a shapefile, an unknown record type and a truncated record', () => {
		expect(readShapeFile(new Uint8Array([1, 2, 3])).lastError).toBe('Not a SHP file (file code mismatch)');
		expect(readShapeFile(shapeFile(31, [[31, doubles(1)]])).lastError).toBe('The Shape Type "31" is not supported.');
		const truncated = shapeFile(1, [[1, doubles(1, 2)]]);
		expect(readShapeFile(truncated.subarray(0, -4)).lastError).toBe('Failed to parse record, read=24, size=28');
	});

	it('skips a record that is longer than its shape', () => {
		const result = readShapeFile(shapeFile(1, [[1, [...doubles(1, 2), ...uint32(true, 0)]]]));
		expect(result.records).toEqual([{ x: 1, y: 2 }]);
	});
});

describe('WKT writers', () => {
	it('prints missing coordinates as empty strings, like PHP casting false', () => {
		expect(pointShape({ x: false })).toBe('POINT( )');
		expect(multiPointShape({ numpoints: 1, points: [] })).toBe('MULTIPOINT( )');
		expect(multiLineStringShape({ numparts: 1, parts: [0] })).toBe('MULTILINESTRING())');
	});

	it('drops rings it cannot place and writes MULTIPOLYGON() without an outer ring', () => {
		expect(multiPolygonShape({ parts: [0] })).toBe('MULTIPOLYGON)');
		const flat = { parts: [{ points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 0 }] }] };
		expect(multiPolygonShape(flat)).toBe('MULTIPOLYGON)');
	});

	it('casts rays across slanted edges of closed and unclosed outer rings when placing a hole', () => {
		const triangle = { points: [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 0 }] };
		const unclosed = { points: [{ x: 0, y: 0 }, { x: 0, y: 5 }, { x: 10, y: 5 }] };
		const hole = { points: [{ x: 5, y: 2 }, { x: 6, y: 2 }, { x: 6, y: 3 }, { x: 5, y: 3 }, { x: 5, y: 2 }] };
		// The hole's surface point (5.9 2.5) lies left of the triangle's slanted edge but right of the other ring's.
		expect(multiPolygonShape({ parts: [triangle, unclosed, hole] }))
			.toBe('MULTIPOLYGON(((0 0,0 10,10 0,0 0),(5 2,6 2,6 3,5 3,5 2)),((0 0,0 5,10 5)))');
	});

	it('finds a point inside tiny holes and self-crossing rings', () => {
		const outer = { points: [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 0 }] };
		const tiny = { points: [{ x: 2, y: 2 }, { x: 2.01, y: 2 }, { x: 2.01, y: 2.01 }, { x: 2, y: 2.01 }, { x: 2, y: 2 }] };
		expect(multiPolygonShape({ parts: [outer, tiny] })).toBe('MULTIPOLYGON(((0 0,0 10,10 10,10 0,0 0),(2 2,2.01 2,2.01 2.01,2 2.01,2 2)))');
		const crossing = { points: [{ x: 1, y: 1 }, { x: 1, y: 5 }, { x: 5, y: 1 }, { x: 5, y: 5 }, { x: 1, y: 1 }] };
		expect(multiPolygonShape({ parts: [outer, crossing] })).toBe('MULTIPOLYGON(((0 0,0 10,10 10,10 0,0 0),(1 1,1 5,5 1,5 5,1 1)))');
		const line = { points: [{ x: 3, y: 3 }, { x: 3, y: 4 }, { x: 3, y: 3 }] };
		expect(multiPolygonShape({ parts: [outer, line] })).toBe('MULTIPOLYGON(((0 0,0 10,10 10,10 0,0 0)))');
		expect(multiPolygonShape({})).toBe('MULTIPOLYGON)');
		expect(multiPointShape({ numpoints: 0 })).toBe('MULTIPOINT)');
	});

	it('names shape types', () => {
		expect(shapeName(15)).toBe('PolygonZ');
		expect(shapeName(99)).toBe('Shape 99');
	});
});

// The phpmyadmin/shapefile reader as ImportShp drives it (no dBase support in the image), plus the Gis*::getShape() WKT writers.
import { phpFloatString } from './import-analysis.ts';

/** A value unpack() returned, or false when the data ran out. */
type Value = number | false;

export interface ShapePoint {
	x: Value;
	y: Value;
	z?: Value;
	m?: Value;
}

export interface ShapePart {
	points: ShapePoint[];
}

export interface ShapeData extends Partial<ShapePoint> {
	numpoints?: Value;
	numparts?: Value;
	points?: ShapePoint[];
	/** The part start indexes until the first point of each part is read. */
	parts?: (ShapePart | Value)[];
}

export interface ShapeFileResult {
	lastError: string;
	shapeType: Value;
	records: ShapeData[];
}

const SHAPE_NAMES: Record<number, string> = {
	0: 'Null Shape',
	1: 'Point',
	3: 'PolyLine',
	5: 'Polygon',
	8: 'MultiPoint',
	11: 'PointZ',
	13: 'PolyLineZ',
	15: 'PolygonZ',
	18: 'MultiPointZ',
	21: 'PointM',
	23: 'PolyLineM',
	25: 'PolygonM',
	28: 'MultiPointM',
	31: 'MultiPatch',
};

/** Util::nameShape(). */
export function shapeName(type: number): string {
	return SHAPE_NAMES[type] ?? `Shape ${type}`;
}

/** ImportShp::readFromBuffer() over the whole file: short reads at the end, then end of file. */
class ShapeReader {
	private position = 0;
	private loaded = false;
	eof = false;

	constructor(private readonly bytes: Uint8Array) {}

	read(length: number): Uint8Array {
		if (this.bytes.length - this.position < length && this.loaded) {
			this.eof = true;
		}
		this.loaded = true;
		const result = this.bytes.subarray(this.position, this.position + length);
		this.position += result.length;
		return result;
	}
}

// Util::loadData(): unpack() of 'N' (big-endian), 'V' (little-endian) or 'd' (double), false when short.
function unpack(type: 'N' | 'V' | 'd', data: Uint8Array): Value {
	const size = type === 'd' ? 8 : 4;
	if (data.length < size) {
		return false;
	}
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	if (type === 'N') {
		return view.getUint32(0, false);
	}
	if (type === 'V') {
		return view.getUint32(0, true);
	}
	return view.getFloat64(0, true);
}

// ShapeRecord::loadFromFile().
function readRecord(reader: ShapeReader, hasMeasure: boolean): { shapeType: Value; data: ShapeData; error: string; } {
	let read = 0;
	const value = (type: 'N' | 'V' | 'd', length: number): Value => {
		const data = reader.read(length);
		read += data.length;
		return unpack(type, data);
	};
	const point = (): ShapePoint => { return { x: value('d', 8), y: value('d', 8) }; };
	let shapeType: Value = false;
	let size = 0;
	const recordNumber = value('N', 4);
	if (recordNumber !== false) {
		const length = value('N', 4);
		if (length !== false) {
			size = (length * 2) + 8;
			shapeType = value('V', 4);
		}
	}
	let data: ShapeData = {};
	if (read === 0) {
		return { shapeType, data, error: '' };
	}
	const boundingBox = (): void => {
		for (let index = 0; index < 4; index++) {
			value('d', 8);
		}
	};
	const multiPoint = (): void => {
		boundingBox();
		data.numpoints = value('V', 4);
		data.points = [];
		for (let index = 0; index < Number(data.numpoints); index++) {
			data.points.push(point());
		}
	};
	const multiPointMZ = (dimension: 'm' | 'z'): void => {
		if (dimension === 'm' && !hasMeasure) {
			return;
		}
		value('d', 8);
		value('d', 8);
		for (let index = 0; index < Number(data.numpoints); index++) {
			(data.points as ShapePoint[])[index][dimension] = value('d', 8);
		}
	};
	const polyLine = (): void => {
		boundingBox();
		data.numparts = value('V', 4);
		data.numpoints = value('V', 4);
		const parts: (ShapePart | Value)[] = [];
		for (let index = 0; index < Number(data.numparts); index++) {
			parts.push(value('V', 4));
		}
		let part = 0;
		for (let index = 0; index < Number(data.numpoints); index++) {
			if (part + 1 < Number(data.numparts) && index === parts[part + 1]) {
				part++;
			}
			const current = parts[part];
			if (typeof current !== 'object' || current === null) {
				parts[part] = { points: [] };
			}
			(parts[part] as ShapePart).points.push(point());
		}
		data.parts = parts;
	};
	const polyLineMZ = (dimension: 'm' | 'z'): void => {
		if (dimension === 'm' && !hasMeasure) {
			return;
		}
		value('d', 8);
		value('d', 8);
		// The part starts were replaced by point lists, so upstream's part switch never fires and every value goes to part 0.
		const first = (data.parts as (ShapePart | Value)[])[0];
		for (let index = 0; index < Number(data.numpoints); index++) {
			const measured = value('d', 8);
			if (typeof first === 'object' && first !== null) {
				first.points[index] ??= {} as ShapePoint;
				first.points[index][dimension] = measured;
			}
		}
	};
	let error = '';
	// PHP's switch compares loosely, so a missing type behaves as the null shape.
	switch (shapeType === false ? 0 : shapeType) {
		case 0: {
			break;
		}
		case 1: {
			data = point();
			break;
		}
		case 21: {
			data = { ...point(), m: value('d', 8) };
			break;
		}
		case 11: {
			data = { ...point(), z: value('d', 8), m: value('d', 8) };
			break;
		}
		case 3:
		case 5: {
			polyLine();
			break;
		}
		case 23:
		case 25: {
			polyLine();
			polyLineMZ('m');
			break;
		}
		case 13:
		case 15: {
			polyLine();
			polyLineMZ('z');
			polyLineMZ('m');
			break;
		}
		case 8: {
			multiPoint();
			break;
		}
		case 28: {
			multiPoint();
			multiPointMZ('m');
			break;
		}
		case 18: {
			multiPoint();
			multiPointMZ('z');
			multiPointMZ('m');
			break;
		}
		default: {
			error = `The Shape Type "${shapeType}" is not supported.`;
		}
	}
	// Upstream skips the rest of the record; a truncated file would loop forever there, so it stops at the end of the data.
	while (read < size) {
		const before = read;
		value('V', 4);
		if (read === before) {
			break;
		}
	}
	if (read !== size) {
		error = `Failed to parse record, read=${read}, size=${size}`;
	}
	return { shapeType, data, error };
}

/** ShapeFile::loadFromFile('') on an uploaded .shp. */
export function readShapeFile(bytes: Uint8Array): ShapeFileResult {
	const reader = new ShapeReader(bytes);
	const value = (type: 'N' | 'V' | 'd', length: number): Value => unpack(type, reader.read(length));
	const result: ShapeFileResult = { lastError: '', shapeType: false, records: [] };
	if (value('N', 4) !== 9994) {
		result.lastError = 'Not a SHP file (file code mismatch)';
		return result;
	}
	reader.read(20);
	value('N', 4);
	reader.read(4);
	result.shapeType = value('V', 4);
	const box: Value[] = [];
	for (let index = 0; index < 8; index++) {
		box.push(value('d', 8));
	}
	const hasMeasure = (box[6] !== false && box[6] !== 0) || (box[7] !== false && box[7] !== 0);
	while (!reader.eof) {
		const record = readRecord(reader, hasMeasure);
		if (record.error !== '') {
			result.lastError = record.error;
			return result;
		}
		if (record.shapeType === false && reader.eof) {
			break;
		}
		result.records.push(record.data);
	}
	return result;
}

// A coordinate as PHP prints it: a missing one is ''.
const coordinate = (value: Value | undefined): string => (value === false || value === undefined ? '' : phpFloatString(value));
const pair = (point: ShapePoint): string => `${coordinate(point.x)} ${coordinate(point.y)}`;
const partPoints = (part: ShapePart | Value | undefined): ShapePoint[] => (typeof part === 'object' && part !== null ? part.points : []);

// mb_substr($wkt, 0, -1): drops the trailing comma or, for an empty list, the opening parenthesis.
const dropLast = (text: string): string => [...text].slice(0, -1).join('');

/** GisPoint::getShape(). */
export function pointShape(data: ShapeData): string {
	return `POINT(${coordinate(data.x)} ${coordinate(data.y)})`;
}

/** GisMultiPoint::getShape(). */
export function multiPointShape(data: ShapeData): string {
	const points = data.points ?? [];
	let wkt = 'MULTIPOINT(';
	for (let index = 0; index < Number(data.numpoints); index++) {
		wkt += `${points[index] === undefined ? ' ' : pair(points[index])},`;
	}
	return `${dropLast(wkt)})`;
}

/** GisMultiLineString::getShape(). */
export function multiLineStringShape(data: ShapeData): string {
	let wkt = 'MULTILINESTRING(';
	for (let index = 0; index < Number(data.numparts); index++) {
		wkt += '(';
		for (const point of partPoints(data.parts?.[index])) {
			wkt += `${pair(point)},`;
		}
		wkt = `${dropLast(wkt)}),`;
	}
	return `${dropLast(wkt)})`;
}

type Coordinates = { x: number; y: number; };

const numeric = (point: ShapePoint): Coordinates => { return { x: Number(point.x), y: Number(point.y) }; };

/** GisPolygon::area(): negative for a clockwise ring. */
function area(ring: Coordinates[]): number {
	let count = ring.length;
	const last = ring.length - 1;
	if (ring[0].x === ring[last].x && ring[0].y === ring[last].y) {
		count--;
	}
	let sum = 0;
	for (let index = 0; index < count; index++) {
		const next = (index + 1) % count;
		sum += ring[index].x * ring[next].y;
		sum -= ring[index].y * ring[next].x;
	}
	return sum / 2;
}

/** GisPolygon::isPointInsidePolygon(), by ray casting. */
function isPointInsidePolygon(point: Coordinates, polygonPoints: Coordinates[]): boolean {
	let polygon = polygonPoints;
	const last = polygon.length - 1;
	if (polygon[0].x === polygon[last].x && polygon[0].y === polygon[last].y) {
		polygon = polygon.slice(0, last);
	}
	let counter = 0;
	let first = polygon[0];
	for (let index = 1; index <= polygon.length; index++) {
		const second = polygon[index % polygon.length];
		const inRange = point.y > Math.min(first.y, second.y) && point.y <= Math.max(first.y, second.y) && point.x <= Math.max(first.x, second.x);
		if (inRange && first.y !== second.y) {
			const crossing = ((point.y - first.y) / (second.y - first.y)) + first.x;
			if (first.x === second.x || point.x <= crossing) {
				counter++;
			}
		}
		first = second;
	}
	return counter % 2 !== 0;
}

/** GisPolygon::getPointOnSurface(): a point inside the ring, or null. */
function pointOnSurface(ring: Coordinates[]): Coordinates | null {
	const start = ring.findIndex((point, index) => index < ring.length - 1 && point.y !== ring[index + 1].y);
	if (start === -1) {
		return null;
	}
	const [x0, y0, x1, y1] = [ring[start].x, ring[start].y, ring[start + 1].x, ring[start + 1].y];
	const x2 = (x0 + x1) / 2;
	const y2 = (y0 + y1) / 2;
	const denominator = Math.hypot(y1 - y0, x0 - x1);
	let epsilon = 0.1;
	for (;;) {
		const ax = x2 + ((epsilon * (y1 - y0)) / denominator);
		const pointA = { x: ax, y: y2 + (((ax - x2) * (x0 - x1)) / (y1 - y0)) };
		if (isPointInsidePolygon(pointA, ring)) {
			return pointA;
		}
		const bx = x2 + ((epsilon * (y1 - y0)) / -denominator);
		const pointB = { x: bx, y: y2 + (((bx - x2) * (x0 - x1)) / (y1 - y0)) };
		if (isPointInsidePolygon(pointB, ring)) {
			return pointB;
		}
		epsilon **= 2;
		if (epsilon === 0) {
			return null;
		}
	}
}

/** GisMultiPolygon::getShape(): clockwise rings are polygons, each inner ring goes to every outer ring around it. */
export function multiPolygonShape(data: ShapeData): string {
	const rings = (data.parts ?? []).map(part => partPoints(part));
	const outer = rings.map(points => points.length > 0 && area(points.map(point => numeric(point))) < 0);
	const inner = rings.map(() => [] as number[]);
	for (const [index, points] of rings.entries()) {
		if (outer[index]) {
			continue;
		}
		const surface = points.length > 0 ? pointOnSurface(points.map(point => numeric(point))) : null;
		for (const [candidate, candidatePoints] of rings.entries()) {
			if (outer[candidate] && surface !== null && isPointInsidePolygon(surface, candidatePoints.map(point => numeric(point)))) {
				inner[candidate].push(index);
			}
		}
	}
	let wkt = 'MULTIPOLYGON(';
	for (const [index, points] of rings.entries()) {
		if (!outer[index]) {
			continue;
		}
		wkt += `((${points.map(point => pair(point)).join(',')})`;
		for (const innerIndex of inner[index]) {
			wkt += `,(${rings[innerIndex].map(point => pair(point)).join(',')})`;
		}
		wkt += '),';
	}
	return `${dropLast(wkt)})`;
}

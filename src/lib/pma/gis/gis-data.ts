// The editor side of the Gis\Gis* classes: GisFactory types, generateParams() and generateWkt() over the posted gis_data array.
import { phpString, phpTrim } from '../../twig/php.ts';
import { isNumericString } from '../php-compare.ts';
import { explodeGeomCol, phpFloat } from '../table-data/gis-visualization.ts';
import { type PhpArray, phpEntries } from '../table-data/php-params.ts';

export const GIS_TYPES = ['POINT', 'MULTIPOINT', 'LINESTRING', 'MULTILINESTRING', 'POLYGON', 'MULTIPOLYGON', 'GEOMETRYCOLLECTION'] as const;

export type GisType = typeof GIS_TYPES[number];

/** A PHP value of gis_data: posted strings, generated numbers, or nested arrays in PHP key order. */
export type GisValue = string | number | GisArray;

export type GisArray = Map<string, GisValue>;

// Loops bounded by posted counts would let one request spin forever; PHP runs out of memory long before this.
const MAX_ITEMS = 10000;

const INTEGER_KEY = /^(?:0|-?[1-9]\d{0,17})$/;

/** GisFactory::factory(): the geometry type, or null for anything else. */
export function gisType(type: string): GisType | null {
	const upper = type.toUpperCase();
	return GIS_TYPES.find(name => name === upper) ?? null;
}

/** A posted request array as a gis_data array. */
export function toGisArray(array: PhpArray): GisArray {
	return new Map(phpEntries(array).map(([key, value]) => [key, typeof value === 'string' ? value : toGisArray(value)]));
}

/** array_merge(): string keys are replaced in place, integer keys renumbered and appended. */
export function arrayMerge(...arrays: GisArray[]): GisArray {
	const result: GisArray = new Map();
	let next = 0;
	for (const array of arrays) {
		for (const [key, value] of array) {
			if (INTEGER_KEY.test(key)) {
				result.set(String(next++), value);
			} else {
				result.set(key, value);
			}
		}
	}
	return result;
}

/** Reads $array[$a][$b]..., undefined when a step is missing or not an array. */
export function gisGet(value: GisValue | undefined, ...path: (string | number)[]): GisValue | undefined {
	let node = value;
	for (const key of path) {
		if (!(node instanceof Map)) {
			return undefined;
		}
		node = node.get(String(key));
	}
	return node;
}

/** `$array[$key] = []`, returning the new array to fill in. */
function child(array: GisArray, key: string | number): GisArray {
	const created: GisArray = new Map();
	array.set(String(key), created);
	return created;
}

function scalarText(value: GisValue): string {
	if (value instanceof Map) {
		return 'Array';
	}
	return phpString(value);
}

/** `isset($v) && trim((string) $v) != '' ? $v : $empty`, as every generateWkt() writes a coordinate. */
function coordinate(value: GisValue | undefined, empty: string): string {
	if (value === undefined || phpTrim(scalarText(value)) === '') {
		return empty;
	}
	return scalarText(value);
}

/** `$count = $value ?? $default; if ($count < $minimum) $count = $minimum;` for numeric counts. */
function count(value: GisValue | undefined, fallback: number, minimum: number): number {
	let result = fallback;
	if (typeof value === 'number') {
		result = value;
	} else if (typeof value === 'string' && isNumericString(value)) {
		result = Number(value);
	}
	return Math.min(Math.max(result, minimum), MAX_ITEMS);
}

/** The loop bound `for ($i = 0; $i < $count; $i++)` runs to. */
function times(bound: number): number[] {
	return Array.from({ length: Math.max(0, Math.ceil(bound)) }, (_unused, index) => index);
}

/** mb_substr($value, $start, $length) for the non-negative starts used here. */
function mbSubstr(value: string, start: number, length: number): string {
	const characters = [...value];
	let end = start + length;
	if (length < 0) {
		end = characters.length + length;
	}
	return characters.slice(start, Math.max(start, end)).join('');
}

/** A ring or line of points as "x y,x y". */
function pointList(row: GisValue | undefined, total: number, empty: string): string {
	return times(total).map(index => `${coordinate(gisGet(row, index, 'x'), empty)} ${coordinate(gisGet(row, index, 'y'), empty)}`).join(',');
}

/** generateWkt() of the geometry at $gis_data[$index]; $empty fills the coordinates left blank. */
export function generateWkt(type: GisType, gisData: GisArray, index: number, empty = '', depth = 0): string {
	const row = gisGet(gisData, index, type);
	if (type === 'POINT') {
		// GisPoint ignores $empty.
		return `POINT(${coordinate(gisGet(row, 'x'), '')} ${coordinate(gisGet(row, 'y'), '')})`;
	}
	if (type === 'MULTIPOINT') {
		// GisMultiPoint ignores $empty too.
		return `MULTIPOINT(${pointList(row, count(gisGet(row, 'no_of_points'), 1, 1), '')})`;
	}
	if (type === 'LINESTRING') {
		return `LINESTRING(${pointList(row, count(gisGet(row, 'no_of_points'), 2, 2), empty)})`;
	}
	if (type === 'MULTILINESTRING' || type === 'POLYGON') {
		const minimum = type === 'POLYGON' ? 4 : 2;
		const lines = times(count(gisGet(row, 'no_of_lines'), 1, 1)).map((line) => {
			const points = count(gisGet(row, line, 'no_of_points'), minimum, minimum);
			return `(${pointList(gisGet(row, line), points, empty)})`;
		});
		return `${type}(${lines.join(',')})`;
	}
	if (type === 'MULTIPOLYGON') {
		const polygons = times(count(gisGet(row, 'no_of_polygons'), 1, 1)).map((polygon) => {
			const lines = times(count(gisGet(row, polygon, 'no_of_lines'), 1, 1)).map((line) => {
				const points = count(gisGet(row, polygon, line, 'no_of_points'), 4, 4);
				return `(${pointList(gisGet(row, polygon, line), points, empty)})`;
			});
			return `(${lines.join(',')})`;
		});
		return `MULTIPOLYGON(${polygons.join(',')})`;
	}
	// A collection inside a collection reads the same gis_data again and never ends upstream, so one level is the limit.
	if (depth > 0) {
		return '';
	}
	let wkt = 'GEOMETRYCOLLECTION(';
	const geometries = count(gisGet(gisData, 'GEOMETRYCOLLECTION', 'geom_count'), 1, -Infinity);
	for (const geometry of times(geometries)) {
		const member = gisGet(gisData, geometry, 'gis_type');
		const memberType = member === undefined ? null : gisType(scalarText(member));
		if (memberType !== null) {
			wkt += `${generateWkt(memberType, gisData, geometry, empty, depth + 1)},`;
		}
	}
	if (gisGet(gisData, 0, 'gis_type') !== undefined) {
		wkt = mbSubstr(wkt, 0, -1);
	}
	return `${wkt})`;
}

/** GisGeometry::extractPoints() without scaling. */
function extractPoints(pointSet: string): [number, number][] {
	return pointSet.split(',').map((rawPoint) => {
		const coordinates = rawPoint.replaceAll(/[()]/g, '').split(' ');
		if (coordinates.length < 2 || phpTrim(coordinates[0]) === '' || phpTrim(coordinates[1]) === '') {
			return [0, 0];
		}
		return [phpFloat(phpTrim(coordinates[0])), phpFloat(phpTrim(coordinates[1]))];
	});
}

/** Writes "no_of_points" and each point's x and y into a ring or line array. */
function setPoints(target: GisArray, pointSet: string): void {
	const points = extractPoints(pointSet);
	target.set('no_of_points', points.length);
	for (const [index, [x, y]] of points.entries()) {
		const point = child(target, index);
		point.set('x', x);
		point.set('y', y);
	}
}

const GEOMETRY_TYPES = '(?:POINT|MULTIPOINT|LINESTRING|MULTILINESTRING|POLYGON|MULTIPOLYGON|GEOMETRYCOLLECTION)';

/** GisGeometry::generateParams(): the SRID and WKT of "'WKT',SRID" or of a bare WKT value. */
function splitValue(value: string): { srid: number; wkt: string; } {
	if (new RegExp(String.raw`^'${GEOMETRY_TYPES}\(.*\)',\d*$`, 'i').test(value)) {
		const characters = [...value];
		const lastComma = characters.lastIndexOf(',');
		const srid = Math.trunc(phpFloat(phpTrim(characters.slice(lastComma + 1).join(''))));
		return { srid, wkt: phpTrim(mbSubstr(value, 1, lastComma - 2)) };
	}
	if (new RegExp(String.raw`^${GEOMETRY_TYPES}\(.*\)$`, 'i').test(value)) {
		return { srid: 0, wkt: value };
	}
	return { srid: 0, wkt: '' };
}

/** The type-specific body of generateParams() for one geometry written to $params[$index]. */
function geometryParams(type: Exclude<GisType, 'GEOMETRYCOLLECTION'>, wkt: string, target: GisArray): void {
	const data = child(target, type);
	if (type === 'POINT') {
		const [[x, y]] = extractPoints(mbSubstr(wkt, 6, -1));
		data.set('x', x);
		data.set('y', y);
	} else if (type === 'MULTIPOINT' || type === 'LINESTRING') {
		setPoints(data, mbSubstr(wkt, 11, -1));
	} else if (type === 'MULTILINESTRING' || type === 'POLYGON') {
		const lines = mbSubstr(wkt, type === 'POLYGON' ? 9 : 17, -2).split('),(');
		data.set('no_of_lines', lines.length);
		for (const [index, line] of lines.entries()) {
			setPoints(child(data, index), line);
		}
	} else {
		const polygons = mbSubstr(wkt, 15, -3).split(')),((');
		data.set('no_of_polygons', polygons.length);
		for (const [index, polygon] of polygons.entries()) {
			const rings = polygon.split('),(');
			const polygonData = child(data, index);
			polygonData.set('no_of_lines', rings.length);
			for (const [ring, points] of rings.entries()) {
				setPoints(child(polygonData, ring), points);
			}
		}
	}
}

/** generateParams($value) of the geometry class: srid plus the parsed coordinates under index 0 (or the collection's members). */
export function generateParams(type: GisType, value: string): GisArray {
	const { srid, wkt } = splitValue(value);
	let params: GisArray = new Map([['srid', srid]]);
	if (type !== 'GEOMETRYCOLLECTION') {
		geometryParams(type, wkt, child(params, 0));
		return params;
	}
	const parts = explodeGeomCol(mbSubstr(wkt, 19, -1));
	child(params, 'GEOMETRYCOLLECTION').set('geom_count', parts.length);
	let index = 0;
	for (const part of parts) {
		// explodeGeomCol() only returns parts that end in a closed "(...)".
		const partType = gisType(part.slice(0, part.indexOf('(')));
		if (partType === null) {
			continue;
		}
		if (partType === 'GEOMETRYCOLLECTION') {
			// A nested collection's own generateParams() ignores the index, so its srid and members are merged over ours.
			params = arrayMerge(params, generateParams(partType, part));
		} else {
			const member: GisArray = new Map([['gis_type', partType]]);
			geometryParams(partType, part, member);
			params = arrayMerge(params, new Map([[String(index), member]]));
		}
		index++;
	}
	return params;
}

/** GisDataEditorController::validateGisData(): picks gis_type from the posted data, the value or the column type. */
export function validateGisData(gisData: GisArray, type: string, value: string | undefined): GisType {
	const posted = gisData.get('gis_type');
	if (typeof posted === 'string' && GIS_TYPES.includes(posted as GisType)) {
		return posted as GisType;
	}
	let candidate: GisValue | undefined = posted;
	if (type !== '') {
		candidate = type.toUpperCase();
	}
	const match = value !== undefined && phpTrim(value) !== '' ? /^'?(\w+)\b/.exec(value) : null;
	if (match !== null) {
		candidate = match[1];
	}
	const result = GIS_TYPES.find(name => name === candidate) ?? GIS_TYPES[0];
	gisData.set('gis_type', result);
	return result;
}

/**
 * A template array whose missing keys read as null, since Twing yields undefined for them and its `is not null` test lets
 * that through. Below the top level a missing geometry or index reads as an empty array, so `a[i]['add_point']` stays null.
 */
class TwigArray extends Map<string | number, unknown> {
	constructor(entries: [string | number, unknown][], private readonly nested: boolean) {
		super(entries);
	}

	override has(): boolean {
		return true;
	}

	override get(key: string | number): unknown {
		const value = super.get(key);
		if (value !== undefined) {
			return value;
		}
		if (this.nested && (typeof key === 'number' || gisType(key) !== null)) {
			return new TwigArray([], true);
		}
		return null;
	}
}

/** The gis_data array for templates: integer-like keys as numbers, as Twig looks them up with loop counters. */
export function gisDataToTwig(value: GisValue, nested = false): unknown {
	if (!(value instanceof Map)) {
		return value;
	}
	return new TwigArray([...value].map(([key, item]) => [INTEGER_KEY.test(key) ? Number(key) : key, gisDataToTwig(item, true)]), nested);
}

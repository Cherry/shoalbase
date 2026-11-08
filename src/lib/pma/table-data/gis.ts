// Pure parts of Utils\Gis: the spatial function list of the search form and Gis::createData().

export interface GisFunction {
	params?: number;
	type?: string;
	display?: string;
}

/** Gis::getFunctions() as ordered [key, function] pairs, since the PHP array mixes list and named keys. */
export function getGisFunctions(geomType: string | null, binary: boolean, display: boolean, version: number): [string, GisFunction][] {
	const functions: [string, GisFunction][] = [];
	let listIndex = 0;
	const addDisplay = (text: string): void => {
		functions.push([String(listIndex++), { display: text }]);
	};
	const add = (name: string, params: number, type: string): void => {
		functions.push([name, { params, type }]);
	};

	if (display) {
		addDisplay(' ');
	}
	add('Dimension', 1, 'int');
	add('Envelope', 1, 'Polygon');
	add('GeometryType', 1, 'text');
	add('SRID', 1, 'int');
	add('IsEmpty', 1, 'int');
	add('IsSimple', 1, 'int');

	const type = (geomType ?? '').trim().toLowerCase();
	if (display && type !== 'geometry' && type !== 'multipoint') {
		addDisplay('--------');
	}
	const prefix = version >= 50601 ? 'ST_' : '';
	if (type === 'point') {
		add(`${prefix}X`, 1, 'float');
		add(`${prefix}Y`, 1, 'float');
	} else if (type === 'linestring') {
		add('EndPoint', 1, 'point');
		add('GLength', 1, 'float');
		add('NumPoints', 1, 'int');
		add('StartPoint', 1, 'point');
		add('IsRing', 1, 'int');
	} else if (type === 'multilinestring') {
		add('GLength', 1, 'float');
		add('IsClosed', 1, 'int');
	} else if (type === 'polygon') {
		add('Area', 1, 'float');
		add('ExteriorRing', 1, 'linestring');
		add('NumInteriorRings', 1, 'int');
	} else if (type === 'multipolygon') {
		add('Area', 1, 'float');
		add('Centroid', 1, 'point');
	} else if (type === 'geometrycollection') {
		add('NumGeometries', 1, 'int');
	}

	if (binary) {
		if (display) {
			addDisplay('--------');
		}
		for (const name of ['Crosses', 'Contains', 'Disjoint', 'Equals', 'Intersects', 'Overlaps', 'Touches', 'Within']) {
			add(`${prefix}${name}`, 2, 'int');
		}
		if (display) {
			addDisplay('--------');
		}
		for (const name of ['MBRContains', 'MBRDisjoint', 'MBREquals', 'MBRIntersects', 'MBROverlaps', 'MBRTouches', 'MBRWithin']) {
			add(name, 2, 'int');
		}
	}
	return functions;
}

/** Gis::createData(): wraps WKT (optionally with an SRID) in the GeomFromText function. */
export function createGisData(gisString: string, version: number): string {
	const geomFromText = version >= 50600 ? 'ST_GeomFromText' : 'GeomFromText';
	const trimmed = gisString.replaceAll(/^[\t\n\v\r\0 ]+|[\t\n\v\r\0 ]+$/g, '');
	const types = '(?:POINT|MULTIPOINT|LINESTRING|MULTILINESTRING|POLYGON|MULTIPOLYGON|GEOMETRYCOLLECTION)';
	if (new RegExp(String.raw`^'${types}\(.*\)',\d*$`, 'i').test(trimmed)) {
		return `${geomFromText}(${trimmed})`;
	}
	if (new RegExp(String.raw`^${types}\(.*\)$`, 'i').test(trimmed)) {
		return `${geomFromText}('${trimmed}')`;
	}
	return trimmed;
}

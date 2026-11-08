// Port of Gis\GisVisualization and the Gis* geometry classes for the SVG and OpenLayers output of /table/gis-visualization.
import { htmlspecialchars, phpString, phpTrim } from '../../twig/php.ts';
import { backquote } from '../../twig/sanitize.ts';
import { phpJsonEncode } from '../json.ts';

export interface ScaleData {
	scale: number;
	x: number;
	y: number;
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
	height: number;
}

interface Extent {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

const EMPTY_EXTENT: Extent = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };

export const DEFAULT_SETTINGS = {
	colors: ['#B02EE0', '#E0642E', '#E0D62E', '#2E97E0', '#BCE02E', '#E02E75', '#5CE02E', '#E0B02E', '#0022E0', '#726CB1', '#481A36', '#BAC658', '#127224', '#825119', '#238C74', '#4C489B', '#87C9BF'],
	colors_hex: [[176, 46, 224], [224, 100, 46], [224, 214, 46], [46, 151, 224], [188, 224, 46], [224, 46, 117], [92, 224, 46], [224, 176, 46], [0, 34, 224], [114, 108, 177], [72, 26, 54], [186, 198, 88], [18, 114, 36], [130, 81, 25], [35, 140, 116], [76, 72, 155], [135, 201, 191]],
	width: 600,
	height: 450,
};

export interface VisualizationSettings {
	colors: string[];
	colors_hex: number[][];
	width: unknown;
	height: unknown;
	spatialColumn?: unknown;
	labelColumn?: unknown;
	[key: string]: unknown;
}

/** PHP's (float) cast of a string: its leading numeric prefix, else 0. */
export function phpFloat(value: string): number {
	const match = /^[\t\n\v\f\r ]*[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?/i.exec(value);
	return match === null ? 0 : Number(match[0]);
}

/** mb_substr($value, $start, $length) for the negative lengths the geometry classes use. */
function substr(value: string, start: number, length: number): string {
	const characters = [...value];
	return characters.slice(start, characters.length + length).join('');
}

function setMinMax(pointSet: string, minMax: Extent): Extent {
	const result = { ...minMax };
	for (const point of pointSet.split(',')) {
		const coordinates = point.split(' ');
		const x = phpFloat(coordinates[0]);
		if (x > result.maxX) {
			result.maxX = x;
		}
		if (x < result.minX) {
			result.minX = x;
		}
		const y = phpFloat(coordinates[1] ?? '');
		if (y > result.maxY) {
			result.maxY = y;
		}
		if (y < result.minY) {
			result.minY = y;
		}
	}
	return result;
}

function extractPoints(pointSet: string, scaleData: ScaleData | null): [number, number][] {
	return pointSet.split(',').map((rawPoint) => {
		const coordinates = rawPoint.replaceAll(/[()]/g, '').split(' ');
		if (coordinates.length < 2 || phpTrim(coordinates[0]) === '' || phpTrim(coordinates[1]) === '') {
			return [0, 0];
		}
		let x = phpFloat(phpTrim(coordinates[0]));
		let y = phpFloat(phpTrim(coordinates[1]));
		if (scaleData !== null) {
			x = (x - scaleData.x) * scaleData.scale;
			y = scaleData.height - ((y - scaleData.y) * scaleData.scale);
		}
		return [x, y];
	});
}

function svgOptions(options: [string, unknown][]): string {
	return options.map(([option, value]) => ` ${option}="${phpTrim(phpString(value))}"`).join('');
}

function boundsForOl(srid: number, scale: ScaleData): string {
	return `var minLoc = [${phpString(scale.minX)}, ${phpString(scale.minY)}];var maxLoc = [${phpString(scale.maxX)}, ${phpString(scale.maxY)}];`
		+ 'var ext = ol.extent.boundingExtent([minLoc, maxLoc]);'
		+ `ext = ol.proj.transformExtent(ext, ol.proj.get("EPSG:${srid}"), ol.proj.get('EPSG:3857'));`
		+ 'map.getView().fit(ext, map.getSize());';
}

function pointForOl(point: [number, number], srid: number): string {
	return `(new ol.geom.Point([${phpString(point[0])},${phpString(point[1])}]).transform(ol.proj.get("EPSG:${srid}"), ol.proj.get('EPSG:3857')))`;
}

function pointsArrayForOl(points: [number, number][], srid: number): string {
	const list = points.map(point => `${pointForOl(point, srid)}.getCoordinates()`).join(', ');
	return `new Array(${list})`;
}

function lineForOl(points: [number, number][], srid: number, isLineString = true): string {
	return `new ol.geom.${isLineString ? 'LineString' : 'LinearRing'}(${pointsArrayForOl(points, srid)})`;
}

function lineArrayForOl(lines: string[], srid: number, isLineString = true): string {
	let output = 'var arr = [];';
	for (const line of lines) {
		output += 'var lineArr = [];';
		output += `var line = ${lineForOl(extractPoints(line, null), srid, isLineString)};`;
		output += 'var coord = line.getCoordinates();';
		output += 'for (var i = 0; i < coord.length; i++) lineArr.push(coord[i]);';
		output += 'arr.push(lineArr);';
	}
	return output;
}

function polygonForOl(rings: string[], srid: number): string {
	return `${lineArrayForOl(rings, srid, false)}var polygon = new ol.geom.Polygon(arr);`;
}

function drawPath(polygon: string, scaleData: ScaleData): string {
	const points = extractPoints(polygon, scaleData);
	let row = ` M ${phpString(points[0][0])}, ${phpString(points[0][1])}`;
	for (const point of points.slice(1, -1)) {
		row += ` L ${phpString(point[0])}, ${phpString(point[1])}`;
	}
	return `${row} Z `;
}

function pathForPolygon(polygon: string, scaleData: ScaleData): string {
	return polygon.split('),(').map(ring => drawPath(ring, scaleData)).join('');
}

function pointStyle(color: unknown, label: string): string {
	let result = `var fill = new ol.style.Fill(${phpJsonEncode({ color: 'white' })});`
		+ `var stroke = new ol.style.Stroke(${phpJsonEncode({ color, width: 2 })});`
		+ 'var style = new ol.style.Style({image: new ol.style.Circle({fill: fill,stroke: stroke,radius: 3}),fill: fill,stroke: stroke';
	if (phpTrim(label) !== '') {
		result += `,text: new ol.style.Text(${phpJsonEncode({ text: phpTrim(label), offsetY: -9 })})`;
	}
	return `${result}});`;
}

function lineStyle(color: unknown, label: string): string {
	let result = `var style = new ol.style.Style({stroke: new ol.style.Stroke(${phpJsonEncode({ color, width: 2 })})`;
	if (phpTrim(label) !== '') {
		result += `, text: new ol.style.Text(${phpJsonEncode({ text: phpTrim(label) })})`;
	}
	return `${result}});`;
}

function polygonStyle(color: number[], label: string): string {
	let result = `var style = new ol.style.Style({fill: new ol.style.Fill(${phpJsonEncode({ color: [...color, 0.8] })}),stroke: new ol.style.Stroke(${phpJsonEncode({ color: [0, 0, 0], width: 0.5 })})`;
	if (phpTrim(label) !== '') {
		result += `,text: new ol.style.Text(${phpJsonEncode({ text: phpTrim(label) })})`;
	}
	return `${result}});`;
}

/** GisGeometryCollection::explodeGeomCol(): the top-level geometries of a collection. */
export function explodeGeomCol(collection: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	const characters = [...collection];
	for (const [index, character] of characters.entries()) {
		if (character === '(') {
			depth++;
		} else if (character === ')') {
			depth--;
			if (depth === 0) {
				parts.push(characters.slice(start, index + 1).join(''));
				start = index + 2;
			}
		}
	}
	return parts;
}

function geometryType(spatial: string): string | null {
	const typePosition = spatial.indexOf('(');
	if (typePosition === -1) {
		return null;
	}
	const type = spatial.slice(0, typePosition).toUpperCase();
	return ['MULTIPOLYGON', 'POLYGON', 'MULTIPOINT', 'POINT', 'MULTILINESTRING', 'LINESTRING', 'GEOMETRYCOLLECTION'].includes(type) ? type : null;
}

function firstRing(polygon: string): string {
	return polygon.split('),(', 1)[0];
}

/** GisGeometry::scaleRow() of the geometry's class. */
function scaleRow(type: string, spatial: string): Extent {
	if (type === 'POINT') {
		return setMinMax(substr(spatial, 6, -1), EMPTY_EXTENT);
	}
	if (type === 'LINESTRING' || type === 'MULTIPOINT') {
		return setMinMax(substr(spatial, 11, -1), EMPTY_EXTENT);
	}
	if (type === 'POLYGON') {
		return setMinMax(firstRing(substr(spatial, 9, -2)), EMPTY_EXTENT);
	}
	if (type === 'MULTILINESTRING') {
		return substr(spatial, 17, -2).split('),(').reduce((extent, line) => setMinMax(line, extent), EMPTY_EXTENT);
	}
	if (type === 'MULTIPOLYGON') {
		return substr(spatial, 15, -3).split(')),((').reduce((extent, polygon) => setMinMax(firstRing(polygon), extent), EMPTY_EXTENT);
	}
	let extent = EMPTY_EXTENT;
	for (const part of explodeGeomCol(substr(spatial, 19, -1))) {
		const partType = geometryType(part);
		if (partType === null) {
			continue;
		}
		const scale = scaleRow(partType, part);
		extent = {
			maxX: Math.max(extent.maxX, scale.maxX),
			minX: Math.min(extent.minX, scale.minX),
			maxY: Math.max(extent.maxY, scale.maxY),
			minY: Math.min(extent.minY, scale.minY),
		};
	}
	return extent;
}

/** Each geometry's prepareRowAsSvg(); `randomId` stands in for random_int(0, mt_getrandmax()). */
function prepareRowAsSvg(type: string, spatial: string, label: string, color: string, scaleData: ScaleData, randomId: () => number): string {
	if (type === 'POINT') {
		const [point] = extractPoints(substr(spatial, 6, -1), scaleData);
		if (point[0] === 0 || point[1] === 0) {
			return '';
		}
		const options: [string, unknown][] = [['data-label', label], ['id', `${label}${randomId()}`], ['class', 'point vector'], ['fill', 'white'], ['stroke', color], ['stroke-width', 2]];
		return `<circle cx="${phpString(point[0])}" cy="${phpString(point[1])}" r="3"${svgOptions(options)}/>`;
	}
	if (type === 'MULTIPOINT') {
		let row = '';
		for (const point of extractPoints(substr(spatial, 11, -1), scaleData)) {
			if (point[0] === 0 || point[1] === 0) {
				continue;
			}
			const options: [string, unknown][] = [['data-label', label], ['class', 'multipoint vector'], ['fill', 'white'], ['stroke', color], ['stroke-width', 2], ['id', `${label}${randomId()}`]];
			row += `<circle cx="${phpString(point[0])}" cy="${phpString(point[1])}" r="3"${svgOptions(options)}/>`;
		}
		return row;
	}
	if (type === 'LINESTRING' || type === 'MULTILINESTRING') {
		const lines = type === 'LINESTRING' ? [substr(spatial, 11, -1)] : substr(spatial, 17, -2).split('),(');
		return lines.map((line) => {
			const points = extractPoints(line, scaleData).map(point => `${phpString(point[0])},${phpString(point[1])} `).join('');
			const base: [string, unknown][] = [['data-label', label]];
			const style: [string, unknown][] = [['class', 'linestring vector'], ['fill', 'none'], ['stroke', color], ['stroke-width', 2]];
			const id: [string, unknown] = ['id', `${label}${randomId()}`];
			// LineString lists the id second; MultiLineString adds it after the other options.
			const options = type === 'LINESTRING' ? [...base, id, ...style] : [...base, ...style, id];
			return `<polyline points="${points}"${svgOptions(options)}/>`;
		}).join('');
	}
	if (type === 'POLYGON' || type === 'MULTIPOLYGON') {
		const polygons = type === 'POLYGON' ? [substr(spatial, 9, -2)] : substr(spatial, 15, -3).split(')),((');
		return polygons.map((polygon) => {
			const style: [string, unknown][] = [['stroke', 'black'], ['stroke-width', 0.5], ['fill', color], ['fill-rule', 'evenodd'], ['fill-opacity', 0.8]];
			const id: [string, unknown] = ['id', `${label}${randomId()}`];
			const options: [string, unknown][] = type === 'POLYGON'
				? [['data-label', label], id, ['class', 'polygon vector'], ...style]
				: [['data-label', label], ['class', 'multipolygon vector'], ...style, id];
			return `<path d="${pathForPolygon(polygon, scaleData)}"${svgOptions(options)}/>`;
		}).join('');
	}
	return explodeGeomCol(substr(spatial, 19, -1)).map((part) => {
		const partType = geometryType(part);
		return partType === null ? '' : prepareRowAsSvg(partType, part, label, color, scaleData, randomId);
	}).join('');
}

/** Each geometry's prepareRowAsOl(). */
function prepareRowAsOl(type: string, spatial: string, rowSrid: number, label: string, color: number[], scaleData: ScaleData): string {
	const srid = rowSrid === 0 ? 4326 : rowSrid;
	if (type === 'POINT') {
		const [point] = extractPoints(substr(spatial, 6, -1), null);
		return `${pointStyle(color, label)}${boundsForOl(srid, scaleData)}var point = new ol.Feature({geometry: ${pointForOl(point, srid)}});point.setStyle(style);vectorLayer.addFeature(point);`;
	}
	if (type === 'MULTIPOINT') {
		const points = extractPoints(substr(spatial, 11, -1), null);
		return `${pointStyle(color, label)}${boundsForOl(srid, scaleData)}var multiPoint = new ol.geom.MultiPoint(${pointsArrayForOl(points, srid)});var feature = new ol.Feature({geometry: multiPoint});feature.setStyle(style);vectorLayer.addFeature(feature);`;
	}
	if (type === 'LINESTRING') {
		const points = extractPoints(substr(spatial, 11, -1), null);
		return `${lineStyle(color, label)}${boundsForOl(srid, scaleData)}var line = new ol.Feature({geometry: ${lineForOl(points, srid)}});line.setStyle(style);vectorLayer.addFeature(line);`;
	}
	if (type === 'MULTILINESTRING') {
		const lines = substr(spatial, 17, -2).split('),(');
		return `${lineStyle(color, label)}${boundsForOl(srid, scaleData)}${lineArrayForOl(lines, srid)}var multiLineString = new ol.geom.MultiLineString(arr);var feature = new ol.Feature({geometry: multiLineString});feature.setStyle(style);vectorLayer.addFeature(feature);`;
	}
	if (type === 'POLYGON') {
		const rings = substr(spatial, 9, -2).split('),(');
		return `${polygonStyle(color, label)}${boundsForOl(srid, scaleData)}${polygonForOl(rings, srid)}var feature = new ol.Feature({geometry: polygon});feature.setStyle(style);vectorLayer.addFeature(feature);`;
	}
	if (type === 'MULTIPOLYGON') {
		let polygons = 'var polygonArray = [];';
		for (const polygon of substr(spatial, 15, -3).split(')),((')) {
			polygons += `${polygonForOl(polygon.split('),('), srid)}polygonArray.push(polygon);`;
		}
		return `${polygonStyle(color, label)}${boundsForOl(srid, scaleData)}${polygons}var multiPolygon = new ol.geom.MultiPolygon(polygonArray);var feature = new ol.Feature(multiPolygon);feature.setStyle(style);vectorLayer.addFeature(feature);`;
	}
	return explodeGeomCol(substr(spatial, 19, -1)).map((part) => {
		const partType = geometryType(part);
		return partType === null ? '' : prepareRowAsOl(partType, part, rowSrid, label, color, scaleData);
	}).join('');
}

export type GisRow = Record<string, string | null>;

/** GisVisualization::modifySqlQuery(). */
export function modifySqlQuery(sqlQuery: string, settings: { labelColumn?: unknown; spatialColumn?: unknown; }, version: number, isMariaDB: boolean, rows: number, pos: number): string {
	const asText = version >= 50600 ? 'ST_ASTEXT' : 'ASTEXT';
	const srid = version >= 50600 ? 'ST_SRID' : 'SRID';
	const axisOrder = version >= 80001 && !isMariaDB ? ', \'axis-order=long-lat\'' : '';
	let sql = 'SELECT ';
	const label = phpString(settings.labelColumn);
	if (label !== '' && label !== '0') {
		sql += `${backquote(label)}, `;
	}
	const spatial = backquote(phpString(settings.spatialColumn));
	sql += `${asText}(${spatial}${axisOrder}) AS ${spatial}, `;
	sql += `${srid}(${spatial}) AS ${backquote('srid')} `;
	sql += `FROM (${sqlQuery.replace(/;+$/, '')}) AS ${backquote('temp_gis')}`;
	if (rows > 0) {
		sql += pos >= 0 ? ` LIMIT ${pos}, ${rows}` : ` LIMIT ${rows}`;
	}
	return sql;
}

/** GisVisualization::scaleDataSet(). */
export function scaleDataSet(data: GisRow[], settings: VisualizationSettings): ScaleData {
	const border = 15;
	const width = Number(settings.width);
	const height = Number(settings.height);
	let extent = EMPTY_EXTENT;
	for (const row of data) {
		const spatial = row[phpString(settings.spatialColumn)];
		const type = typeof spatial === 'string' ? geometryType(spatial) : null;
		if (type === null || typeof spatial !== 'string') {
			continue;
		}
		const scale = scaleRow(type, spatial);
		extent = {
			maxX: Math.max(extent.maxX, scale.maxX),
			minX: Math.min(extent.minX, scale.minX),
			maxY: Math.max(extent.maxY, scale.maxY),
			minY: Math.min(extent.minY, scale.minY),
		};
	}
	if (!Number.isFinite(extent.minX) || !Number.isFinite(extent.minY)) {
		extent = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
	}
	const xRatio = (extent.maxX - extent.minX) / (width - (2 * border));
	const yRatio = (extent.maxY - extent.minY) / (height - (2 * border));
	const ratio = Math.max(xRatio, yRatio);
	const scale = ratio === 0 ? 1 : 1 / ratio;
	const x = ratio === 0 || xRatio < yRatio ? (extent.maxX + extent.minX - (width / scale)) / 2 : extent.minX - (border / scale);
	const y = ratio === 0 || xRatio >= yRatio ? (extent.maxY + extent.minY - (height / scale)) / 2 : extent.minY - (border / scale);
	return { scale, x, y, ...extent, height };
}

function eachGeometry(data: GisRow[], settings: VisualizationSettings, render: (type: string, spatial: string, row: GisRow, index: number) => string): string {
	let colorNumber = 0;
	let output = '';
	for (const row of data) {
		const spatial = row[phpString(settings.spatialColumn)];
		const type = typeof spatial === 'string' ? geometryType(spatial) : null;
		if (type === null || typeof spatial !== 'string') {
			continue;
		}
		output += render(type, spatial, row, colorNumber % settings.colors.length);
		colorNumber++;
	}
	return output;
}

function rowLabel(row: GisRow, settings: VisualizationSettings): string {
	const column = settings.labelColumn;
	if (column === undefined || column === null) {
		return '';
	}
	return row[phpString(column)] ?? '';
}

/** GisVisualization::asSVG(). */
export function visualizationSvg(data: GisRow[], settings: VisualizationSettings, randomId: () => number): string {
	const scaleData = scaleDataSet(data, settings);
	const rows = eachGeometry(data, settings, (type, spatial, row, index) => prepareRowAsSvg(type, spatial, htmlspecialchars(rowLabel(row, settings)), settings.colors[index], scaleData, randomId));
	return '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n'
		+ `<svg version="1.1" xmlns:svg="http://www.w3.org/2000/svg" xmlns="http://www.w3.org/2000/svg" width="${Math.trunc(phpFloat(phpString(settings.width)))}" height="${Math.trunc(phpFloat(phpString(settings.height)))}">`
		+ `<g id="groupPanel">${rows}</g></svg>`;
}

/** GisVisualization::asOl(). */
export function visualizationOl(data: GisRow[], settings: VisualizationSettings): string {
	const scaleData = scaleDataSet(data, settings);
	const rows = eachGeometry(data, settings, (type, spatial, row, index) => prepareRowAsOl(type, spatial, Math.trunc(phpFloat(row.srid ?? '')), rowLabel(row, settings), settings.colors_hex[index], scaleData));
	return 'function drawOpenLayers() {if (typeof ol !== "undefined") {var olCss = "js/vendor/openlayers/theme/ol.css";'
		+ 'if (!document.querySelector(\'link[rel="stylesheet"][href="\' + olCss + \'"]\')) {var link = document.createElement(\'link\');link.rel = \'stylesheet\';link.type = \'text/css\';link.href = olCss;document.head.appendChild(link);}'
		+ 'var vectorLayer = new ol.source.Vector({});var map = new ol.Map({target: \'openlayersmap\',layers: [new ol.layer.Tile({source: new ol.source.OSM()}),new ol.layer.Vector({source: vectorLayer})],'
		+ 'view: new ol.View({center: ol.proj.fromLonLat([37.41, 8.82]),zoom: 4}),controls: [new ol.control.MousePosition({coordinateFormat: ol.coordinate.createStringXY(4),projection: \'EPSG:4326\'}),new ol.control.Zoom,new ol.control.Attribution]});'
		+ `${rows}return map;}return undefined;}`;
}

/** GisVisualization::hasSrid(). */
export function hasSrid(data: GisRow[]): boolean {
	return data.some(row => phpFloat(row.srid ?? '') !== 0);
}

/** GisVisualization::sanitizeName(): Sanitize::sanitizeFilename() plus the extension when missing. */
export function sanitizeFileName(fileName: string, extension: string): string {
	let name = fileName.replaceAll(/[^\w.-]/g, '_');
	if (!name.slice(-(extension.length + 1)).toLowerCase().endsWith(`.${extension}`)) {
		name += `.${extension}`;
	}
	return name;
}

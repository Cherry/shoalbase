import { describe, expect, it } from 'vitest';

import {
	DEFAULT_SETTINGS,
	type GisRow,
	hasSrid,
	modifySqlQuery,
	phpFloat,
	sanitizeFileName,
	scaleDataSet,
	visualizationOl,
	visualizationSvg,
} from './gis-visualization.ts';

const settings = { ...DEFAULT_SETTINGS, spatialColumn: 'shape', labelColumn: 'label' };
let counter = 0;
const nextId = (): number => ++counter;

// ST_AsText() output of the oracle's test table, which was diffed against phpMyAdmin with only the random ids differing.
const rows = [
	{ label: 'pt <a>', shape: 'POINT(10.5 20.25)', srid: '0' },
	{ label: 'poly', shape: 'POLYGON((0 0,10 0,10 10,0 10,0 0),(2 2,3 2,3 3,2 2))', srid: '0' },
	{ label: 'mpt', shape: 'MULTIPOINT((1 1),(2 2))', srid: '0' },
	{ label: 'mline', shape: 'MULTILINESTRING((0 0,1 1),(2 2,3 3))', srid: '0' },
	{ label: 'mpoly', shape: 'MULTIPOLYGON(((0 0,1 0,1 1,0 0)),((5 5,6 5,6 6,5 5)))', srid: '0' },
	{ label: 'coll', shape: 'GEOMETRYCOLLECTION(POINT(4 4),LINESTRING(0 1,1 2))', srid: '0' },
	{ label: 'empty', shape: null, srid: null },
];

describe('modifySqlQuery', () => {
	it('selects the label, the WKT and the SRID of the paged query', () => {
		expect(modifySqlQuery('SELECT * FROM `t`;', settings, 80400, false, 25, 0)).toBe('SELECT `label`, ST_ASTEXT(`shape`, \'axis-order=long-lat\') AS `shape`, ST_SRID(`shape`) AS `srid` FROM (SELECT * FROM `t`) AS `temp_gis` LIMIT 0, 25');
		expect(modifySqlQuery('SELECT 1', { spatialColumn: 'g', labelColumn: '' }, 50500, false, 0, 0)).toBe('SELECT ASTEXT(`g`) AS `g`, SRID(`g`) AS `srid` FROM (SELECT 1) AS `temp_gis`');
		expect(modifySqlQuery('SELECT 1', { spatialColumn: 'g' }, 100600, true, 5, -1)).toBe('SELECT ST_ASTEXT(`g`) AS `g`, ST_SRID(`g`) AS `srid` FROM (SELECT 1) AS `temp_gis` LIMIT 5');
	});
});

describe('visualization', () => {
	it('draws every geometry type as SVG like the oracle', () => {
		counter = 0;
		const svg = visualizationSvg(rows, settings, nextId);
		expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<svg version="1.1" xmlns:svg="http://www.w3.org/2000/svg" xmlns="http://www.w3.org/2000/svg" width="600" height="450"><g id="groupPanel">')).toBe(true);
		expect(svg).toContain('<circle cx="408.88888888889" cy="15" r="3" data-label="pt &lt;a&gt;" id="pt &lt;a&gt;1" class="point vector" fill="white" stroke="#B02EE0" stroke-width="2"/>');
		expect(svg).toContain('<path d=" M 191.11111111111, 435 L 398.51851851852, 435 L 398.51851851852, 227.59259259259 L 191.11111111111, 227.59259259259 Z  M 232.59259259259, 393.51851851852 L 253.33333333333, 393.51851851852 L 253.33333333333, 372.77777777778 Z " data-label="poly" id="poly2" class="polygon vector" stroke="black" stroke-width="0.5" fill="#E0642E" fill-rule="evenodd" fill-opacity="0.8"/>');
		expect(svg).toContain('<circle cx="211.85185185185" cy="414.25925925926" r="3" data-label="mpt" class="multipoint vector" fill="white" stroke="#E0D62E" stroke-width="2" id="mpt3"/>');
		expect(svg).toContain('<polyline points="191.11111111111,435 211.85185185185,414.25925925926 " data-label="mline" class="linestring vector" fill="none" stroke="#2E97E0" stroke-width="2" id="mline5"/>');
		expect(svg).toContain('data-label="mpoly" class="multipolygon vector" stroke="black" stroke-width="0.5" fill="#BCE02E" fill-rule="evenodd" fill-opacity="0.8" id="mpoly7"/>');
		expect(svg).toContain('<polyline points="191.11111111111,414.25925925926 211.85185185185,393.51851851852 " data-label="coll" id="coll10" class="linestring vector" fill="none" stroke="#E02E75" stroke-width="2"/></g></svg>');
	});

	it('skips points that land on the drawing edge and rows without geometry', () => {
		// A zero width puts the scaled x of these points at exactly 0, which upstream treats as "no point".
		const edge = [{ shape: 'POINT(0 0)', srid: '0' }, { shape: 'MULTIPOINT(0 0,0 420)', srid: '0' }, { shape: 'TEXT', srid: '0' }, { shape: 'CIRCLE(1)', srid: '0' }];
		expect(visualizationSvg(edge, { ...DEFAULT_SETTINGS, spatialColumn: 'shape', width: '0' }, nextId)).toBe('<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<svg version="1.1" xmlns:svg="http://www.w3.org/2000/svg" xmlns="http://www.w3.org/2000/svg" width="0" height="450"><g id="groupPanel"></g></svg>');
		expect(scaleDataSet([], { ...DEFAULT_SETTINGS, spatialColumn: 'shape' })).toEqual({ scale: 1, x: -300, y: -225, minX: 0, minY: 0, maxX: 0, maxY: 0, height: 450 });
	});

	it('scales a tall data set by its height', () => {
		const tall = scaleDataSet([{ shape: 'LINESTRING(0 0,1 100)' }], { ...DEFAULT_SETTINGS, spatialColumn: 'shape' });
		expect(tall.x).toBeLessThan(0);
		expect(tall.y).toBeCloseTo(-15 / tall.scale);
	});

	it('scales a wide data set by its width', () => {
		const wide = scaleDataSet([{ shape: 'LINESTRING(0 0,100 1)' }], { ...DEFAULT_SETTINGS, spatialColumn: 'shape' });
		expect(wide.scale).toBeCloseTo(5.7);
		expect(wide.x).toBeCloseTo(-15 / wide.scale);
		expect(wide.y).toBeCloseTo((1 - (450 / wide.scale)) / 2);
	});

	it('reads a coordinate without a partner as 0 and skips unknown collection members', () => {
		counter = 0;
		const odd: GisRow[] = [{ shape: 'LINESTRING(5,2 3)', srid: '0' }, { shape: 'GEOMETRYCOLLECTION(CIRCLE(1),POINT(1 1))' }];
		const oddSettings = { ...DEFAULT_SETTINGS, spatialColumn: 'shape', labelColumn: 'missing' };
		expect(scaleDataSet(odd, oddSettings)).toMatchObject({ minX: 1, maxX: 5, minY: 0, maxY: 3 });
		const svg = visualizationSvg(odd, oddSettings, nextId);
		expect(svg).toContain('<polyline points="');
		expect(svg).toContain('class="point vector"');
		expect(svg).not.toContain('CIRCLE');
		const ol = visualizationOl(odd, oddSettings);
		expect(ol).toContain('new ol.geom.Point(');
		expect(ol).toContain('ol.proj.get("EPSG:4326")');
	});

	it('writes the OpenLayers script with styles, bounds and features', () => {
		const ol = visualizationOl(rows, settings);
		expect(ol.startsWith('function drawOpenLayers() {if (typeof ol !== "undefined") {var olCss = "js/vendor/openlayers/theme/ol.css";')).toBe(true);
		expect(ol).toContain('var stroke = new ol.style.Stroke({"color":[176,46,224],"width":2});');
		expect(ol).toContain(',text: new ol.style.Text({"text":"pt <a>","offsetY":-9})});var minLoc = [0, 0];var maxLoc = [10.5, 20.25];');
		expect(ol).toContain('ol.proj.get("EPSG:4326")');
		expect(ol).toContain('var point = new ol.Feature({geometry: (new ol.geom.Point([10.5,20.25]).transform(ol.proj.get("EPSG:4326"), ol.proj.get(\'EPSG:3857\')))});');
		expect(ol).toContain('fill: new ol.style.Fill({"color":[224,100,46,0.8]}),stroke: new ol.style.Stroke({"color":[0,0,0],"width":0.5})');
		expect(ol).toContain('var line = new ol.geom.LinearRing(new Array(');
		expect(ol).toContain('var multiPoint = new ol.geom.MultiPoint(');
		expect(ol).toContain('var multiLineString = new ol.geom.MultiLineString(arr);');
		expect(ol).toContain('var multiPolygon = new ol.geom.MultiPolygon(polygonArray);var feature = new ol.Feature(multiPolygon);');
		expect(ol).toContain('var line = new ol.Feature({geometry: new ol.geom.LineString(');
		expect(ol.endsWith('return map;}return undefined;}')).toBe(true);
	});

	it('uses the row SRID and leaves out empty labels', () => {
		const ol = visualizationOl([{ shape: 'LINESTRING(1 2,3 4)', srid: '3857' }, { shape: 'POLYGON((0 0,1 1,0 0))', srid: '0' }, { shape: 'MULTILINESTRING((0 0,1 1))', srid: '0' }, { shape: 'MULTIPOLYGON(((0 0,1 1,0 0)))', srid: '0' }, { shape: 'MULTIPOINT(1 1)', srid: '0' }], { ...DEFAULT_SETTINGS, spatialColumn: 'shape' });
		expect(ol).toContain('ol.proj.get("EPSG:3857")');
		expect(ol).not.toContain('text:');
		expect(hasSrid([{ srid: '0' }, { srid: null }])).toBe(false);
		expect(hasSrid([{ srid: '4326' }])).toBe(true);
	});
});

describe('helpers', () => {
	it('casts like PHP and sanitises download names', () => {
		expect(phpFloat('(1')).toBe(0);
		expect(phpFloat(' 2.5e1x')).toBe(25);
		expect(sanitizeFileName('my shape', 'svg')).toBe('my_shape.svg');
		expect(sanitizeFileName('a.SVG', 'svg')).toBe('a.SVG');
	});
});

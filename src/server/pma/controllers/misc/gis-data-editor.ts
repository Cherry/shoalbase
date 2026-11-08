// Port of Controllers\GisDataEditorController (/gis-data-editor): the geometry editor dialog and its live WKT preview.
import {
	GIS_TYPES,
	type GisArray,
	arrayMerge,
	generateParams,
	generateWkt,
	gisDataToTwig,
	gisGet,
	toGisArray,
	validateGisData,
} from '../../../../lib/pma/gis/gis-data.ts';
import {
	DEFAULT_SETTINGS,
	type GisRow,
	type VisualizationSettings,
	visualizationOl,
	visualizationSvg,
} from '../../../../lib/pma/table-data/gis-visualization.ts';
import {
	nestedParams,
	phpArray,
	phpEmpty,
	phpScalar,
} from '../../../../lib/pma/table-data/php-params.ts';
import { phpString } from '../../../../lib/twig/php.ts';
import { render } from '../table-structure/common.ts';

import type { Controller, ControllerContext } from '../../dispatcher.ts';

/** PHP's (int) cast of a posted SRID. */
function phpInt(value: string): number {
	const match = /^[\t\n\v\f\r ]*[+-]?\d+/.exec(value);
	return match === null ? 0 : Number.parseInt(match[0], 10);
}

function sridOf(gisData: GisArray): number {
	const srid = gisData.get('srid');
	if (typeof srid === 'number') {
		return Math.trunc(srid);
	}
	if (typeof srid === 'string' && srid !== '') {
		return phpInt(srid);
	}
	return 0;
}

async function gisDataEditor(context: ControllerContext): Promise<Response> {
	const { response, dbi } = context;
	const post = nestedParams(context.request.post);
	const field = phpScalar(post.field);
	if (field === undefined) {
		return response.response();
	}
	const type = phpScalar(post.type) ?? 'GEOMETRY';
	const value = phpScalar(post.value);
	const inputName = phpScalar(post.input_name) ?? null;

	const posted = phpArray(post.gis_data);
	let gisData: GisArray = posted === undefined ? new Map() : toGisArray(posted);
	const geomType = validateGisData(gisData, type, value);
	if (value !== undefined) {
		gisData = arrayMerge(gisData, generateParams(geomType, value));
	}

	const srid = sridOf(gisData);
	const wkt = generateWkt(geomType, gisData, 0);
	const wktWithZero = generateWkt(geomType, gisData, 0, '0');
	const result = `'${wkt}',${srid}`;

	await dbi.connect();
	const settings: VisualizationSettings = {
		...DEFAULT_SETTINGS,
		width: 450,
		height: 300,
		spatialColumn: 'wkt',
		mysqlVersion: dbi.getVersion(),
		isMariaDB: dbi.isMariaDB(),
	};
	const data: GisRow[] = [{ wkt: wktWithZero, srid: String(srid) }];
	const randomId = (): number => Math.floor(Math.random() * 2_147_483_648);
	const visualization = visualizationSvg(data, settings, randomId);
	const openLayers = visualizationOl(data, settings);

	if (!phpEmpty(post.generate)) {
		response.addJSON({ result, visualization, openLayers });
		return response.response();
	}

	let geomCount = 1;
	if (geomType === 'GEOMETRYCOLLECTION') {
		const posted = gisGet(gisData, geomType, 'geom_count');
		if (posted !== undefined) {
			geomCount = posted instanceof Map ? 1 : phpInt(phpString(posted));
		}
		if (gisGet(gisData, geomType, 'add_geom') !== undefined) {
			geomCount++;
		}
	}

	response.addJSON('gis_editor', await render(context, 'gis_data_editor_form', {
		width: 450,
		height: 300,
		field,
		input_name: inputName,
		srid,
		visualization,
		open_layers: openLayers,
		column_type: type.toUpperCase(),
		gis_types: [...GIS_TYPES],
		geom_type: geomType,
		geom_count: geomCount,
		gis_data: gisDataToTwig(gisData),
		result,
	}));
	return response.response();
}

export const controllers: Record<string, Controller> = {
	GisDataEditorController: gisDataEditor,
};

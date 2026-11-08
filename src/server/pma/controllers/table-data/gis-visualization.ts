// Port of Controllers\Table\GisVisualizationController (/table/gis-visualization): the SVG and OpenLayers views and the SVG download.
import { getStartAndNumberOfRowsFieldsetData } from './chart.ts';
import { loadParserContext } from './relation.ts';
import { noCacheHeaders } from '../../../../lib/pma/ajax-response.ts';
import { phpContentType } from '../../../../lib/pma/export-import/filename.ts';
import { Message } from '../../../../lib/pma/message.ts';
import {
	DEFAULT_SETTINGS,
	type GisRow,
	type VisualizationSettings,
	hasSrid,
	modifySqlQuery,
	sanitizeFileName,
	visualizationOl,
	visualizationSvg,
} from '../../../../lib/pma/table-data/gis-visualization.ts';
import {
	type PhpArray,
	nestedParams,
	phpArray,
	phpEntries,
	phpScalar,
} from '../../../../lib/pma/table-data/php-params.ts';
import { getScriptNameForOption } from '../../../../lib/pma/util.ts';
import { getFromRoute } from '../../../../lib/twig/url.ts';
import { Limit, Parser, SelectStatement } from '../../../../sql-parser/index.ts';
import { checkSqlQuerySignature, signSqlQuery } from '../../core/sql-signature.ts';
import { hasDatabase } from '../database/common.ts';
import { render } from '../table-structure/common.ts';

import type { PmaContext } from '../../core/context.ts';
import type { Controller, ControllerContext } from '../../dispatcher.ts';

/** PHP's (int) cast. */
function phpInt(value: unknown): number {
	if (typeof value === 'number') {
		return Math.trunc(value);
	}
	const match = /^[\t\n\v\f\r ]*[+-]?\d+/.exec(String(value ?? ''));
	return match === null ? 0 : Number.parseInt(match[0], 10);
}

/** GisVisualizationController::getCandidateColumns(): non-spatial and spatial result columns. */
async function getCandidateColumns(context: PmaContext, sqlQuery: string): Promise<[string[], string[]]> {
	await context.dbi.connect();
	loadParserContext(context);
	const statement = new Parser(sqlQuery).statements[0];
	const labels: string[] = [];
	const spatial: string[] = [];
	if (!(statement instanceof SelectStatement)) {
		return [labels, spatial];
	}
	statement.limit = new Limit(0, 0);
	const result = await context.dbi.tryQuery(statement.build());
	for (const meta of result === false ? [] : result.getFieldsMeta()) {
		if (meta.isMappedTypeGeometry) {
			spatial.push(meta.name);
		} else {
			labels.push(meta.name);
		}
	}
	return [labels, spatial];
}

function settingsFrom(value: PhpArray | undefined): Record<string, unknown> {
	const settings: Record<string, unknown> = Object.fromEntries(phpEntries(value ?? {}));
	return settings;
}

async function gisVisualization(context: ControllerContext): Promise<Response> {
	const { response, dbi, config, request, session } = context;
	if (!await hasDatabase(context)) {
		return response.response();
	}
	const post = nestedParams(request.post);
	const get = nestedParams(request.query);

	let sqlQuery = '';
	const getQuery = phpScalar(get.sql_query);
	if (getQuery !== undefined && get.sql_signature !== undefined) {
		if (checkSqlQuerySignature(session, getQuery, phpScalar(get.sql_signature))) {
			sqlQuery = getQuery;
		}
	} else if (post.sql_query !== undefined) {
		sqlQuery = phpScalar(post.sql_query) ?? '';
	}
	if (sqlQuery === '') {
		response.setRequestStatus(false);
		response.addHTML(Message.error('No SQL query was set to fetch data.').getDisplay());
		return response.response();
	}

	const [labelCandidates, spatialCandidates] = await getCandidateColumns(context, sqlQuery);
	let userSettings: Record<string, unknown> = {};
	if (phpArray(post.visualizationSettings) !== undefined) {
		userSettings = settingsFrom(phpArray(post.visualizationSettings));
	} else if (phpArray(get.visualizationSettings) !== undefined) {
		userSettings = settingsFrom(phpArray(get.visualizationSettings));
	}
	userSettings.mysqlVersion = dbi.getVersion();
	userSettings.isMariaDB = dbi.isMariaDB();
	if (userSettings.labelColumn === undefined && labelCandidates.length > 0) {
		userSettings.labelColumn = '';
	}
	userSettings.spatialColumn ??= spatialCandidates[0] ?? null;

	const pos = phpInt(post.pos ?? get.pos ?? session.tmpval.pos);
	let rows: number;
	if (post.session_max_rows !== undefined || get.session_max_rows !== undefined) {
		rows = phpInt(post.session_max_rows ?? get.session_max_rows);
	} else if (session.tmpval.max_rows !== 'all') {
		rows = phpInt(session.tmpval.max_rows);
	} else {
		rows = phpInt(config.MaxRows);
	}

	const modified = modifySqlQuery(sqlQuery, userSettings, dbi.getVersion(), dbi.isMariaDB(), rows, pos);
	const result = await dbi.tryQuery(modified);
	const data: GisRow[] = result === false ? [] : result.fetchAllAssoc();
	const randomId = (): number => Math.floor(Math.random() * 2_147_483_648);

	if (get.saveToFile !== undefined) {
		response.disable();
		const settings: VisualizationSettings = { ...DEFAULT_SETTINGS, ...userSettings };
		// PNG and PDF need GD and TCPDF, which the Worker does not have; upstream sends nothing when GD is missing.
		if (phpScalar(get.fileFormat) === 'svg') {
			for (const [name, value] of noCacheHeaders(new Date())) {
				response.header(name, value);
			}
			const fileName = sanitizeFileName(String(userSettings.spatialColumn ?? ''), 'svg');
			response.header('Content-Description', 'File Transfer');
			response.header('Content-Disposition', `attachment; filename="${fileName}"`);
			response.header('Content-Type', phpContentType('image/svg+xml'));
			response.header('Content-Transfer-Encoding', 'binary');
			response.addHTML(visualizationSvg(data, settings, randomId));
		}
		return response.response();
	}

	response.addScriptFiles(['vendor/openlayers/OpenLayers.js', 'table/gis_visualization.js']);
	if (post.displayVisualization === undefined) {
		if (hasSrid(data)) {
			userSettings.choice = 'useBaseLayer';
		} else {
			delete userSettings.choice;
		}
	}
	const settings: VisualizationSettings = { ...DEFAULT_SETTINGS, ...userSettings };
	const visualizationSettings: Record<string, unknown> = { ...userSettings };
	for (const [setting, value] of Object.entries(DEFAULT_SETTINGS)) {
		visualizationSettings[setting] ??= value;
	}

	const url = context.urlState();
	const goto = request.params.goto;
	const urlParams: Record<string, unknown> = {};
	if (typeof goto === 'string' && goto !== '') {
		urlParams.goto = goto;
	}
	urlParams.db = context.db;
	urlParams.table = context.table;
	urlParams.server = context.server;
	urlParams.goto = getScriptNameForOption(url, config.DefaultTabDatabase, 'database');
	urlParams.back = getFromRoute(url, '/sql');
	urlParams.sql_query = sqlQuery;
	urlParams.sql_signature = signSqlQuery(session, sqlQuery);
	const downloadUrl = getFromRoute(url, '/table/gis-visualization', {
		...urlParams,
		'saveToFile': true,
		'session_max_rows': rows,
		pos,
		'visualizationSettings[spatialColumn]': visualizationSettings.spatialColumn,
		'visualizationSettings[labelColumn]': visualizationSettings.labelColumn ?? null,
	});

	response.addHTML(await render(context, 'table/gis_visualization/gis_visualization', {
		url_params: urlParams,
		download_url: downloadUrl,
		label_candidates: labelCandidates,
		spatial_candidates: spatialCandidates,
		visualization_settings: visualizationSettings,
		start_and_number_of_rows_fieldset: getStartAndNumberOfRowsFieldsetData(context, sqlQuery),
		visualization: visualizationSvg(data, settings, randomId),
		draw_ol: visualizationOl(data, settings),
	}));
	return response.response();
}

export const controllers: Record<string, Controller> = {
	'Table/GisVisualizationController': gisVisualization,
};

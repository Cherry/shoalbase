// Ports of Controllers\Table\SearchController (/table/search) and ZoomSearchController (/table/zoom-search).
import { requestGoto } from './change.ts';
import {
	type ForeignData,
	getDisplayField,
	getForeignData,
	getForeigners,
} from './relation.ts';
import { escapeString } from '../../../../lib/pma/dbi-sql.ts';
import { phpJsonEncode } from '../../../../lib/pma/json.ts';
import { md5 } from '../../../../lib/pma/md5.ts';
import { getUniqueCondition, printableBitValue } from '../../../../lib/pma/sql/results.ts';
import { getGisDataTypes } from '../../../../lib/pma/table-data/insert-edit.ts';
import {
	type PhpArray,
	nestedParams,
	phpArray,
	phpEmpty,
	phpGet,
	phpScalar,
	phpToTwig,
} from '../../../../lib/pma/table-data/php-params.ts';
import { buildSearchQuery } from '../../../../lib/pma/table-data/search.ts';
import { INTEGER_TYPES, getIntegerRange, getTypeOperatorsHtml } from '../../../../lib/pma/table-data/types.ts';
import { extractColumnSpec } from '../../../../lib/pma/table-structure/column-spec.ts';
import { htmlspecialchars } from '../../../../lib/twig/php.ts';
import { backquote } from '../../../../lib/twig/sanitize.ts';
import { toTwigValue } from '../../../../lib/twig/values.ts';
import { checkSqlQuerySignature, signSqlQuery } from '../../core/sql-signature.ts';
import { Sql, SqlExit } from '../../display/sql.ts';
import { withMysqlDie } from '../server/mysql-die.ts';
import { checkDbTableExists, render } from '../table-structure/common.ts';

import type { Foreigners } from '../../../../lib/pma/table-data/relation.ts';
import type { PmaContext } from '../../core/context.ts';
import type { Controller, ControllerContext } from '../../dispatcher.ts';

/** The column details both search controllers load in their constructor. */
export interface TableInfo {
	columnNames: string[];
	columnTypes: string[];
	originalColumnTypes: string[];
	columnCollations: string[];
	/** Search keeps booleans, zoom search the raw Null column. */
	columnNullFlags: (boolean | string)[];
	geomColumnFlag: boolean;
	foreigners: Foreigners;
}

/** SearchController::loadTableInfo() and ZoomSearchController::loadTableInfo(). */
export async function loadTableInfo(context: PmaContext, rawNullFlags: boolean): Promise<TableInfo> {
	const { db, table } = context;
	const columns = await context.dbi.getColumns(db, table, true);
	const geomTypes = getGisDataTypes();
	const info: TableInfo = { columnNames: [], columnTypes: [], originalColumnTypes: [], columnCollations: [], columnNullFlags: [], geomColumnFlag: false, foreigners: {} };
	for (const row of columns.values()) {
		info.columnNames.push(row.Field ?? '');
		let type = row.Type ?? '';
		info.originalColumnTypes.push(type.toLowerCase());
		if (geomTypes.includes(type)) {
			info.geomColumnFlag = true;
		}
		if (/^set/i.test(type) || /^enum/i.test(type)) {
			type = type.replaceAll(',', ', ');
		} else {
			if (!/BINARY\(/i.test(type)) {
				type = type.replaceAll(/binary/gi, '');
			}
			type = type.replaceAll(/zerofill/gi, '').replaceAll(/unsigned/gi, '').toLowerCase();
		}
		if (type === '' || type === '0') {
			type = '&nbsp;';
		}
		info.columnTypes.push(type);
		info.columnNullFlags.push(rawNullFlags ? (row.Null ?? '') : row.Null === 'YES');
		const collation = row.Collation ?? '';
		info.columnCollations.push(collation !== '' && collation !== '0' && collation !== 'NULL' ? collation : '');
	}
	info.foreigners = await getForeigners(context, db, table);
	return info;
}

/** The value of getColumnProperties() as the templates read it. */
type ColumnProperties = Map<string, string>;

/** SearchController::getColumnProperties() (and the zoom search copy, which differs only in the form id). */
async function getColumnProperties(context: PmaContext, info: TableInfo, post: PhpArray, searchIndex: number, columnIndex: number, formId: string): Promise<ColumnProperties> {
	const selectedOperator = phpScalar(phpGet(post, 'criteriaColumnOperators', searchIndex)) ?? '';
	const enteredValue = post.criteriaValues ?? '';
	const type = info.columnTypes[columnIndex] ?? '';
	const collation = info.columnCollations[columnIndex] ?? '';
	const cleanType = type.replace(/\(.*/s, '');
	const nullable = info.columnNullFlags[columnIndex];
	const typeOperators = getTypeOperatorsHtml(cleanType, nullable === true || (typeof nullable === 'string' && nullable !== '' && nullable !== '0'), selectedOperator);
	const func = await render(context, 'table/search/column_comparison_operators', { search_index: searchIndex, type_operators: typeOperators });
	const columnName = info.columnNames[columnIndex] ?? '';
	const foreignData: ForeignData = await getForeignData(context, info.foreigners, columnName, false, '', '');
	let htmlAttributes = '';
	if (INTEGER_TYPES.includes(cleanType)) {
		const unsigned = extractColumnSpec(info.originalColumnTypes[columnIndex] ?? '').unsigned;
		const [min, max] = getIntegerRange(cleanType, !unsigned);
		htmlAttributes = `data-min="${min}" data-max="${max}"`;
	}
	htmlAttributes += ` onfocus="return verifyAfterSearchFieldChange(${searchIndex}, '${formId}')"`;
	const value = await render(context, 'table/search/input_box', {
		str: '',
		column_type: type,
		column_data_type: cleanType.toUpperCase(),
		html_attributes: htmlAttributes,
		column_id: 'fieldID_',
		in_zoom_search_edit: false,
		foreigners: info.foreigners,
		column_name: columnName,
		column_name_hash: md5(columnName),
		foreign_data: foreignData,
		table: context.table,
		column_index: searchIndex,
		foreign_max_limit: context.config.ForeignKeyMaxLimit,
		criteria_values: phpToTwig(enteredValue),
		db: context.db,
		in_fbs: true,
	});
	return new Map([['type', type], ['collation', collation], ['func', func], ['value', value]]);
}

/** A stand-in for the controller passed to templates as `self`, answering from precomputed properties. */
function propertiesProvider(properties: Map<string, ColumnProperties>): { getColumnProperties: (searchIndex: number, columnIndex: number) => ColumnProperties | undefined; } {
	return {
		getColumnProperties: (searchIndex: number, columnIndex: number) => properties.get(`${searchIndex}:${columnIndex}`),
	};
}

/** The SELECT * FROM ... WHERE ... row lookup both search pages answer for a clicked plot point. */
async function getDataRowAction(context: PmaContext, post: PhpArray): Promise<Response> {
	const { response, dbi } = context;
	const whereClause = phpScalar(post.where_clause) ?? '';
	if (!checkSqlQuerySignature(context.session, whereClause, phpScalar(post.where_clause_sign))) {
		return response.response();
	}
	const result = await dbi.query(`SELECT * FROM ${backquote(phpScalar(post.db) ?? '')}.${backquote(phpScalar(post.table) ?? '')} WHERE ${whereClause};`);
	const meta = result.getFieldsMeta();
	let rowInfo: Record<string, string | null> | undefined;
	for (let row = result.fetchAssoc(); row !== null; row = result.fetchAssoc()) {
		for (const [index, column] of Object.keys(row).entries()) {
			if (meta[index]?.isMappedTypeBit === true) {
				row[column] = printableBitValue(row[column] ?? '0', meta[index].length);
			}
		}
		rowInfo = row;
	}
	if (rowInfo !== undefined) {
		response.addJSON('row_info', rowInfo);
	}
	return response.response();
}

const SEARCH_SCRIPTS = ['makegrid.js', 'sql.js', 'table/select.js', 'table/change.js', 'vendor/jquery/jquery.uitablefilter.js', 'gis_data_editor.js'];

async function search(context: ControllerContext): Promise<Response> {
	const { response, config } = context;
	const post = nestedParams(context.request.post);
	const info = await loadTableInfo(context, false);
	const missing = await checkDbTableExists(context);
	if (missing !== null) {
		return missing;
	}
	response.addScriptFiles(SEARCH_SCRIPTS);

	if (post.range_search !== undefined) {
		const column = phpScalar(post.column) ?? '';
		const minMax = await context.dbi.fetchSingleRow(`SELECT MIN(${backquote(column)}) AS \`min\`, MAX(${backquote(column)}) AS \`max\` FROM ${backquote(context.db)}.${backquote(context.table)}`);
		response.addJSON('column_data', minMax);
		return response.response();
	}

	if (post.columnsToDisplay === undefined && post.displayAllColumns === undefined) {
		const properties = new Map<string, ColumnProperties>();
		for (let index = 0; index < info.columnNames.length; index++) {
			properties.set(`${index}:${index}`, await getColumnProperties(context, info, post, index, index, '#tbl_search_form'));
		}
		response.addHTML(await render(context, 'table/search/index', {
			db: context.db,
			table: context.table,
			goto: requestGoto(context),
			self: propertiesProvider(properties),
			geom_column_flag: info.geomColumnFlag,
			column_names: info.columnNames,
			column_types: info.columnTypes,
			column_collations: info.columnCollations,
			default_sliders_state: config.InitialSlidersState,
			max_rows: Math.trunc(Number(config.MaxRows)) || 0,
		}));
		return response.response();
	}

	const sqlQuery = buildSearchQuery(post, context.dbi.getVersion());
	try {
		response.addHTML(await new Sql(context).executeQueryAndSendQueryResponse({
			analyzed: null,
			isGotoFile: false,
			db: context.db,
			table: context.table,
			findRealEnd: null,
			extraData: null,
			messageToShow: null,
			sqlData: null,
			goto: requestGoto(context),
			dispQuery: null,
			dispMessage: null,
			sqlQuery,
			completeQuery: null,
		}));
	} catch (error) {
		if (!(error instanceof SqlExit)) {
			throw error;
		}
	}
	return response.response();
}

const ZOOM_SCRIPTS = [
	'makegrid.js',
	'sql.js',
	'vendor/jqplot/jquery.jqplot.js',
	'vendor/jqplot/plugins/jqplot.canvasTextRenderer.js',
	'vendor/jqplot/plugins/jqplot.canvasAxisLabelRenderer.js',
	'vendor/jqplot/plugins/jqplot.dateAxisRenderer.js',
	'vendor/jqplot/plugins/jqplot.highlighter.js',
	'vendor/jqplot/plugins/jqplot.cursor.js',
	'table/zoom_plot_jqplot.js',
	'table/select.js',
	'table/change.js',
	'gis_data_editor.js',
];

/** PHP's loose == true for a request flag. */
function looseTrue(value: unknown): boolean {
	return typeof value === 'string' ? value !== '' && value !== '0' : value !== undefined;
}

/** array_search() over the column names, with PHP's false (read as index 0) when the name is missing. */
function columnKey(info: TableInfo, name: string): number | false {
	const index = info.columnNames.indexOf(name);
	return index === -1 ? false : index;
}

async function zoomSearch(context: ControllerContext): Promise<Response> {
	const { response, config, dbi } = context;
	const post = nestedParams(context.request.post);
	const info = await loadTableInfo(context, true);
	const missing = await checkDbTableExists(context);
	if (missing !== null) {
		return missing;
	}
	response.addScriptFiles(ZOOM_SCRIPTS);

	if (looseTrue(post.get_data_row)) {
		return getDataRowAction(context, post);
	}

	if (looseTrue(post.change_tbl_info)) {
		const field = phpScalar(post.field) ?? '';
		if (field === 'pma_null') {
			response.addJSON({ field_type: '', field_collation: '', field_operators: '', field_value: '' });
			return response.response();
		}
		const it = phpScalar(post.it);
		const searchIndex = it !== undefined && /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?\s*$/i.test(it) ? Math.trunc(Number(it)) : 0;
		const properties = await getColumnProperties(context, info, post, searchIndex, Number(columnKey(info, field)), '#zoom_search_form');
		response.addJSON('field_type', htmlspecialchars(properties.get('type')));
		response.addJSON('field_collation', properties.get('collation'));
		response.addJSON('field_operators', properties.get('func'));
		response.addJSON('field_value', properties.get('value'));
		return response.response();
	}

	let dataLabel: string | false;
	const postedLabel = phpScalar(post.dataLabel) ?? '';
	if (post.zoom_submit === undefined || postedLabel === '') {
		dataLabel = await getDisplayField(context, context.db, context.table);
	} else {
		dataLabel = postedLabel;
	}

	// displaySelectionFormAction().
	const goto = requestGoto(context);
	const criteriaColumnNames = phpArray(post.criteriaColumnNames);
	const keys: Record<string, number | false> = {};
	const properties = new Map<string, ColumnProperties>();
	for (let index = 0; index < 4; index++) {
		const name = phpScalar(criteriaColumnNames?.[index]);
		if (name === undefined || name === 'pma_null') {
			continue;
		}
		const key = columnKey(info, name);
		keys[name] = key;
		properties.set(`${index}:${Number(key)}`, await getColumnProperties(context, info, post, index, Number(key), '#zoom_search_form'));
	}
	const maxPlotLimit = phpEmpty(post.maxPlotLimit) ? Number(config.maxRowPlotLimit) : Number.parseInt(phpScalar(post.maxPlotLimit) ?? '0', 10) || 0;
	response.addHTML(await render(context, 'table/zoom_search/index', {
		db: context.db,
		table: context.table,
		goto,
		self: {
			getColumnProperties: (searchIndex: number, columnIndex: number | false) => properties.get(`${searchIndex}:${Number(columnIndex)}`),
		},
		geom_column_flag: info.geomColumnFlag,
		column_names: info.columnNames,
		data_label: dataLabel,
		keys,
		criteria_column_names: criteriaColumnNames === undefined ? null : phpToTwig(criteriaColumnNames),
		criteria_column_types: post.criteriaColumnTypes === undefined ? null : phpToTwig(post.criteriaColumnTypes),
		max_plot_limit: maxPlotLimit,
	}));

	const first = phpScalar(criteriaColumnNames?.[0]);
	const second = phpScalar(criteriaColumnNames?.[1]);
	if (post.zoom_submit === undefined || first === 'pma_null' || second === 'pma_null' || first === second) {
		return response.response();
	}

	// zoomSubmitAction().
	const sqlQuery = `${buildSearchQuery(post, dbi.getVersion())} LIMIT ${phpScalar(post.maxPlotLimit) ?? ''}`;
	const result = await dbi.query(`${sqlQuery};`);
	const fieldsMeta = result.getFieldsMeta();
	const data: Record<string, string | null>[] = [];
	const labelKey = dataLabel === false ? '' : dataLabel;
	for (let row = result.fetchAssoc(); row !== null; row = result.fetchAssoc()) {
		const [whereClause] = getUniqueCondition(fieldsMeta.slice(0, info.columnNames.length), Object.values(row), { forceUnique: true, isView: () => false, escapeString });
		const entry: Record<string, string | null> = {
			[first ?? '']: row[first ?? ''] ?? null,
			[second ?? '']: row[second ?? ''] ?? null,
			where_clause: whereClause,
			where_clause_sign: signSqlQuery(context.session, whereClause),
			[labelKey]: labelKey === '' ? '' : row[labelKey] ?? null,
		};
		data.push(entry);
	}
	const columnNamesHashes = Object.fromEntries(info.columnNames.map(name => [name, md5(name)]));
	const columnDataTypes = info.columnTypes.map(type => type.replace(/\(.*/s, '').toUpperCase());
	response.addHTML(await render(context, 'table/zoom_search/result_form', {
		db: context.db,
		table: context.table,
		column_names: info.columnNames,
		column_names_hashes: columnNamesHashes,
		foreigners: info.foreigners,
		column_null_flags: info.columnNullFlags,
		column_types: info.columnTypes,
		column_data_types: columnDataTypes,
		goto,
		data,
		data_json: phpJsonEncode(data),
		zoom_submit: true,
		foreign_max_limit: config.ForeignKeyMaxLimit,
	}, {
		functionOverrides: {
			get_foreign_data: async (foreigners: unknown, field: unknown) => toTwigValue(await getForeignData(context, foreigners as Foreigners, String(field), false, '', '')),
		},
	}));
	return response.response();
}

export const controllers: Record<string, Controller> = {
	'Table/SearchController': async context => withMysqlDie(context, async () => search(context)),
	'Table/ZoomSearchController': async context => withMysqlDie(context, async () => zoomSearch(context)),
};


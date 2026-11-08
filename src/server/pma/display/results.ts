// Port of PhpMyAdmin\Display\Results: the browse grid around a query result, with navigation, sorting and row links.
import { randomInt } from 'node:crypto';

import { type FieldMetadata, FieldType } from '../../../lib/pma/field-metadata.ts';
import { type LinkState, linkOrButton as linkOrButtonFor } from '../../../lib/pma/generator.ts';
import { phpJsonEncode } from '../../../lib/pma/json.ts';
import { md5 } from '../../../lib/pma/md5.ts';
import { Message } from '../../../lib/pma/message.ts';
import { pageSelector } from '../../../lib/pma/navigation-html.ts';
import { type QuerySettings, rememberQuerySettings } from '../../../lib/pma/session.ts';
import { internalRelations } from '../../../lib/pma/sql/internal-relations.ts';
import {
	ALL_ROWS,
	DELETE_ROW,
	DISPLAY_FULL_TEXT,
	type DisplayParts,
	GEOMETRY_DISP_GEOM,
	GEOMETRY_DISP_WKT,
	type HeaderColumn,
	KILL_PROCESS,
	NO_EDIT_OR_DELETE,
	POSITION_BOTH,
	POSITION_LEFT,
	POSITION_NONE,
	POSITION_RIGHT,
	RELATIONAL_DISPLAY_COLUMN,
	RELATIONAL_KEY,
	UPDATE_ROW,
	addClass,
	applyDisplaySettings,
	bin2hex,
	checkboxAndLinks,
	classForDateTimeRelatedFields,
	commentForRow,
	displayPartsForNonData,
	displayPartsForPrintView,
	displayPartsForSelect,
	displayPartsForShow,
	emptyDisplay,
	getPartialText,
	getUniqueCondition,
	isColumnNumeric,
	isSessionMaxRowsUsed,
	mimeDefaultFunction,
	nullDisplay,
	pageOffsets,
	positionMessage,
	querySettingsForDisplay,
	repeatingHeaders,
	rowData,
	singleAndMultiSortUrls,
	sortByKeyOptions,
	tableHeadersForColumns,
	valueDisplay,
} from '../../../lib/pma/sql/results.ts';
import { isJustBrowsing } from '../../../lib/pma/sql/sql.ts';
import {
	SQL_PLUGIN_SCRIPTS,
	type TransformationPlugin,
	applyTransformation,
	specialLinkPlugin,
	specialLinkUrl,
	specialSchemaLink,
	transformationFor,
} from '../../../lib/pma/sql/transformations.ts';
import { formatByteDown, getScriptNameForOption } from '../../../lib/pma/util.ts';
import { getImage, showHint, themeImagePath } from '../../../lib/twig/html.ts';
import { htmlspecialchars, phpTrim } from '../../../lib/twig/php.ts';
import { backquote, sanitizeMessage } from '../../../lib/twig/sanitize.ts';
import { getCommon, getFromRoute } from '../../../lib/twig/url.ts';
import {
	type AnalyzedQuery,
	Parser,
	Query,
	SelectStatement,
} from '../../../sql-parser/index.ts';
import { renderTemplate, themeImageSet } from '../../twig/render.ts';
import {
	getComments,
	getDisplayField,
	getForeigners,
	loadParserContext,
} from '../controllers/table-data/relation.ts';
import { generatorState, getIcon, getMessage } from '../core/generator.ts';
import { getIndexesFromTable } from '../core/index.ts';
import { signSqlQuery } from '../core/sql-signature.ts';
import { PROP_COLUMN_ORDER, PROP_COLUMN_VISIB, Table } from '../core/table.ts';

import type { PmaContext } from '../core/context.ts';
import type { DbiResult, DbiValue } from '../core/dbi.ts';


/** [foreign table, foreign column, display column or false, foreign db] by column name. */
type RelationMap = Map<string, [string, string, string | false, string]>;

/** Results::setProperties() arguments. */
export interface ResultsProperties {
	unlimNumRows: number | false;
	fieldsMeta: FieldMetadata[];
	isCount: boolean;
	isExport: boolean;
	isFunc: boolean;
	isAnalyse: boolean;
	numRows: number;
	queryTime: number;
	isMaint: boolean;
	isExplain: boolean;
	isShow: boolean;
	showTable: Record<string, unknown> | null;
	printView: string | null;
	editable: boolean;
	isBrowseDistinct: boolean;
}

interface DisplayParams {
	emptypre: number;
	emptyafter: number;
	desc: string[];
}

interface ColumnParams {
	order: number[] | false;
	visibility: unknown[] | false;
}

const PHP_RAND_MAX = 2_147_483_647;

const isEmpty = (value: unknown): boolean => ([undefined, null, '', '0', 0, false] as unknown[]).includes(value);

/** strip_tags() for the "is it a BLOB label" check, which only needs tags gone. */
const stripTags = (value: string): string => value.replaceAll(/<[^>]*>?/g, '');

/** Util::unQuote() for the default quote characters. */
function unQuote(value: string): string {
	const characters = [...value];
	for (const quote of ['`', '"', '\'']) {
		if (characters.length > 0 && characters[0] === quote && characters.at(-1) === quote) {
			return characters.slice(1, -1).join('').replaceAll(quote + quote, () => quote);
		}
	}
	return value;
}

/** Generator::linkOrButton($url, null, $message, $tagParams) for a URL that is already built. */
function linkOrButtonPlain(state: LinkState, url: string, message: string, tagParams: Record<string, unknown> = {}): string {
	return linkOrButtonFor(state, url, null, message, tagParams);
}

/** mb_check_encoding($bytes, 'UTF-8') plus the control character check: the decoded text, or null to show hex. */
function printableUtf8(bytes: string): string | null {
	let text: string;
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(bytes, 'latin1'));
	} catch {
		return null;
	}
	// eslint-disable-next-line no-control-regex -- upstream's own pattern for text that must be shown as hex.
	if (/[\u{0}-\u{8}\v\f\u{E}-\u{1F}\u{80}-\u{9F}]/u.test(text)) {
		return null;
	}
	return text;
}

export class Results {
	private props: ResultsProperties = {
		unlimNumRows: 0,
		fieldsMeta: [],
		isCount: false,
		isExport: false,
		isFunc: false,
		isAnalyse: false,
		numRows: 0,
		queryTime: 0,
		isMaint: false,
		isExplain: false,
		isShow: false,
		showTable: null,
		printView: null,
		editable: false,
		isBrowseDistinct: false,
	};

	private highlightColumns: Set<string> = new Set();
	private displayParams: DisplayParams = { emptypre: 0, emptyafter: 0, desc: [] };
	private readonly whereClauseMap: Map<number, Map<string, string>> = new Map();
	private readonly viewTables = new Map<string, boolean>();
	readonly uniqueId = randomInt(0, PHP_RAND_MAX);

	constructor(
		private readonly context: PmaContext,
		public db: string,
		public table: string,
		private readonly server: number,
		readonly goto: string,
		readonly sqlQuery: string,
	) {}

	private get config() {
		return this.context.config;
	}

	private get tmpval() {
		return this.context.session.tmpval;
	}

	private get maxRows(): number | 'all' {
		return this.tmpval.max_rows ?? 0;
	}

	private get pos(): number {
		return Number(this.tmpval.pos ?? 0);
	}

	private linkState(): LinkState {
		return { url: this.context.urlState(), linkLengthLimit: this.config.LinkLengthLimit };
	}

	private route(route: string, params: Record<string, unknown> = {}): string {
		return getFromRoute(this.context.urlState(), route, params);
	}

	private sign(sqlQuery: string): string {
		return signSqlQuery(this.context.session, sqlQuery);
	}

	private async state() {
		return this.context.templateState();
	}

	/** Results::isSelect(): a "SELECT ... FROM one table" query. */
	private isSelect(analyzed: AnalyzedQuery): boolean {
		const statement = analyzed.statement as SelectStatement | undefined;
		return !(this.props.isCount || this.props.isExport || this.props.isFunc || this.props.isAnalyse)
			&& analyzed.select_from
			&& statement !== undefined
			&& Array.isArray(statement.from)
			&& statement.from.length === 1
			&& !isEmpty(statement.from[0].table);
	}

	private async isView(table: string, db: string): Promise<boolean> {
		return Table.get(this.context, table, db).isView();
	}

	/** Results::setDisplayPartsAndTotal(). */
	private async setDisplayPartsAndTotal(input: DisplayParts): Promise<[DisplayParts, number]> {
		const { db, table } = this;
		const { unlimNumRows, numRows } = this.props;
		let parts: DisplayParts;
		if (this.props.printView === '1') {
			parts = displayPartsForPrintView(input);
		} else if (this.props.isCount || this.props.isAnalyse || this.props.isMaint || this.props.isExplain) {
			parts = displayPartsForNonData(input, this.props.isMaint);
		} else if (this.props.isShow) {
			parts = displayPartsForShow(input, this.sqlQuery);
		} else {
			parts = displayPartsForSelect(input, [...this.props.fieldsMeta]);
		}
		let total = 0;
		if (Number(unlimNumRows) > 0) {
			total = Number(unlimNumRows);
		} else if (parts.nav_bar === '1' || (parts.sort_lnk === '1' && db !== '' && table !== '')) {
			total = Number(await Table.get(this.context, table, db).countRecords());
		}
		if (this.props.isCount && numRows > 1) {
			parts.nav_bar = '1';
			parts.sort_lnk = '1';
		}
		if ((parts.nav_bar === '1' || parts.sort_lnk === '1') && Number(unlimNumRows) < 2 && !await this.isView(table, db)) {
			parts.sort_lnk = '0';
		}
		return [parts, total];
	}

	private async tableNavigationButton(caption: string, title: string, pos: number, htmlSqlQuery: string, back: boolean, onsubmit = '', inputForRealEnd = ''): Promise<string> {
		const showIcons = ['icons', 'both'].includes(this.config.TableNavigationLinksMode);
		const showText = ['text', 'both'].includes(this.config.TableNavigationLinksMode);
		let captionOutput = '';
		if (back) {
			captionOutput += showIcons ? caption : '';
			captionOutput += showText ? `&nbsp;${title}` : '';
		} else {
			captionOutput += showText ? title : '';
			captionOutput += showIcons ? `&nbsp;${caption}` : '';
		}
		return renderTemplate('display/results/table_navigation_button', {
			db: this.db,
			table: this.table,
			sql_query: htmlSqlQuery,
			pos,
			is_browse_distinct: this.props.isBrowseDistinct,
			goto: this.goto,
			input_for_real_end: inputForRealEnd,
			caption_output: captionOutput,
			title,
			onsubmit,
		}, await this.state());
	}

	private isExactCount(): boolean {
		const maxRows = this.maxRows;
		return Number(this.props.unlimNumRows) < this.config.MaxExactCount || maxRows === ALL_ROWS || this.props.numRows < maxRows;
	}

	/** Results::getTableNavigation(). */
	private async tableNavigation(posNext: number, posPrevious: number, isInnodb: boolean, sortByKey: Record<string, unknown>): Promise<Record<string, unknown>> {
		const maxRows = this.maxRows;
		const isShowingAll = maxRows === ALL_ROWS;
		const htmlSqlQuery = htmlspecialchars(this.sqlQuery);
		const { unlimNumRows, numRows } = this.props;
		let backward = '';
		if (this.pos !== 0 && !isShowingAll) {
			backward = await this.tableNavigationButton('&lt;&lt;', 'Begin', 0, htmlSqlQuery, true)
				+ await this.tableNavigationButton('&lt;', 'Previous', posPrevious, htmlSqlQuery, true);
		}
		let selector = '';
		let totalPages = 1;
		if (!isShowingAll) {
			const pageNow = Math.floor(this.pos / maxRows) + 1;
			totalPages = Math.ceil(Math.trunc(Number(unlimNumRows)) / maxRows);
			if (totalPages > 1) {
				selector = await renderTemplate('display/results/page_selector', {
					url_params: { db: this.db, table: this.table, sql_query: this.sqlQuery, goto: this.goto, is_browse_distinct: this.props.isBrowseDistinct },
					page_selector: pageSelector('pos', maxRows, pageNow, totalPages),
				}, await this.state());
			}
		}
		let forward = '';
		const atEnd = unlimNumRows !== false && (isShowingAll
			|| (this.isExactCount() && this.pos + Number(maxRows) >= Number(unlimNumRows))
			|| numRows < Number(maxRows));
		if (!atEnd) {
			forward = await this.tableNavigationButton('&gt;', 'Next', posNext, htmlSqlQuery, false);
			if (unlimNumRows !== false) {
				let realEnd = '';
				if (isInnodb && unlimNumRows > this.config.MaxExactCount) {
					realEnd = '<input id="real_end_input" type="hidden" name="find_real_end" value="1">';
				}
				const rows = Math.trunc(Number(maxRows));
				const canMove = this.pos + rows < unlimNumRows && numRows >= rows;
				const onsubmit = `onsubmit="return ${canMove ? 'true' : 'false'}"`;
				const lastPos = (Math.ceil(Math.trunc(unlimNumRows) / Number(maxRows)) - 1) * rows;
				forward += await this.tableNavigationButton('&gt;&gt;', 'End', lastPos, htmlSqlQuery, false, onsubmit, realEnd);
			}
		}
		return {
			move_backward_buttons: backward,
			page_selector: selector,
			move_forward_buttons: forward,
			number_total_page: totalPages,
			has_show_all: this.config.ShowAll || Number(unlimNumRows) <= 500,
			hidden_fields: {
				db: this.db,
				table: this.table,
				server: this.server,
				sql_query: this.sqlQuery,
				is_browse_distinct: this.props.isBrowseDistinct,
				goto: this.goto,
			},
			session_max_rows: isShowingAll ? this.config.MaxRows : ALL_ROWS,
			is_showing_all: isShowingAll,
			max_rows: maxRows,
			pos: this.pos,
			sort_by_key: sortByKey,
		};
	}

	/** Results::getColumnParams(): the remembered column order and visibility for a single-table SELECT. */
	private async columnParams(analyzed: AnalyzedQuery): Promise<ColumnParams> {
		if (!this.isSelect(analyzed)) {
			return { order: false, visibility: false };
		}
		const table = Table.get(this.context, this.table, this.db);
		const fieldsCount = this.props.fieldsMeta.length;
		let order = await table.getUiProp(PROP_COLUMN_ORDER) as number[] | false;
		if (Array.isArray(order)) {
			if (order.some(value => value >= fieldsCount)) {
				table.removeUiProp(PROP_COLUMN_ORDER);
			}
			if (fieldsCount !== order.length) {
				table.removeUiProp(PROP_COLUMN_ORDER);
				order = false;
			}
		}
		let visibility = await table.getUiProp(PROP_COLUMN_VISIB) as unknown[] | false;
		if (Array.isArray(visibility) && fieldsCount !== visibility.length) {
			table.removeUiProp(PROP_COLUMN_VISIB);
			visibility = false;
		}
		return { order, visibility };
	}

	/** Results::getFullOrPartialTextButtonOrLink(). */
	private fullOrPartialTextLink(): string {
		const params: Record<string, unknown> = { db: this.db, table: this.table, sql_query: this.sqlQuery, goto: this.goto, full_text_button: 1 };
		let image = 's_fulltext.png';
		let text = 'Full texts';
		if (this.tmpval.pftext === DISPLAY_FULL_TEXT) {
			image = 's_partialtext.png';
			text = 'Partial texts';
			params.pftext = 'P';
		} else {
			params.pftext = DISPLAY_FULL_TEXT;
		}
		const { theme } = this.context;
		const src = themeImagePath(themeImageSet(theme), `./themes/${theme}/img/`, image);
		const img = `<img class="fulltext" src="${src}" alt="${text}" title="${text}">`;
		return linkOrButtonPlain(this.linkState(), this.route('/sql', params), img);
	}

	/** Results::getOptionsBlock(). */
	private optionsBlock(): Record<string, unknown> {
		const tmpval = this.tmpval;
		if (tmpval.possible_as_geometry !== undefined && !tmpval.possible_as_geometry && tmpval.geoOption === GEOMETRY_DISP_GEOM) {
			tmpval.geoOption = GEOMETRY_DISP_WKT;
		}
		return {
			geo_option: tmpval.geoOption,
			hide_transformation: tmpval.hide_transformation,
			display_blob: tmpval.display_blob,
			display_binary: tmpval.display_binary,
			relational_display: tmpval.relational_display,
			possible_as_geometry: tmpval.possible_as_geometry,
			pftext: tmpval.pftext,
		};
	}

	/** Results::getFieldVisibilityParams(): the opening of the header row. */
	private fieldVisibilityParams(parts: DisplayParts, fullOrPartialTextLink: string, colspan: string): string {
		let html = '<thead><tr>\n';
		const editAndDelete = parts.edit_lnk !== NO_EDIT_OR_DELETE && parts.del_lnk !== NO_EDIT_OR_DELETE;
		const rowActionLinks = this.config.RowActionLinks;
		const leftOrBoth = rowActionLinks === POSITION_LEFT || rowActionLinks === POSITION_BOTH;
		if (parts.edit_lnk === NO_EDIT_OR_DELETE && parts.del_lnk === NO_EDIT_OR_DELETE && parts.text_btn === '1') {
			this.displayParams.emptypre = editAndDelete ? 4 : 0;
		} else if (leftOrBoth && parts.text_btn === '1') {
			this.displayParams.emptypre = editAndDelete ? 4 : 0;
			html += `<th class="column_action position-sticky d-print-none"${colspan}>${fullOrPartialTextLink}</th>`;
		} else if (leftOrBoth && (parts.edit_lnk !== NO_EDIT_OR_DELETE || parts.del_lnk !== NO_EDIT_OR_DELETE)) {
			this.displayParams.emptypre = editAndDelete ? 4 : 0;
			html += `<td${colspan}></td>`;
		} else if (rowActionLinks === POSITION_NONE) {
			html += '<th class="column_action position-sticky"></th>';
		}
		return html;
	}

	/** Results::getColumnAtRightSide(). */
	private columnAtRightSide(parts: DisplayParts, fullOrPartialTextLink: string, colspan: string): string {
		const rowActionLinks = this.config.RowActionLinks;
		const anyLink = parts.edit_lnk !== NO_EDIT_OR_DELETE || parts.del_lnk !== NO_EDIT_OR_DELETE;
		const noLinks = parts.edit_lnk === NO_EDIT_OR_DELETE && parts.del_lnk === NO_EDIT_OR_DELETE;
		const emptyAfter = parts.edit_lnk !== NO_EDIT_OR_DELETE && parts.del_lnk !== NO_EDIT_OR_DELETE ? 4 : 1;
		if (rowActionLinks === POSITION_RIGHT || (rowActionLinks === POSITION_BOTH && anyLink && parts.text_btn === '1')) {
			this.displayParams.emptyafter = emptyAfter;
			return `\n<th class="column_action d-print-none"${colspan}>${fullOrPartialTextLink}</th>`;
		}
		if (rowActionLinks === POSITION_LEFT || (rowActionLinks === POSITION_BOTH && noLinks)) {
			this.displayParams.emptyafter = emptyAfter;
			return `\n<td class="d-print-none"${colspan}></td>`;
		}
		return '';
	}

	/** Results::getTableCommentsArray(). */
	private async tableComments(analyzed: AnalyzedQuery): Promise<Record<string, Record<string, string>>> {
		const statement = analyzed.statement as SelectStatement | undefined;
		if (!this.config.ShowBrowseComments || statement === undefined || !Array.isArray(statement.from) || statement.from.length === 0) {
			return {};
		}
		const comments: Record<string, Record<string, string>> = {};
		for (const field of statement.from) {
			if (isEmpty(field.table)) {
				continue;
			}
			const database = isEmpty(field.database) ? this.db : String(field.database);
			comments[String(field.table)] = await getComments(this.context, database, String(field.table));
		}
		return comments;
	}

	/** Results::getSortOrderHiddenInputs(). */
	private sortOrderHiddenInputs(multipleUrlParams: Record<string, unknown>, nameToUseInSort: string): string {
		const sqlQuery = String(multipleUrlParams.sql_query);
		loadParserContext(this.context);
		const first = new Parser(sqlQuery).statements[0];
		let removeQuery: string | null = null;
		let clausesFound: number | null = null;
		if (first instanceof SelectStatement) {
			const orders = (first.order ?? []).filter(order => order.expr?.column !== nameToUseInSort);
			first.order = orders;
			clausesFound = orders.length;
			removeQuery = first.build();
		}
		const removeSql = removeQuery ?? sqlQuery;
		const params = { ...multipleUrlParams, sql_query: removeSql, sql_signature: this.sign(removeSql) };
		let removeUrl = this.route('/sql', params);
		if (clausesFound === 0) {
			removeUrl += '&discard_remembered_sort=1';
		}
		const addParams = { ...multipleUrlParams, sql_query: sqlQuery, sql_signature: this.sign(sqlQuery) };
		const addUrl = this.route('/sql', addParams);
		return `<input type="hidden" name="url-remove-order" value="${removeUrl}">\n<input type="hidden" name="url-add-order" value="${addUrl}">`;
	}

	/** Results::getOrderLinkAndSortedHeaderHtml(). */
	private orderLinkAndSortedHeader(
		meta: FieldMetadata,
		sort: { expression: string[]; noDirection: string[]; direction: string[]; },
		analyzed: AnalyzedQuery,
		sessionMaxRows: unknown,
		comments: string,
		colVisib: unknown[] | false,
		colVisibElement: unknown,
	): HeaderColumn {
		const sortTable = meta.table !== '' && meta.orgname === meta.name ? `${backquote(meta.table)}.` : '';
		const [singleSortOrder, multiSortOrder, orderImg] = singleAndMultiSortUrls(sort.expression, sort.noDirection, sortTable, meta.name, sort.direction, meta, this.config.Order);
		const statement = analyzed.statement as SelectStatement;
		const list = analyzed.parser?.list;
		loadParserContext(this.context);
		const singleSorted = list === undefined ? '' : Query.replaceClause(statement, list, singleSortOrder);
		const multiSorted = list === undefined ? '' : Query.replaceClause(statement, list, multiSortOrder);
		const singleUrlParams = {
			db: this.db,
			table: this.table,
			sql_query: singleSorted,
			sql_signature: this.sign(singleSorted),
			session_max_rows: sessionMaxRows,
			is_browse_distinct: this.props.isBrowseDistinct,
		};
		const multiUrlParams = {
			db: this.db,
			table: this.table,
			sql_query: multiSorted,
			sql_signature: this.sign(multiSorted),
			session_max_rows: sessionMaxRows,
			is_browse_distinct: this.props.isBrowseDistinct,
		};
		const inner = `${htmlspecialchars(meta.name)}${orderImg}<input type="hidden" value="${this.route('/sql', multiUrlParams)}">`;
		let orderLink = linkOrButtonPlain(this.linkState(), this.route('/sql', singleUrlParams), inner, { class: 'sortlink' });
		orderLink += this.sortOrderHiddenInputs(multiUrlParams, meta.name);
		return {
			column_name: meta.name,
			order_link: orderLink,
			comments,
			is_browse_pointer_enabled: this.config.BrowsePointerEnable === true,
			is_browse_marker_enabled: this.config.BrowseMarkerEnable === true,
			is_column_hidden: Array.isArray(colVisib) && isEmpty(colVisibElement),
			is_column_numeric: isColumnNumeric(meta),
		};
	}

	/** Results::getTableHeadersForColumns(). */
	private async tableHeadersForColumnsHtml(parts: DisplayParts, analyzed: AnalyzedQuery, sort: { expression: string[]; noDirection: string[]; direction: string[]; }, isLimitedDisplay: boolean): Promise<string> {
		const sqlMd5 = md5(`${this.server}${this.db}${this.sqlQuery}`);
		const sessionMaxRows = isLimitedDisplay ? 0 : this.tmpval.query?.[sqlMd5]?.max_rows;
		const fieldsMeta = this.props.fieldsMeta;
		const commentsMap = await this.tableComments(analyzed);
		const { order, visibility } = await this.columnParams(analyzed);
		const isSortable = parts.sort_lnk === '1' && !isLimitedDisplay;
		const columns: HeaderColumn[] = [];
		for (let position = 0; position < fieldsMeta.length; position++) {
			const colVisibCurrent = Array.isArray(visibility) ? visibility[position] : undefined;
			const i = Array.isArray(order) ? order[position] : position;
			const meta = fieldsMeta[i];
			const conditionField = this.highlightColumns.has(meta.name) || this.highlightColumns.has(backquote(meta.name));
			const comments = commentForRow(commentsMap, meta.name, meta.table, this.config.LimitChars);
			if (isSortable) {
				const column = this.orderLinkAndSortedHeader(meta, sort, analyzed, sessionMaxRows, comments, visibility, colVisibCurrent);
				columns.push(column);
				this.displayParams.desc.push(`    <th class="draggable${conditionField ? ' condition' : ''}" data-column="${htmlspecialchars(meta.name)}">\n${column.order_link}${comments}    </th>\n`);
			} else {
				columns.push({
					column_name: meta.name,
					comments,
					is_column_hidden: Array.isArray(visibility) && isEmpty(colVisibCurrent),
					is_column_numeric: isColumnNumeric(meta),
					has_condition: conditionField,
				});
				this.displayParams.desc.push(`    <th class="draggable${conditionField ? ' condition"' : ''}" data-column="${htmlspecialchars(meta.name)}">        ${htmlspecialchars(meta.name)}${comments}    </th>`);
			}
		}
		return tableHeadersForColumns(isSortable, columns);
	}

	/** Results::getDataForResettingColumnOrder(). */
	private async dataForResettingColumnOrder(analyzed: AnalyzedQuery): Promise<Record<string, unknown>> {
		if (!this.isSelect(analyzed)) {
			return {};
		}
		const { order, visibility } = await this.columnParams(analyzed);
		const table = Table.get(this.context, this.table, this.db);
		const isView = await table.isView();
		let createTime: DbiValue | false = '';
		if (!isView) {
			createTime = await table.getStatusInfo('Create_time');
		}
		return { order, visibility, is_view: isView, table_create_time: createTime };
	}

	/** Results::getTableHeaders(). */
	private async tableHeaders(parts: DisplayParts, analyzed: AnalyzedQuery, sort: { expression: string[]; noDirection: string[]; direction: string[]; }, isLimitedDisplay: boolean): Promise<Record<string, unknown>> {
		const columnOrder = await this.dataForResettingColumnOrder(analyzed);
		this.displayParams = { emptypre: 0, emptyafter: 0, desc: [] };
		let options: Record<string, unknown> = {};
		let fullOrPartialTextLink = '';
		if (this.props.printView !== '1' && !isLimitedDisplay) {
			options = this.optionsBlock();
			fullOrPartialTextLink = this.fullOrPartialTextLink();
		}
		const colspan = parts.edit_lnk !== NO_EDIT_OR_DELETE && parts.del_lnk !== NO_EDIT_OR_DELETE ? ' colspan="4"' : '';
		const button = this.fieldVisibilityParams(parts, fullOrPartialTextLink, colspan);
		this.highlightColumns = new Set();
		const where = (analyzed.statement as SelectStatement | undefined)?.where;
		for (const expr of Array.isArray(where) ? where : []) {
			for (const identifier of expr.identifiers) {
				this.highlightColumns.add(String(identifier));
			}
		}
		const headersHtml = await this.tableHeadersForColumnsHtml(parts, analyzed, sort, isLimitedDisplay);
		let rightSide = '';
		if (isEmpty(this.props.printView)) {
			rightSide = this.columnAtRightSide(parts, fullOrPartialTextLink, colspan);
		}
		return {
			column_order: columnOrder,
			options,
			has_bulk_actions_form: parts.del_lnk === DELETE_ROW || parts.del_lnk === KILL_PROCESS,
			button,
			table_headers_for_columns: headersHtml,
			column_at_right_side: rightSide,
		};
	}

	/** Results::getSortByKeyDropDown(). */
	private async sortByKeyDropDown(sortExpression: string[], unsortedSqlQuery: string): Promise<Record<string, unknown>> {
		const indexes = await getIndexesFromTable(this.context, this.table, this.db);
		if (indexes.size === 0) {
			return {};
		}
		const hiddenFields: Record<string, unknown> = { db: this.db, table: this.table, server: this.server, sort_by_key: '1' };
		if (this.tmpval.max_rows !== undefined) {
			hiddenFields.session_max_rows = this.tmpval.max_rows;
		}
		const list = indexes.values().map((index): [string, string[]] => [index.getName(), index.getColumns().keys().toArray()]).toArray();
		return { hidden_fields: hiddenFields, options: sortByKeyOptions(list, sortExpression, unsortedSqlQuery) };
	}

	/** Results::getSortedColumnMessage(): " [column: FIRST... - LAST...]" for a sorted result. */
	private sortedColumnMessage(result: DbiResult, expression: string): string {
		if (isEmpty(expression)) {
			return '';
		}
		let sortTable = this.table;
		let sortColumn = expression;
		if (expression.includes('.')) {
			[sortTable, sortColumn] = expression.split('.', 2);
		}
		sortTable = unQuote(sortTable);
		sortColumn = unQuote(sortColumn);
		const fieldsMeta = this.props.fieldsMeta;
		const index = fieldsMeta.findIndex(meta => meta.table === sortTable && meta.name === sortColumn);
		if (index === -1) {
			return '';
		}
		const meta = fieldsMeta[index];
		const isNonPrintable = meta.isType(FieldType.BLOB) || meta.isMappedTypeGeometry || meta.isBinary;
		const valueOf = (row: DbiValue[] | null): string => {
			if (isNonPrintable) {
				return this.nonPrintableContents(meta.getMappedType(), row === null ? '' : row[index], null, meta, null).result;
			}
			return row === null ? '' : row[index] ?? '';
		};
		const shorten = (value: string): string => `${[...value].slice(0, Math.trunc(this.config.LimitChars)).join('')}...`.toUpperCase();
		const first = shorten(valueOf(result.fetchRow()));
		result.seek(this.props.numRows > 0 ? this.props.numRows - 1 : 0);
		const last = shorten(valueOf(result.fetchRow()));
		result.seek(0);
		return ` [${htmlspecialchars(sortColumn)}: <strong>${htmlspecialchars(first)} - ${htmlspecialchars(last)}</strong>]`;
	}

	/** Results::handleNonPrintableContents(). */
	private nonPrintableContents(category: string, contentInput: string | null, plugin: TransformationPlugin | null, meta: FieldMetadata, urlParams: Record<string, unknown> | null): { result: string; truncated: boolean; } {
		let truncated = false;
		let result = `[${category}`;
		let size = 0;
		const content = contentInput ?? '';
		// PHP sees bytes: binary columns already hold one char per byte, text columns are UTF-8.
		const bytes = meta.charsetnr === 63 ? content : Buffer.from(content, 'utf8').toString('latin1');
		if (contentInput === null) {
			result += ' - NULL';
		} else {
			size = bytes.length;
			const displaySize = formatByteDown(size, 3, 1);
			if (displaySize !== null) {
				result += ` - ${displaySize[0]} ${displaySize[1]}`;
			}
		}
		result += ']';
		if (plugin !== null && (plugin.mimeSubtype.indexOf('Octetstream') > 0 || plugin.mimeType.includes('Text'))) {
			result = content;
		}
		if (size <= 0) {
			return { result, truncated };
		}
		if (plugin !== null) {
			return { result: applyTransformation(plugin, result), truncated };
		}
		result = mimeDefaultFunction(result);
		const tmpval = this.tmpval;
		if ((tmpval.display_binary && meta.isType(FieldType.STRING)) || (tmpval.display_blob && meta.isType(FieldType.BLOB))) {
			const text = printableUtf8(bytes);
			result = text === null ? `0x${bin2hex(bytes)}` : htmlspecialchars(text);
			[truncated, result] = getPartialText(result, this.config.LimitChars, String(tmpval.pftext));
		}
		if (urlParams !== null && this.db !== '' && meta.orgtable !== '') {
			const params = { ...urlParams, where_clause_sign: this.sign(String(urlParams.where_clause)) };
			result = `<a href="${this.route('/table/get-field', params)}" class="disableAjax">${result}</a>`;
		}
		return { result, truncated };
	}

	/** Results::getFromForeign(). */
	private async fromForeign(relation: [string, string, string | false, string], whereComparison: string): Promise<string | null> {
		const sql = `SELECT ${backquote(relation[2])} FROM ${backquote(relation[3])}.${backquote(relation[0])} WHERE ${backquote(relation[1])}${whereComparison}`;
		const value = await this.context.dbi.fetchValue(sql);
		if (value === false) {
			return 'Link not found!';
		}
		if (value === null) {
			return null;
		}
		return getPartialText(value, this.config.LimitChars, String(this.tmpval.pftext))[1];
	}

	/** Results::getRowData(). */
	private async rowDataCell(
		classes: string,
		conditionField: boolean,
		analyzed: AnalyzedQuery,
		meta: FieldMetadata,
		map: RelationMap,
		data: string,
		displayedInput: string,
		plugin: TransformationPlugin | null,
		nowrap: string,
		whereComparison: string,
		isFieldTruncated = false,
		originalLength = '',
	): Promise<string> {
		let displayed = displayedInput;
		const relationalDisplay = this.tmpval.relational_display;
		const tdClass = addClass(classes, conditionField, meta, nowrap, isFieldTruncated, plugin !== null);
		const exprs = (analyzed.statement as SelectStatement | undefined)?.expr;
		for (const expr of Array.isArray(exprs) ? exprs : []) {
			const alias = (expr as { alias?: unknown; }).alias;
			const column = (expr as { column?: unknown; }).column;
			if (isEmpty(alias) || isEmpty(column)) {
				continue;
			}
			if (meta.name.toLowerCase() === String(alias).toLowerCase()) {
				meta.name = String(column);
			}
		}
		let value = '';
		const relation = map.get(meta.name);
		if (relation !== undefined) {
			let dispval: string | null = '';
			if (relation[2] !== '' && relation[2] !== false) {
				dispval = await this.fromForeign(relation, whereComparison);
			}
			if (this.props.printView === '1') {
				value += plugin === null ? mimeDefaultFunction(data) : applyTransformation(plugin, data);
				value += ` <code>[-&gt;${dispval ?? ''}]</code>`;
			} else {
				const sqlQuery = `SELECT * FROM ${backquote(relation[3])}.${backquote(relation[0])} WHERE ${backquote(relation[1])}${whereComparison}`;
				const urlParams = { db: relation[3], table: relation[0], pos: '0', sql_signature: this.sign(sqlQuery), sql_query: sqlQuery };
				if (plugin !== null) {
					displayed = applyTransformation(plugin, data);
				} else if (relationalDisplay === RELATIONAL_DISPLAY_COLUMN && relation[2] !== false && relation[2] !== '') {
					displayed = dispval === null ? '<em>NULL</em>' : mimeDefaultFunction(dispval);
				} else {
					displayed = mimeDefaultFunction(displayed);
				}
				const title = relationalDisplay === RELATIONAL_KEY ? dispval ?? '' : data;
				const tagParams: Record<string, unknown> = { title };
				if (classes.includes('grid_edit')) {
					tagParams.class = 'ajax';
				}
				value += linkOrButtonPlain(this.linkState(), this.route('/sql', urlParams), displayed, tagParams);
			}
		} else if (plugin === null) {
			value += mimeDefaultFunction(data);
		} else {
			value += applyTransformation(plugin, data);
		}
		return rowData(value, tdClass, meta, originalLength);
	}

	/** Results::getDataCellForNonNumericColumns(). */
	private async nonNumericCell(
		column: string | null,
		classesInput: string,
		meta: FieldMetadata,
		map: RelationMap,
		urlParams: Record<string, unknown>,
		conditionField: boolean,
		plugin: TransformationPlugin | null,
		analyzed: AnalyzedQuery,
	): Promise<string> {
		let classes = classesInput;
		const isTypeBlob = meta.isType(FieldType.BLOB);
		const protect = this.config.ProtectBinary;
		const nonTextPlugin = plugin !== null && !plugin.mimeType.includes('Text');
		if ((meta.isBinary && (protect === 'all' || (protect === 'noblob' && !isTypeBlob) || (protect === 'blob' && isTypeBlob))) || nonTextPlugin) {
			classes = classes.replace('grid_edit', '');
		}
		if (column === null) {
			return nullDisplay(classes, conditionField, meta);
		}
		if (column === '') {
			return emptyDisplay(classes, conditionField, meta);
		}
		let shown = column;
		let isFieldTruncated = false;
		let originalLength = 0;
		if ((plugin === null || !plugin.name.includes('Link')) && !meta.isBinary) {
			[isFieldTruncated, shown, originalLength] = getPartialText(column, this.config.LimitChars, String(this.tmpval.pftext));
		}
		if (meta.isBinary && !this.props.isAnalyse && !meta.isMappedTypeBit) {
			const category = meta.isType(FieldType.STRING) ? 'BINARY' : 'BLOB';
			const contents = this.nonPrintableContents(category, column, plugin, meta, urlParams);
			const tdClass = addClass(classes, conditionField, meta, '', contents.truncated, plugin !== null);
			let finalClass = tdClass;
			if (stripTags(shown).toLowerCase().includes(category.toLowerCase())) {
				finalClass = tdClass.replace('grid_edit', '');
			}
			return valueDisplay(finalClass, conditionField, contents.result);
		}
		const noWrap = plugin !== null && plugin.noWrap;
		const nowrap = meta.isDateTimeType() || noWrap ? 'text-nowrap' : 'pre_wrap';
		const whereComparison = ` = '${this.context.dbi.escapeString(column)}'`;
		return this.rowDataCell(classes, conditionField, analyzed, meta, map, shown, column, plugin, nowrap, whereComparison, isFieldTruncated, String(originalLength));
	}

	/** Results::getDataCellForGeometryColumns(). */
	private async geometryCell(
		column: string | null,
		classes: string,
		meta: FieldMetadata,
		map: RelationMap,
		urlParams: Record<string, unknown>,
		conditionField: boolean,
		plugin: TransformationPlugin | null,
		analyzed: AnalyzedQuery,
	): Promise<string> {
		if (column === null) {
			return nullDisplay(classes, conditionField, meta);
		}
		if (column === '') {
			return emptyDisplay(classes, conditionField, meta);
		}
		const tmpval = this.tmpval;
		if (tmpval.geoOption === GEOMETRY_DISP_GEOM) {
			return valueDisplay(classes, conditionField, this.nonPrintableContents('GEOMETRY', column, plugin, meta, urlParams).result);
		}
		const whereComparison = ` = ${column}`;
		if (tmpval.geoOption === GEOMETRY_DISP_WKT) {
			const wkt = await this.convertToWellKnownText(column);
			const [truncated, displayed] = getPartialText(wkt, this.config.LimitChars, String(tmpval.pftext));
			return this.rowDataCell(classes, conditionField, analyzed, meta, map, wkt, displayed, plugin, '', whereComparison, truncated);
		}
		if (tmpval.display_binary) {
			const wkb = bin2hex(column).slice(8);
			const [truncated, displayed] = getPartialText(wkb, this.config.LimitChars, String(tmpval.pftext));
			return this.rowDataCell(classes, conditionField, analyzed, meta, map, wkb, displayed, plugin, '', whereComparison, truncated);
		}
		return valueDisplay(classes, conditionField, this.nonPrintableContents('BINARY', column, plugin, meta, urlParams).result);
	}

	/** Gis::convertToWellKnownText(). */
	private async convertToWellKnownText(data: string): Promise<string> {
		const { dbi } = this.context;
		const hex = bin2hex(data);
		const asText = dbi.getVersion() >= 50600 ? 'ST_ASTEXT' : 'ASTEXT';
		const axisOrder = dbi.getVersion() >= 80001 && !dbi.isMariaDB() ? ', \'axis-order=long-lat\'' : '';
		const result = await dbi.tryQuery(`SELECT ${asText}(x'${hex}'${axisOrder})`);
		const row = result === false ? null : result.fetchRow();
		return row?.[0] ?? '';
	}

	/** Results::getRowValues(). */
	private async rowValues(row: DbiValue[], rowNumber: number, colOrder: number[] | false, map: RelationMap, gridEditClass: string, colVisib: unknown[] | false, urlSqlQuery: string, analyzed: AnalyzedQuery): Promise<string> {
		let html = '';
		const fieldsMeta = this.props.fieldsMeta;
		const rowClauses = this.whereClauseMap.get(rowNumber) ?? new Map<string, string>();
		this.whereClauseMap.set(rowNumber, rowClauses);
		const expressions = this.selectExpressions(analyzed);
		// Results::getRowInfoForSpecialLinks().
		const rowInfo: Record<string, DbiValue> = {};
		for (let position = 0; position < fieldsMeta.length; position++) {
			const index = Array.isArray(colOrder) ? colOrder[position] : position;
			rowInfo[fieldsMeta[index].orgname.toLowerCase()] = row[index];
		}
		for (let current = 0; current < fieldsMeta.length; current++) {
			const i = Array.isArray(colOrder) ? colOrder[current] : current;
			const meta = fieldsMeta[i];
			const notNull = meta.isNotNull ? 'not_null' : '';
			const relationClass = map.has(meta.name) ? 'relation' : '';
			const hideClass = Array.isArray(colVisib) && colVisib[current] !== undefined && isEmpty(colVisib[current]) ? 'hide' : '';
			const gridEdit = meta.orgtable === '' ? '' : gridEditClass;
			const fieldTypeClass = classForDateTimeRelatedFields(meta);
			const classes = ['data', gridEdit, notNull, relationClass, hideClass, fieldTypeClass].filter(item => item !== '').join(' ');
			const conditionField = this.highlightColumns.has(meta.name) || this.highlightColumns.has(backquote(meta.name));
			let plugin: TransformationPlugin | null = null;
			const value = row[i];
			if (value !== null && phpTrim(value) !== '' && !this.tmpval.hide_transformation) {
				const info = transformationFor(this.db, meta.orgtable, meta.orgname);
				if (info !== null) {
					plugin = info;
					meta.internalMediaType = info.mediaType;
					if (info.kind === 'sql' && this.config.CodemirrorEnable) {
						this.context.response.addScriptFiles(SQL_PLUGIN_SCRIPTS);
					}
				}
			}
			const special = specialSchemaLink(this.db, meta.orgtable, meta.orgname);
			if (special !== null) {
				const url = this.context.urlState();
				const pages = {
					database: `./${getScriptNameForOption(url, this.config.DefaultTabDatabase, 'database')}`,
					table: `./${getScriptNameForOption(url, this.config.DefaultTabTable, 'table')}`,
				};
				plugin = specialLinkPlugin(specialLinkUrl(special, value, rowInfo, pages, (params, divider) => getCommon(url, params, divider)));
				meta.internalMediaType = 'Text/Plain';
			}
			if (!rowClauses.has(meta.orgtable)) {
				const [where] = getUniqueCondition(fieldsMeta, row, { restrictToTable: meta.orgtable, expressions, isView: table => this.viewTables.get(table) ?? false, escapeString: text => this.context.dbi.escapeString(text) });
				rowClauses.set(meta.orgtable, where);
			}
			const whereClause = rowClauses.get(meta.orgtable) ?? '';
			const urlParams: Record<string, unknown> = {
				db: this.db,
				table: meta.orgtable,
				where_clause_sign: this.sign(whereClause),
				where_clause: whereClause,
				transform_key: meta.orgname,
			};
			if (this.sqlQuery !== '') {
				urlParams.sql_query = urlSqlQuery;
			}
			if (meta.isNumeric) {
				if (value === null) {
					html += nullDisplay(`text-end ${classes}`, conditionField, meta);
				} else if (value === '') {
					html += emptyDisplay(`text-end ${classes}`, conditionField, meta);
				} else {
					html += await this.rowDataCell(`text-end ${classes}`, conditionField, analyzed, meta, map, value, value, plugin, 'text-nowrap', ` = ${value}`);
				}
			} else if (meta.isMappedTypeGeometry) {
				html += await this.geometryCell(value, classes.replace('grid_edit', ''), meta, map, urlParams, conditionField, plugin, analyzed);
			} else {
				html += await this.nonNumericCell(value, classes, meta, map, urlParams, conditionField, plugin, analyzed);
			}
		}
		return html;
	}

	private selectExpressions(analyzed: AnalyzedQuery): { alias: string | null; column: string | null; }[] {
		const statement = analyzed.statement;
		if (!(statement instanceof SelectStatement)) {
			return [];
		}
		return statement.expr.map((expr) => {
			const item = expr as { alias?: unknown; column?: unknown; };
			return { alias: isEmpty(item.alias) ? null : String(item.alias), column: isEmpty(item.column) ? null : String(item.column) };
		});
	}

	/** Results::getUrlSqlQuery(): long SELECTs lose their conditions in row links. */
	private urlSqlQuery(analyzed: AnalyzedQuery): string {
		if (analyzed.querytype !== 'SELECT' || [...this.sqlQuery].length < 200 || analyzed.statement === undefined || analyzed.parser === undefined) {
			return this.sqlQuery;
		}
		loadParserContext(this.context);
		let query = `SELECT ${Query.getClause(analyzed.statement, analyzed.parser.list, 'SELECT')}`;
		const from = Query.getClause(analyzed.statement, analyzed.parser.list, 'FROM');
		if (from !== '') {
			query += ` FROM ${from}`;
		}
		return query;
	}

	/** Results::getActionLinkContent(). */
	private actionLinkContent(icon: string, text: string): string {
		if (this.config.RowActionType === 'icons') {
			return `<span class="text-nowrap">${getImage(icon, text)}</span>`;
		}
		if (this.config.RowActionType === 'text') {
			return `<span class="text-nowrap">${text}</span>`;
		}
		return getIcon(this.context, icon, text);
	}

	/** Results::getTableBody(). */
	private async tableBody(result: DbiResult, parts: DisplayParts, map: RelationMap, analyzed: AnalyzedQuery, isLimitedDisplay: boolean): Promise<string> {
		let html = '';
		const urlSqlQuery = this.urlSqlQuery(analyzed);
		let gridEditClass = '';
		if (!isLimitedDisplay && this.props.editable) {
			if (this.config.GridEditing === 'double-click') {
				gridEditClass = 'grid_edit click2';
			} else if (this.config.GridEditing === 'click') {
				gridEditClass = 'grid_edit click1';
			}
		}
		const { order, visibility } = await this.columnParams(analyzed);
		for (const meta of this.props.fieldsMeta) {
			if (meta.table !== meta.orgtable && !this.viewTables.has(meta.table)) {
				this.viewTables.set(meta.table, await this.isView(meta.table, this.context.db));
			}
		}
		const repeatCells = Number(this.tmpval.repeat_cells ?? 0);
		const rowActionLinks = this.config.RowActionLinks;
		const expressions = this.selectExpressions(analyzed);
		const linkState = this.linkState();
		const isAjax = this.context.response.isAjax;
		let rowNumber = 0;
		for (let row = result.fetchRow(); row !== null; row = result.fetchRow()) {
			if (rowNumber !== 0 && repeatCells > 0 && rowNumber % repeatCells === 0) {
				html += repeatingHeaders(this.displayParams.emptypre, this.displayParams.desc, this.displayParams.emptyafter, rowActionLinks);
			}
			const trClass: string[] = [];
			if (this.config.BrowsePointerEnable !== true) {
				trClass.push('nopointer');
			}
			if (this.config.BrowseMarkerEnable !== true) {
				trClass.push('nomarker');
			}
			html += `<tr${trClass.length === 0 ? '' : ` class="${trClass.join(' ')}"`}>`;
			const hasLinks = parts.edit_lnk !== NO_EDIT_OR_DELETE || parts.del_lnk !== NO_EDIT_OR_DELETE;
			let links: Parameters<typeof checkboxAndLinks>[1] | null = null;
			if (hasLinks) {
				const [whereClause, clauseIsUnique, conditionArray] = getUniqueCondition(this.props.fieldsMeta, row, {
					restrictToTable: this.table,
					expressions,
					isView: table => this.viewTables.get(table) ?? false,
					escapeString: text => this.context.dbi.escapeString(text),
				});
				const rowClauses = this.whereClauseMap.get(rowNumber) ?? new Map<string, string>();
				rowClauses.set(this.table, whereClause);
				this.whereClauseMap.set(rowNumber, rowClauses);
				let edit = { url: null as string | null, params: {} as Record<string, unknown>, string: null as string | null };
				let copy = { url: null as string | null, params: {} as Record<string, unknown>, string: null as string | null };
				if (parts.edit_lnk === UPDATE_ROW) {
					const params = {
						db: this.db,
						table: this.table,
						where_clause: whereClause,
						where_clause_signature: this.sign(whereClause),
						clause_is_unique: clauseIsUnique,
						sql_query: urlSqlQuery,
						sql_signature: this.sign(urlSqlQuery),
						goto: this.route('/sql'),
					};
					edit = { url: this.route('/table/change'), params, string: this.actionLinkContent('b_edit', 'Edit') };
					copy = { url: this.route('/table/change'), params, string: this.actionLinkContent('b_insrow', 'Copy') };
				}
				const del = await this.deleteAndKillLinks(whereClause, clauseIsUnique, urlSqlQuery, parts.del_lnk, row[0]);
				links = {
					position: POSITION_LEFT,
					hasCheckbox: del.url !== null && parts.del_lnk !== KILL_PROCESS,
					edit: { url: edit.url, params: { ...edit.params, default_action: 'update' }, string: edit.string, clauseIsUnique },
					copy: { url: copy.url, params: { ...copy.params, default_action: 'insert' }, string: copy.string },
					delete: { url: del.url, params: del.params, string: del.string },
					rowNumber,
					whereClause,
					condition: Object.keys(conditionArray).length === 0 ? '[]' : phpJsonEncode(conditionArray),
					isAjax,
					jsConf: del.jsConf ?? '',
				};
				if (rowActionLinks === POSITION_LEFT || rowActionLinks === POSITION_BOTH) {
					html += checkboxAndLinks(linkState, links);
				} else if (rowActionLinks === POSITION_NONE) {
					html += checkboxAndLinks(linkState, { ...links, position: POSITION_NONE });
				}
			}
			html += await this.rowValues(row, rowNumber, order, map, gridEditClass, visibility, urlSqlQuery, analyzed);
			if (hasLinks && links !== null && (rowActionLinks === POSITION_RIGHT || rowActionLinks === POSITION_BOTH)) {
				html += checkboxAndLinks(linkState, { ...links, position: POSITION_RIGHT });
			}
			html += '</tr>\n';
			rowNumber++;
		}
		return html;
	}

	/** Results::getDeleteAndKillLinks(). */
	private async deleteAndKillLinks(whereClause: string, clauseIsUnique: boolean, urlSqlQuery: string, deleteLink: string | null, processId: DbiValue): Promise<{ url: string | null; string: string | null; jsConf: string | null; params: Record<string, unknown> | null; }> {
		if (deleteLink === DELETE_ROW) {
			const gotoParams = {
				db: this.db,
				table: this.table,
				sql_query: urlSqlQuery,
				message_to_show: 'The row has been deleted.',
				goto: this.goto === '' ? this.route('/table/sql') : this.goto,
			};
			const limit = clauseIsUnique ? '' : ' LIMIT 1';
			const params = {
				db: this.db,
				table: this.table,
				sql_query: `DELETE FROM ${backquote(this.table)} WHERE ${whereClause}${limit}`,
				message_to_show: 'The row has been deleted.',
				goto: this.route('/sql', gotoParams),
			};
			return { url: this.route('/sql'), string: this.actionLinkContent('b_drop', 'Delete'), jsConf: `DELETE FROM ${this.table} WHERE ${whereClause}${limit}`, params };
		}
		if (deleteLink === KILL_PROCESS) {
			const gotoParams = { db: this.db, table: this.table, sql_query: urlSqlQuery, goto: this.route('/') };
			const kill = await this.killQuery(Math.trunc(Number(processId)) || 0);
			return { url: this.route('/sql'), string: getIcon(this.context, 'b_drop', 'Kill'), jsConf: kill, params: { db: 'mysql', sql_query: kill, goto: this.route('/sql', gotoParams) } };
		}
		return { url: null, string: null, jsConf: null, params: null };
	}

	/** DatabaseInterface::getKillQuery(). */
	private async killQuery(process: number): Promise<string> {
		const basedir = await this.context.dbi.fetchValue('SELECT @@basedir');
		if (typeof basedir === 'string' && basedir.startsWith('/rdsdbbin/')) {
			return `CALL mysql.rds_kill(${process});`;
		}
		return `KILL ${process};`;
	}

	/** Results::setParamForLinkForeignKeyRelatedTables(). */
	private async relationMap(): Promise<RelationMap> {
		const map: RelationMap = new Map();
		const foreigners = await getForeigners(this.context, this.db, this.table, 'both');
		for (const key of foreigners.foreign_keys_data ?? []) {
			for (const [index, field] of key.index_list.entries()) {
				const refDb = String(key.ref_db_name ?? this.context.db);
				const refTable = String(key.ref_table_name ?? '');
				const displayField = await getDisplayField(this.context, refDb, refTable);
				map.set(String(field), [refTable, String(key.ref_index_list?.[index] ?? ''), displayField, refDb]);
			}
		}
		for (const [field, [foreignDb, foreignTable, foreignField]] of Object.entries(internalRelations(this.db, this.table))) {
			map.set(field, [foreignTable, foreignField, await getDisplayField(this.context, foreignDb, foreignTable), foreignDb]);
		}
		return map;
	}

	/** Results::getBulkLinks(). */
	private bulkLinks(result: DbiResult, analyzed: AnalyzedQuery, deleteLink: string | null): Record<string, unknown> {
		if (deleteLink !== DELETE_ROW) {
			return {};
		}
		result.seek(this.props.numRows > 0 ? this.props.numRows - 1 : 0);
		const row = result.fetchRow() ?? [];
		const [, clauseIsUnique] = getUniqueCondition(this.props.fieldsMeta, row, {
			expressions: this.selectExpressions(analyzed),
			isView: table => this.viewTables.get(table) ?? false,
			escapeString: text => this.context.dbi.escapeString(text),
		});
		result.seek(0);
		return { has_export_button: analyzed.querytype === 'SELECT', clause_is_unique: clauseIsUnique };
	}

	/** Results::getResultsOperations(). */
	private async resultsOperations(printLink: string, analyzed: AnalyzedQuery): Promise<Record<string, unknown>> {
		const urlParams: Record<string, unknown> = { db: this.db, table: this.table, printview: '1', sql_query: this.sqlQuery };
		let geometryFound = false;
		if (analyzed.querytype === 'SELECT' && !analyzed.is_procedure) {
			const selectTables = analyzed.select_tables ?? [];
			if (selectTables.length === 1) {
				urlParams.single_table = 'true';
			} else if (selectTables.length === 0) {
				urlParams.raw_query = 'true';
			}
			urlParams.unlim_num_rows = this.props.unlimNumRows;
			if (urlParams.table === '' && urlParams.db !== '') {
				const first = await this.context.dbi.fetchValue('SHOW TABLES');
				urlParams.table = first === false || first === null ? '' : first;
			}
			geometryFound = this.props.fieldsMeta.some(meta => meta.isMappedTypeGeometry);
		}
		return {
			has_procedure: analyzed.is_procedure,
			has_geometry: geometryFound,
			has_print_link: printLink === '1',
			has_export_link: analyzed.querytype === 'SELECT',
			url_params: urlParams,
		};
	}

	setProperties(props: ResultsProperties): void {
		this.props = props;
	}

	/** Results::setConfigParamsForDisplayTable(). */
	setConfigParamsForDisplayTable(analyzed: AnalyzedQuery): void {
		const sqlMd5 = md5(`${this.server}${this.db}${this.sqlQuery}`);
		const { query: queryParams, post, params } = this.context.request;
		const tmpval = this.tmpval;
		const stored: QuerySettings | undefined = tmpval.query?.[sqlMd5];
		const sessionMaxRows = queryParams.session_max_rows ?? post.session_max_rows;
		const settings = querySettingsForDisplay(stored, { sessionMaxRows, request: params }, this.config, analyzed.is_explain);
		// The header's return_url is built from $_GET later, so it must not see the consumed value.
		if (isSessionMaxRowsUsed(sessionMaxRows)) {
			delete queryParams.session_max_rows;
			delete post.session_max_rows;
		}
		rememberQuerySettings(tmpval, sqlMd5, settings);
		applyDisplaySettings(tmpval, settings);
	}

	/** Results::getTable(). */
	async getTable(result: DbiResult, displayPartsInput: DisplayParts, analyzed: AnalyzedQuery, isLimitedDisplay = false): Promise<string> {
		const statement = analyzed.statement as SelectStatement | undefined;
		const fieldsMeta = this.props.fieldsMeta;
		const isInnodb = this.props.showTable?.Type === 'InnoDB';
		let preCount = '';
		let afterCount = '';
		const genState = generatorState(this.context);
		if (isInnodb && isJustBrowsing(analyzed, true)) {
			preCount = '~';
			afterCount = showHint(genState, sanitizeMessage(genState, 'May be approximate. See [doc@faq3-11]FAQ 3.11[/doc].'));
		}
		const [parts, total] = await this.setDisplayPartsAndTotal(displayPartsInput);
		let posNext = 0;
		let posPrev = 0;
		if (parts.nav_bar === '1') {
			[posNext, posPrev] = pageOffsets(this.pos, this.maxRows);
		}
		const sort = { expression: [] as string[], noDirection: [] as string[], direction: [] as string[] };
		const orders = statement?.order ?? null;
		if (Array.isArray(orders) && orders.length > 0) {
			for (const order of orders) {
				const expr = order.expr?.expr ?? '';
				sort.expression.push(`${expr} ${order.type}`);
				sort.noDirection.push(expr);
				sort.direction.push(order.type);
			}
		} else {
			sort.expression.push('');
			sort.noDirection.push('');
			sort.direction.push('');
		}
		let sortedColumnMessage = '';
		for (const expression of sort.noDirection) {
			sortedColumnMessage += this.sortedColumnMessage(result, expression);
		}

		let sqlQueryMessage = '';
		if (parts.nav_bar === '1') {
			let viewWarning: string | false = false;
			if (await this.isView(this.table, this.db) && total === this.config.MaxExactCountViews) {
				const notice = Message.notice('This view has at least this number of rows. Please refer to %sdocumentation%s.');
				notice.addParam('[doc@cfg_MaxExactCount]');
				notice.addParam('[/doc]');
				viewWarning = showHint(genState, notice.getMessage(genState));
			}
			const limit = statement?.limit ?? null;
			const message = positionMessage({
				limit: limit === null ? null : { offset: Number(limit.offset), rowCount: Number(limit.rowCount) },
				maxRows: this.maxRows,
				pos: this.pos,
				posNext,
				total,
				unlimNumRows: this.props.unlimNumRows,
				numRows: this.props.numRows,
				viewWarning,
				preCount,
				afterCount,
				queryTime: this.props.queryTime,
				sortedColumnMessage,
			});
			sqlQueryMessage = await getMessage(this.context, message, { sqlQuery: this.sqlQuery, type: 'success' });
		} else if (this.props.printView !== '1' && !isLimitedDisplay) {
			const message = Message.success('Your SQL query has been executed successfully.');
			if (this.props.queryTime > 0) {
				message.addText('(');
				const time = Message.notice('Query took %01.4f seconds.)');
				time.addParam(this.props.queryTime);
				message.addMessage(time, '');
			}
			sqlQueryMessage = await getMessage(this.context, message, { sqlQuery: this.sqlQuery, type: 'success' });
		}

		if (this.table === '' && analyzed.querytype === 'SELECT') {
			this.table = fieldsMeta[0]?.table ?? '';
		}
		let sortByKey: Record<string, unknown> = {};
		if (parts.sort_lnk === '1' && analyzed.statement !== undefined && analyzed.parser !== undefined) {
			loadParserContext(this.context);
			const unsorted = Query.replaceClause(analyzed.statement, analyzed.parser.list, 'ORDER BY', '');
			if (this.isSelect(analyzed)) {
				sortByKey = await this.sortByKeyDropDown(sort.expression, unsorted);
			}
		}
		let navigation: Record<string, unknown> = {};
		if (parts.nav_bar === '1' && statement !== undefined && isEmpty(statement.limit)) {
			navigation = await this.tableNavigation(posNext, posPrev, isInnodb, sortByKey);
		}
		let map: RelationMap = new Map();
		if (this.table !== '') {
			map = await this.relationMap();
			if (this.props.isBrowseDistinct && fieldsMeta[1] !== undefined) {
				map.set(fieldsMeta[1].name, [this.table, fieldsMeta[1].name, '', this.db]);
			}
		}
		const headers = await this.tableHeaders(parts, analyzed, sort, isLimitedDisplay);
		const body = await this.tableBody(result, parts, map, analyzed, isLimitedDisplay);
		const bulkLinks = this.bulkLinks(result, analyzed, parts.del_lnk);
		let operations: Record<string, unknown> = {};
		if (this.props.printView !== '1' && !isLimitedDisplay) {
			operations = await this.resultsOperations(parts.pview_lnk, analyzed);
		}
		return renderTemplate('display/results/table', {
			sql_query_message: sqlQueryMessage,
			navigation,
			headers,
			body,
			bulk_links: bulkLinks,
			operations,
			db: this.db,
			table: this.table,
			unique_id: this.uniqueId,
			sql_query: this.sqlQuery,
			goto: this.goto,
			unlim_num_rows: this.props.unlimNumRows,
			displaywork: false,
			relwork: false,
			save_cells_at_once: this.config.SaveCellsAtOnce,
			default_sliders_state: this.config.InitialSlidersState,
			text_dir: 'ltr',
		}, await this.state());
	}
}


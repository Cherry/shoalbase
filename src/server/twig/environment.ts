// Twing environment equivalent to phpMyAdmin 5.2.3's Template::getTwigEnvironment() and its Twig extensions.
import {
	type TwingCache,
	type TwingCallableArgument,
	type TwingEnvironment,
	createArrayLoader,
	createArrayNode,
	createEnvironment,
	createFilter,
	createFunction,
	createFunctionNode,
	createMarkup,
	createOperator,
	isAMarkup,
} from 'twing';

import { escapeBlockBodies } from './block-escaping.ts';
import { CAPTURE_MARKUP_FUNCTION, markCapturedSets } from './capture-markup.ts';
import { type SafeCalls, unwrapSafeCalls } from './safe-calls.ts';
import { type TemplateState, toGeneratorState } from './state.ts';
import { TRANS_FUNCTION, createTransTagHandler } from './trans-tag.ts';
import { type LinkState, linkOrButton, sortableTableHeader } from '../../lib/pma/generator.ts';
import { phpJsonEncode, phpJsonNumbers } from '../../lib/pma/json.ts';
import { listNavigatorVariables } from '../../lib/pma/list-navigator.ts';
import { linkToVarDocumentation } from '../../lib/pma/server/kbs.ts';
import { getGisFunctions } from '../../lib/pma/table-data/gis.ts';
import { getGisDataTypes } from '../../lib/pma/table-data/insert-edit.ts';
import {
	type DropdownConfig,
	type Foreigners,
	foreignDropdown,
	searchColumnInForeigners,
} from '../../lib/pma/table-data/relation.ts';
import {
	convertBitDefaultValue,
	extractColumnSpec,
	isForeignKeySupportedEngine,
	parseEnumSetValues,
} from '../../lib/pma/table-structure/column-spec.ts';
import { formatSql } from '../../lib/pma/table-structure/sql-format.ts';
import {
	type ServerKind,
	getSupportedDatatypesHtml,
	getSupportedDatatypesList,
	isUUIDSupported,
} from '../../lib/pma/table-structure/types.ts';
import { getDescription, getName } from '../../lib/pma/transformations.ts';
import {
	formatByteDown,
	formatNumber,
	localisedDate,
	timespanFormat,
} from '../../lib/pma/util.ts';
import {
	getDocumentationLink,
	getIcon,
	getImage,
	getMySQLDocuUrl,
	renderMessage,
	showDocumentationLink,
	showHint,
	showIcons,
	showMySQLDocumentation,
	showPhpDocumentation,
	showText,
	themeImagePath,
} from '../../lib/twig/html.ts';
import { translate } from '../../lib/twig/i18n.ts';
import { htmlspecialchars, phpConcat, phpString } from '../../lib/twig/php.ts';
import {
	backquote,
	escapeJsString,
	escapeMysqlWildcards,
	getJsValue,
	jsFormat,
	sanitizeMessage,
} from '../../lib/twig/sanitize.ts';
import {
	getCommon,
	getFromRoute,
	getHiddenFields,
	getHiddenInputs,
	linkUrl,
} from '../../lib/twig/url.ts';
import { fromTwigValue, toTwigContext, toTwigValue } from '../../lib/twig/values.ts';

/** [name] or [name, default], in PHP signature order. */
type ArgumentSpec = [string] | [string, unknown];
type Helper = (...args: never[]) => unknown;

function toAccepted(specs: ArgumentSpec[]): TwingCallableArgument[] {
	return specs.map((spec) => {
		if (spec.length === 1) {
			return { name: spec[0] };
		}
		return { name: spec[0], defaultValue: spec[1] };
	});
}

function unwrapArgument(value: unknown): unknown {
	if (isAMarkup(value)) {
		return value.content;
	}
	// PHP's |e gives a plain string, so escaped values nested in a hash must not reach helpers as Markup objects.
	if (value instanceof Map) {
		return Object.fromEntries([...value].map(([key, item]) => [String(key), unwrapArgument(item)]));
	}
	if (Array.isArray(value)) {
		return value.map(item => unwrapArgument(item));
	}
	return fromTwigValue(value);
}

// Helpers that still need a port (most need the database or a larger PHP subsystem); missing ports must fail loudly.
const unportedFunctions: [string, ArgumentSpec[], boolean][] = [
	['get_display_field', [['foreign_db'], ['foreign_table']], true],
	['get_foreign_data', [['foreigners'], ['field'], ['override_total'], ['foreign_filter'], ['foreign_limit'], ['get_total', false]], false],
	['get_tables', [['foreign_db'], ['tbl_storage_engine']], false],
	['table_get', [['table_name'], ['db_name']], false],
	['get_tracker_version', [['db_name'], ['table_name'], ['statement', null]], false],
];

export interface PmaEnvironmentOptions {
	/** Template sources by name; at runtime the values can be empty because ASTs come from the cache. */
	templates: Record<string, string>;
	state: TemplateState;
	cache?: TwingCache;
}

export function createPmaEnvironment({ templates, state, cache }: PmaEnvironmentOptions): TwingEnvironment {
	const safeCalls: SafeCalls = { html: new Set(), all: new Set([TRANS_FUNCTION]) };
	// Every freshly parsed AST passes through write(), the only hook that runs after Twing's escaper.
	const safeAnalysisCache: TwingCache = {
		write: async (key, ast) => {
			unwrapSafeCalls(ast, safeCalls);
			markCapturedSets(ast);
			await cache?.write(key, ast);
		},
		load: async (key) => {
			const ast = cache ? await cache.load(key) : null;
			if (ast !== null) {
				escapeBlockBodies(ast, safeCalls);
				markCapturedSets(ast);
			}
			return ast;
		},
		getTimestamp: async key => (cache ? cache.getTimestamp(key) : 0),
	};
	const env = createEnvironment(createArrayLoader(templates), {
		autoEscapingStrategy: 'html',
		cache: safeAnalysisCache,
	});
	const generator = toGeneratorState(state);

	const addFunction = (name: string, specs: ArgumentSpec[], helper: Helper, safe = false): void => {
		const callable = async (_context: unknown, ...args: unknown[]): Promise<unknown> => (helper as (...values: unknown[]) => unknown)(...args.map(arg => unwrapArgument(arg)));
		env.addFunction(createFunction(name, callable, toAccepted(specs)));
		if (safe) {
			safeCalls.html.add(name);
		}
	};
	const addFilter = (name: string, specs: ArgumentSpec[], helper: Helper, safe = false): void => {
		const callable = async (_context: unknown, ...args: unknown[]): Promise<unknown> => (helper as (...values: unknown[]) => unknown)(...args.map(arg => unwrapArgument(arg)));
		env.addFilter(createFilter(name, callable, toAccepted(specs)));
		if (safe) {
			safeCalls.html.add(name);
		}
	};
	// Re-registers a core filter with its arguments cast like PHP does, since Twing's versions throw on null.
	const castCoreFilter = (name: string, cast: (args: unknown[]) => unknown[]): void => {
		const core = env.filters.get(name);
		if (!core) {
			throw new Error(`Twing core filter "${name}" is missing`);
		}
		const callable = async (context: Parameters<typeof core.callable>[0], ...args: unknown[]): Promise<unknown> => core.callable(context, ...cast(args));
		env.addFilter(createFilter(name, callable, core.acceptedArguments, { is_variadic: core.isVariadic }));
	};

	// PHP-semantics fixes for Twing.
	env.registerEscapingStrategy(value => htmlspecialchars(value), 'html');
	env.addOperator(createOperator('~', 'BINARY', 40, ([left, right], line, column) => createFunctionNode('_php_concat', createArrayNode([{ value: left }, { value: right }], line, column), line, column), 'LEFT'));
	addFunction('_php_concat', [['left'], ['right']], phpConcat);
	// Twig's captured set value: '' or a Markup (see capture-markup.ts).
	env.addFunction(createFunction(CAPTURE_MARKUP_FUNCTION, async (_context, value: unknown) => (value === '' ? '' : createMarkup(phpString(value))), [{ name: 'value' }]));
	castCoreFilter('format', args => args.map(arg => phpString(arg)));
	for (const name of ['lower', 'upper', 'title', 'capitalize', 'replace']) {
		castCoreFilter(name, ([value, ...rest]) => [phpString(value), ...rest]);
	}
	// Twig's EscaperRuntime only passes Markup through when autoescaping; an explicit |e('js') escapes captured blocks too.
	for (const name of ['escape', 'e']) {
		castCoreFilter(name, ([value, ...rest]) => [isAMarkup(value) ? String(value) : value, ...rest]);
	}
	// Twig's capitalize lowercases the rest of the string, which Twing's word-based version does not.
	env.addFilter(createFilter('capitalize', async (_context, value: unknown) => {
		const characters = [...phpString(value)];
		return (characters[0] ?? '').toUpperCase() + characters.slice(1).join('').toLowerCase();
	}, []));
	env.addFilter(createFilter('raw', async (_context, value: unknown) => {
		if (value !== null && typeof value === 'object' && !isAMarkup(value)) {
			return value;
		}
		return createMarkup(phpString(value));
	}, []));
	// json_encode() flags, which Twing ignores: JSON_UNESCAPED_SLASHES (64) and JSON_PRETTY_PRINT (128); templates pass them as constant() variables.
	const coreJsonEncode = env.filters.get('json_encode');
	if (coreJsonEncode) {
		env.addFilter(createFilter('json_encode', async (context: Parameters<typeof coreJsonEncode.callable>[0], value: unknown, options: unknown) => {
			const flags = Number(options ?? 0);
			const encoded = String(await coreJsonEncode.callable(context, value));
			if (flags === 0) {
				return phpJsonNumbers(encoded);
			}
			const php = phpJsonEncode(JSON.parse(encoded), (flags & 128) !== 0);
			return (flags & 64) === 0 ? php : php.replaceAll(String.raw`\/`, '/');
		}, toAccepted([['options', 0]])));
	}

	// I18nExtension
	env.addTagHandler(createTransTagHandler());
	addFunction(TRANS_FUNCTION, [['message'], ['plural'], ['count'], ['context'], ['variables']], (
		message: unknown,
		plural: unknown,
		count: unknown,
		context: unknown,
		variables: Record<string, unknown>,
	) => translate({
		message: phpString(message),
		plural: plural === null ? null : phpString(plural),
		count,
		context: context === null ? null : phpString(context),
		variables,
	}, state.catalog));
	addFilter('trans', [], (message: unknown) => state.catalog.gettext(phpString(message), null));

	// AssetExtension, CoreExtension
	addFunction('image', [['filename', null], ['fallback', null]], (file: string | null, fallback: string | null) => themeImagePath(state.themeImages, state.themeImgPath, file, fallback));
	addFilter('link', [], (url: unknown) => linkUrl(phpString(url)));

	// MessageExtension: Message::notice()/error() decode BBCode, rawSuccess() does not.
	addFilter('notice', [], (text: unknown) => renderMessage('notice', sanitizeMessage(generator, text, false, true)), true);
	addFilter('error', [], (text: unknown) => renderMessage('error', sanitizeMessage(generator, text, false, true)), true);
	addFilter('raw_success', [], (text: unknown) => renderMessage('success', phpString(text)), true);

	// SanitizeExtension
	addFilter('escape_js_string', [], escapeJsString, true);
	addFilter('js_format', [['add_backquotes', true]], jsFormat, true);
	addFilter('sanitize', [['escape', false], ['safe', false]], (text: unknown, escape: boolean, safe: boolean) => sanitizeMessage(generator, text, escape, safe), true);
	addFunction('get_js_value', [['key'], ['value'], ['escape', true]], getJsValue, true);

	// UrlExtension
	addFunction('get_hidden_inputs', [['db', ''], ['table', ''], ['indent', 0], ['skip', []]], (db: unknown, table: unknown, _indent: unknown, skip: string | string[]) => getHiddenInputs(state.url, db, table, skip), true);
	addFunction('get_hidden_fields', [['values'], ['pre', ''], ['is_token', false]], (values: Record<string, unknown>, prefix: string, isToken: boolean) => getHiddenFields(state.url, values, prefix, isToken), true);
	for (const name of ['get_common', 'get_common_raw']) {
		addFunction(name, [['params', {}], ['divider', '?'], ['encrypt', true]], (params: Record<string, unknown>, divider: string) => getCommon(state.url, params, divider), true);
	}
	addFunction('url', [['route'], ['params', {}], ['encrypt', true]], (route: string, params: Record<string, unknown>) => getFromRoute(state.url, route, params), true);

	// UtilExtension
	addFunction('backquote', [['identifier']], backquote);
	addFunction('get_icon', [['icon'], ['alternate', ''], ['force_text', false], ['menu_icon', false], ['control_param', 'ActionLinksMode']], (
		icon: string,
		alternate: unknown,
		forceText: boolean,
		menuIcon: boolean,
		controlParam: string,
	) => getIcon(generator, icon, alternate, forceText, menuIcon, controlParam), true);
	addFunction('get_image', [['image'], ['alternate', ''], ['attributes', {}]], getImage, true);
	addFunction('show_docu', [['page'], ['anchor', ''], ['bbcode', false]], (page: string, anchor: string, bbcode: boolean) => showDocumentationLink(generator, getDocumentationLink(generator, page, anchor), 'documentation', bbcode), true);
	addFunction('get_docu_link', [['page'], ['anchor', ''], ['path_prefix', './']], (page: string, anchor: string, prefix: string) => getDocumentationLink(generator, page, anchor, prefix), true);
	addFunction('show_mysql_docu', [['link'], ['big_icon', false], ['url', null], ['text', null], ['anchor', '']], (
		link: string,
		bigIcon: boolean,
		url: string | null,
		text: string | null,
		anchor: string,
	) => showMySQLDocumentation(generator, link, bigIcon, url, text, anchor), true);
	addFunction('get_mysql_docu_url', [['link'], ['anchor', '']], (link: string, anchor: string) => getMySQLDocuUrl(generator, link, anchor), true);
	addFunction('get_docu_url', [['is_mariadb', false]], (isMariaDB: boolean) => {
		if (isMariaDB) {
			return linkUrl('https://mariadb.com/kb/en/documentation/');
		}
		return getMySQLDocuUrl(generator, '');
	}, true);
	addFunction('show_php_docu', [['target']], (target: string) => showPhpDocumentation(generator, target, state.url.lang), true);
	addFunction('show_hint', [['message']], (message: unknown) => showHint(generator, message), true);
	addFunction('show_icons', [['value']], (key: string) => showIcons(generator, key));
	addFunction('show_text', [['value']], (key: string) => showText(generator, key));
	const linkState = (): LinkState => {
		return { url: state.url, linkLengthLimit: Number(state.config.LinkLengthLimit ?? 1000) };
	};
	addFunction('link_or_button', [['url'], ['url_params'], ['message'], ['tag_params', []], ['target', '']], (
		url: string,
		urlParams: Record<string, unknown> | null,
		message: string,
		tagParams: Record<string, unknown> | string,
		target: string,
	) => linkOrButton(linkState(), url, urlParams, message, Array.isArray(tagParams) ? {} : tagParams, target), true);
	addFunction('sortable_table_header', [['title'], ['sort'], ['initial_sort_order', 'ASC']], (title: string, sort: string, order: string) => sortableTableHeader(linkState(), state.request ?? {}, title, sort, order), true);
	addFunction('format_byte_down', [['value'], ['limes', 6], ['comma', 0]], formatByteDown);
	addFunction('format_number', [['value'], ['digits_left', 3], ['digits_right', 0], ['only_down', false], ['no_trailing_zero', true]], formatNumber);
	addFunction('localised_date', [['timestamp', -1], ['format', '']], (timestamp: number | string, format: string) => localisedDate(Number(timestamp), format));
	addFunction('timespan_format', [['seconds']], (seconds: number | string) => timespanFormat(Number(seconds)));
	// TransformationsExtension
	addFunction('get_description', [['file']], getDescription);
	addFunction('get_name', [['file']], getName);
	addFunction('link_to_var_documentation', [['name'], ['use_mariadb', false], ['text', null]], (name: string, useMariaDB: boolean, text: string | null) => linkToVarDocumentation(generator, name, useMariaDB, text), true);
	addFunction('get_list_navigator', [['count'], ['pos'], ['params'], ['script'], ['frame'], ['max_count'], ['name', 'pos'], ['classes', []]], (
		count: number | string,
		pos: number | string,
		urlParams: Record<string, unknown>,
		script: string,
		frame: string,
		maxCount: unknown,
		name: string,
		classes: string[],
	) => env.render('list_navigator.twig', toTwigContext(listNavigatorVariables({ count: Number(count), pos: Number(pos), urlParams, script, frame, maxCount, name, classes }))), true);
	addFilter('escape_mysql_wildcards', [], escapeMysqlWildcards);
	// FlashMessagesExtension: the messages the controller's FlashMessages took from the session.
	addFunction('flash', [], () => toTwigValue(state.flashMessages ?? {}));
	addFilter('convert_bit_default_value', [], convertBitDefaultValue);
	// UtilExtension's column type helpers.
	const serverKind = (): ServerKind => {
		return { type: state.serverType ?? 'MySQL', version: state.mysqlVersion };
	};
	addFunction('get_supported_datatypes', [['html', false], ['selected', '']], (html: boolean, selected: string) => {
		if (html) {
			return getSupportedDatatypesHtml(serverKind(), phpString(selected));
		}
		return getSupportedDatatypesList(serverKind());
	}, true);
	addFunction('format_sql', [['sql_query'], ['truncate', false]], (sqlQuery: unknown, truncate: boolean) => formatSql(phpString(sqlQuery), truncate, Number(state.config.MaxCharactersInDisplayedSQL ?? 1000)), true);
	addFunction('is_uuid_supported', [], () => isUUIDSupported(serverKind()));
	addFunction('extract_column_spec', [['column_spec']], (spec: string) => extractColumnSpec(phpString(spec), Number(state.config.LimitChars ?? 50)));
	addFunction('parse_enum_set_values', [['definition'], ['escape_html', true]], (definition: string, escapeHtml: boolean) => parseEnumSetValues(phpString(definition), escapeHtml));
	// NDB, whose answer needs the server's NDB version, is not available to customers.
	addFunction('is_foreign_key_supported', [['engine']], (engine: string) => isForeignKeySupportedEngine(phpString(engine)));

	// RelationExtension and GisExtension helpers that need no database.
	const dropdownConfig = (): DropdownConfig => {
		return {
			NaturalOrder: state.config.NaturalOrder !== false,
			LimitChars: Number(state.config.LimitChars ?? 50),
			ForeignKeyMaxLimit: Number(state.config.ForeignKeyMaxLimit ?? 100),
			ForeignKeyDropdownOrder: state.config.ForeignKeyDropdownOrder,
		};
	};
	addFunction('foreign_dropdown', [['disp_row'], ['foreign_field'], ['foreign_display'], ['data'], ['max', 100]], (
		dispRow: Record<string, string | null>[],
		foreignField: string,
		foreignDisplay: string,
		data: unknown,
		max: number | null,
	) => foreignDropdown(Object.values(dispRow ?? {}), phpString(foreignField), phpString(foreignDisplay), data, dropdownConfig(), max === null ? null : Number(max)), true);
	addFunction('search_column_in_foreigners', [['foreigners'], ['column']], (foreigners: Foreigners, column: string) => toTwigValue(searchColumnInForeigners(foreigners ?? {}, phpString(column), phpString(state.request?.db))));
	addFunction('get_gis_datatypes', [['upper_case', false]], (upperCase: boolean) => getGisDataTypes(upperCase));
	addFunction('get_gis_functions', [['geom_type', null], ['binary', true], ['display', false]], (geomType: string | null, binary: boolean, display: boolean) => new Map(getGisFunctions(geomType, binary, display, state.mysqlVersion).map(([key, value]) => [key, new Map(Object.entries(value))])));

	for (const [name, specs, safe] of unportedFunctions) {
		addFunction(name, specs, (...args: never[]) => {
			// A controller may supply a request-bound implementation of a database-backed helper.
			const override = state.functionOverrides?.[name];
			if (override !== undefined) {
				return override(...args as unknown[]);
			}
			throw new Error(`${name} is not implemented yet`);
		}, safe);
	}

	return env;
}

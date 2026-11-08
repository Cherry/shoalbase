// The browser transformations Display\Results applies without pmadb: SQL highlighting and links for system tables.
import specialSchemaLinks from './special-schema-links.json' with { type: 'json' };
import { htmlspecialchars } from '../../twig/php.ts';

export interface TransformationPlugin {
	/** TransformationsPlugin::getName(). */
	name: string;
	/** getMIMEType() and getMIMESubtype(). */
	mimeType: string;
	mimeSubtype: string;
	/** The internalMediaType it gives the column, such as "Text/Plain". */
	mediaType: string;
	/** applyTransformationNoWrap(). */
	noWrap: boolean;
	kind: 'sql' | 'link' | 'special';
	/** The prepared link of a special schema column. */
	url?: string;
}

const sqlPlugin: TransformationPlugin = { name: 'SQL', mimeType: 'Text', mimeSubtype: 'Plain', mediaType: 'Text/Plain', noWrap: false, kind: 'sql' };
const blobSqlPlugin: TransformationPlugin = { name: 'SQL', mimeType: 'Text', mimeSubtype: 'Octetstream', mediaType: 'Text/Octetstream', noWrap: false, kind: 'sql' };
const linkPlugin: TransformationPlugin = { name: 'TextLink', mimeType: 'Text', mimeSubtype: 'Plain', mediaType: 'Text/Plain', noWrap: false, kind: 'link' };

/** Results::setDefaultTransformations() without the pmadb tables: [db][table][column] in lower case. */
const DEFAULT_TRANSFORMATIONS: Record<string, Record<string, Record<string, TransformationPlugin>>> = {
	information_schema: {
		events: { event_definition: sqlPlugin },
		processlist: { info: sqlPlugin },
		routines: { routine_definition: sqlPlugin },
		triggers: { action_statement: sqlPlugin },
		views: { view_definition: sqlPlugin },
	},
	mysql: {
		event: { body: blobSqlPlugin, body_utf8: blobSqlPlugin },
		general_log: { argument: sqlPlugin },
		help_category: { url: linkPlugin },
		help_topic: { example: sqlPlugin, url: linkPlugin },
		proc: { param_list: blobSqlPlugin, returns: blobSqlPlugin, body: blobSqlPlugin, body_utf8: blobSqlPlugin },
		slow_log: { sql_text: sqlPlugin },
	},
};

/** The default transformation of a result column, found by the current database and the column's original table and name. */
export function transformationFor(db: string, orgTable: string, orgName: string): TransformationPlugin | null {
	return DEFAULT_TRANSFORMATIONS[db.toLowerCase()]?.[orgTable.toLowerCase()]?.[orgName.toLowerCase()] ?? null;
}

/** Generator::formatSql() without truncation. */
export function formatSql(sqlQuery: string): string {
	const escaped = sqlQuery.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;');
	return `<code class="sql" dir="ltr"><pre>\n${escaped}\n</pre></code>`;
}

/** Sanitize::checkLink($url, true, true). */
function isAllowedLink(url: string): boolean {
	const lower = url.toLowerCase();
	return ['https://', './url.php?url=https%3a%2f%2f', './doc/html/', './index.php?', 'mailto:', 'ftp://', 'http://'].some(start => lower.startsWith(start));
}

/** TransformationsPlugin::applyTransformation() with the default options, as the browse grid calls it. */
export function applyTransformation(plugin: TransformationPlugin, buffer: string): string {
	if (plugin.kind === 'sql') {
		return formatSql(buffer);
	}
	const url = plugin.kind === 'special' ? plugin.url ?? '' : buffer;
	if (!isAllowedLink(url)) {
		return htmlspecialchars(url);
	}
	return `<a href="${htmlspecialchars(url)}" title="" target="_blank" rel="noopener noreferrer">${htmlspecialchars(buffer)}</a>`;
}

/** The Text_Plain_Link plugin Display\Results sets up for a special schema column. */
export function specialLinkPlugin(url: string): TransformationPlugin {
	return { ...linkPlugin, kind: 'special', url };
}

/** The scripts SQLTransformationsPlugin's constructor adds when CodeMirror is enabled. */
export const SQL_PLUGIN_SCRIPTS = ['vendor/codemirror/lib/codemirror.js', 'vendor/codemirror/mode/sql/sql.js', 'vendor/codemirror/addon/runmode/runmode.js', 'functions.js'];

export interface SpecialSchemaLink {
	link_param: string;
	link_dependancy_params?: { param_info: string; column_name: string; }[];
	default_page: string;
}

/** Config\SpecialSchemaLinks::get() for one column; "@database@" and "@table@" stand for the DefaultTab* pages. */
export function specialSchemaLink(db: string, table: string, column: string): SpecialSchemaLink | null {
	const links = specialSchemaLinks as Record<string, Record<string, Record<string, SpecialSchemaLink>>>;
	return links[db.toLowerCase()]?.[table.toLowerCase()]?.[column.toLowerCase()] ?? null;
}

/**
 * Results::getSpecialLinkUrl(): the link's page with the column value and the values of the columns it depends on.
 * `common` is Url::getCommonRaw() and `pages` resolves the DefaultTab* placeholders.
 */
export function specialLinkUrl(
	link: SpecialSchemaLink,
	columnValue: string | null,
	rowInfo: Record<string, string | null>,
	pages: { database: string; table: string; },
	common: (params: Record<string, unknown>, divider: string) => string,
): string {
	let page = link.default_page;
	if (page === '@database@') {
		page = pages.database;
	} else if (page === '@table@') {
		page = pages.table;
	}
	const params: Record<string, unknown> = { [link.link_param]: columnValue };
	for (const dependency of link.link_dependancy_params ?? []) {
		const name = dependency.column_name.toLowerCase();
		if (rowInfo[name] !== undefined && rowInfo[name] !== null) {
			params[dependency.param_info] = rowInfo[name];
		}
	}
	return page + common(params, page.indexOf('?') > 0 ? '&' : '?');
}


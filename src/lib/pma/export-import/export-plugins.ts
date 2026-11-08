// The setProperties() of each Plugins\Export\Export* class: format names, file types and their option trees.
import {
	OptionsGroup,
	OptionsItem,
	type PluginInfo,
	type PluginProperties,
} from './properties.ts';
import { strcasecmp } from '../php-compare.ts';
import { sprintf } from '../sprintf.ts';

/** $plugin_param plus the request and table facts some plugins read while building their options. */
export interface ExportPluginParam {
	exportType: string;
	singleTable: boolean;
	/** isset($_REQUEST['raw_query']). */
	rawQuery: boolean;
	/** Whether $GLOBALS['table'] is a view, for the SQL plugin's DROP option label. */
	isView: boolean;
	/** ExportXml::isAvailable() needs a current database. */
	db: string;
}

/** DatabaseInterface::getCompatibilities(). */
export const SQL_COMPATIBILITIES = ['NONE', 'ANSI', 'DB2', 'MAXDB', 'MYSQL323', 'MYSQL40', 'MSSQL', 'ORACLE', 'TRADITIONAL'];

/** ExportCodegen's handlers, by the codegen_format index. */
export const CODEGEN_FORMATS = ['NHibernate C# DO', 'NHibernate XML'];

const STRUCTURE_OR_DATA: [string, string][] = [['structure', 'structure'], ['data', 'data'], ['structure_and_data', 'structure and data']];

function properties(text: string, extension: string, mimeType: string, options: OptionsGroup | null, forceFile = false): PluginProperties {
	return { text, extension, mimeType, forceFile, options };
}

const bool = (name: string, text: string): OptionsItem => new OptionsItem('bool', name, text);
const textItem = (name: string, text: string): OptionsItem => new OptionsItem('text', name, text);
const hidden = (name: string): OptionsItem => new OptionsItem('hidden', name);
const root = (): OptionsGroup => new OptionsGroup('root', 'Format Specific Options');
const main = (name: string, text: string | null = null): OptionsGroup => new OptionsGroup('main', name, text);
const structureOrData = (): OptionsItem => new OptionsItem('radio', 'structure_or_data').setValues(STRUCTURE_OR_DATA);

function hidesStructure(param: ExportPluginParam): boolean {
	return param.exportType === 'table' && !param.singleTable;
}

function codegen(): PluginProperties {
	const general = main('general_opts')
		.add(hidden('structure_or_data'))
		.add(new OptionsItem('select', 'format', 'Format:').setValues(CODEGEN_FORMATS.map((label, index) => [index, label])));
	return properties('CodeGen', 'cs', 'text/cs', root().add(general));
}

function csv(): PluginProperties {
	const general = main('general_opts')
		.add(textItem('separator', 'Columns separated with:'))
		.add(textItem('enclosed', 'Columns enclosed with:'))
		.add(textItem('escaped', 'Columns escaped with:'))
		.add(textItem('terminated', 'Lines terminated with:'))
		.add(textItem('null', 'Replace NULL with:'))
		.add(bool('removeCRLF', 'Remove carriage return/line feed characters within columns'))
		.add(bool('columns', 'Put columns names in the first row'))
		.add(hidden('structure_or_data'));
	return properties('CSV', 'csv', 'text/comma-separated-values', root().add(general));
}

function excel(): PluginProperties {
	const edition = new OptionsItem('select', 'edition', 'Excel edition:').setValues([
		['win', 'Windows'],
		['mac_excel2003', 'Excel 2003 / Macintosh'],
		['mac_excel2008', 'Excel 2008 / Macintosh'],
	]);
	const general = main('general_opts')
		.add(textItem('null', 'Replace NULL with:'))
		.add(bool('removeCRLF', 'Remove carriage return/line feed characters within columns'))
		.add(bool('columns', 'Put columns names in the first row'))
		.add(edition)
		.add(hidden('structure_or_data'));
	return properties('CSV for MS Excel', 'csv', 'text/comma-separated-values', root().add(general));
}

function htmlword(): PluginProperties {
	const data = main('dump_what', 'Data dump options').setForce('structure')
		.add(textItem('null', 'Replace NULL with:'))
		.add(bool('columns', 'Put columns names in the first row'));
	const options = root().add(main('dump_what', 'Dump table').add(structureOrData())).add(data);
	return properties('Microsoft Word 2000', 'doc', 'application/vnd.ms-word', options, true);
}

function json(): PluginProperties {
	const general = main('general_opts')
		.add(hidden('structure_or_data'))
		.add(bool('pretty_print', 'Output pretty-printed JSON (Use human-readable formatting)'))
		.add(bool('unicode', 'Output unicode characters unescaped'));
	return properties('JSON', 'json', 'text/plain', root().add(general));
}

function latex(param: ExportPluginParam): PluginProperties {
	const options = root()
		.add(main('general_opts').add(bool('caption', 'Include table caption')))
		.add(main('dump_what', 'Dump table').add(structureOrData()));
	if (!hidesStructure(param)) {
		// No relation or media type options: they need the phpMyAdmin configuration storage.
		options.add(main('structure', 'Object creation options').setForce('data')
			.add(textItem('structure_caption', 'Table caption:'))
			.add(textItem('structure_continued_caption', 'Table caption (continued):'))
			.add(textItem('structure_label', 'Label key:'))
			.add(bool('comments', 'Display comments')));
	}
	options.add(main('data', 'Data dump options').setForce('structure')
		.add(bool('columns', 'Put columns names in the first row:'))
		.add(textItem('data_caption', 'Table caption:'))
		.add(textItem('data_continued_caption', 'Table caption (continued):'))
		.add(textItem('data_label', 'Label key:'))
		.add(textItem('null', 'Replace NULL with:')));
	return properties('LaTeX', 'tex', 'application/x-tex', options);
}

function mediawiki(): PluginProperties {
	const general = main('general_opts', 'Dump table')
		.add(new OptionsGroup('subgroup', 'dump_table', 'Dump table').setHeader(structureOrData()))
		.add(bool('caption', 'Export table names'))
		.add(bool('headers', 'Export table headers'));
	return properties('MediaWiki Table', 'mediawiki', 'text/plain', root().add(general));
}

function ods(): PluginProperties {
	const general = main('general_opts')
		.add(textItem('null', 'Replace NULL with:'))
		.add(bool('columns', 'Put columns names in the first row'))
		.add(hidden('structure_or_data'));
	return properties('OpenDocument Spreadsheet', 'ods', 'application/vnd.oasis.opendocument.spreadsheet', root().add(general), true);
}

function odt(param: ExportPluginParam): PluginProperties {
	const options = root().add(main('general_opts', 'Dump table').add(structureOrData()));
	if (!hidesStructure(param)) {
		options.add(main('structure', 'Object creation options').setForce('data').add(bool('comments', 'Display comments')));
	}
	options.add(main('data', 'Data dump options').setForce('structure')
		.add(bool('columns', 'Put columns names in the first row'))
		.add(textItem('null', 'Replace NULL with:')));
	return properties('OpenDocument Text', 'odt', 'application/vnd.oasis.opendocument.text', options, true);
}

function pdf(): PluginProperties {
	const options = root()
		.add(main('general_opts').add(textItem('report_title', 'Report title:')))
		.add(main('dump_what', 'Dump table').add(structureOrData()));
	return properties('PDF', 'pdf', 'application/pdf', options, true);
}

function phparray(): PluginProperties {
	return properties('PHP array', 'php', 'text/plain', root().add(main('general_opts').add(hidden('structure_or_data'))));
}

function sqlStructureOptions(param: ExportPluginParam): OptionsGroup {
	const statements = new OptionsGroup('subgroup').setHeader(new OptionsItem('message', 'add_statements', 'Add statements:'));
	if (param.exportType === 'server') {
		statements.add(bool('drop_database', sprintf('Add %s statement', '<code>DROP DATABASE IF EXISTS</code>')));
	} else if (param.exportType === 'database') {
		statements.add(bool('create_database', sprintf('Add %s statement', '<code>CREATE DATABASE / USE</code>')));
	}
	let dropClause = '<code>DROP TABLE / VIEW / PROCEDURE / FUNCTION / EVENT</code>';
	if (param.exportType === 'table') {
		dropClause = param.isView ? '<code>DROP VIEW</code>' : '<code>DROP TABLE</code>';
	}
	statements.add(bool('drop_table', sprintf('Add %s statement', `${dropClause}<code> / TRIGGER</code>`)));
	statements.add(new OptionsGroup('subgroup')
		.setHeader(bool('create_table', sprintf('Add %s statement', '<code>CREATE TABLE</code>')))
		.add(bool('if_not_exists', '<code>IF NOT EXISTS</code> (less efficient as indexes will be generated during table creation)'))
		.add(bool('auto_increment', sprintf('%s value', '<code>AUTO_INCREMENT</code>'))));
	statements.add(new OptionsGroup('subgroup')
		.setHeader(bool('create_view', sprintf('Add %s statement', '<code>CREATE VIEW</code>')))
		.add(bool('simple_view_export', 'Use simple view export'))
		.add(bool('view_current_user', 'Exclude definition of current user'))
		.add(bool('or_replace_view', sprintf('%s view', '<code>OR REPLACE</code>'))));
	statements.add(bool('procedure_function', sprintf('Add %s statement', '<code>CREATE PROCEDURE / FUNCTION / EVENT</code>')));
	statements.add(bool('create_trigger', sprintf('Add %s statement', '<code>CREATE TRIGGER</code>')));
	return main('structure', 'Object creation options').setForce('data')
		.add(statements)
		.add(bool('backquotes', 'Enclose table and column names with backquotes <i>(Protects column and table names formed with special characters or keywords)</i>'));
}

function sql(param: ExportPluginParam): PluginProperties {
	const hideSql = hidesStructure(param) && !param.rawQuery;
	if (hideSql) {
		return properties('SQL', 'sql', 'text/x-sql', null);
	}
	// Relation and media type comments need the phpMyAdmin configuration storage, so they are left out.
	const comments = new OptionsGroup('subgroup', 'include_comments')
		.setHeader(bool('include_comments', 'Display comments <i>(includes info such as export timestamp, PHP version, and server version)</i>'))
		.add(textItem('header_comment', String.raw`Additional custom header comment (\n splits lines):`))
		.add(bool('dates', 'Include a timestamp of when databases were created, last updated, and last checked'));
	const general = main('general_opts')
		.add(comments)
		.add(bool('use_transaction', 'Enclose export in a transaction'))
		.add(bool('disable_fk', 'Disable foreign key checks'))
		.add(bool('views_as_tables', 'Export views as tables'))
		.add(bool('metadata', 'Export metadata'))
		.add(new OptionsItem('select', 'compatibility', 'Database system or older MySQL server to maximize output compatibility with:').setValues(SQL_COMPATIBILITIES.map(value => [value, value])))
		.add(new OptionsGroup('subgroup', 'dump_table', 'Dump table').setHeader(structureOrData()));
	const options = root().add(general).add(sqlStructureOptions(param));
	const insertSyntax = new OptionsItem('radio', 'insert_syntax', '<code>INSERT IGNORE</code> statements').setValues([
		['complete', 'include column names in every <code>INSERT</code> statement <br> &nbsp; &nbsp; &nbsp; Example: <code>INSERT INTO tbl_name (col_A,col_B,col_C) VALUES (1,2,3)</code>'],
		['extended', 'insert multiple rows in every <code>INSERT</code> statement<br> &nbsp; &nbsp; &nbsp; Example: <code>INSERT INTO tbl_name VALUES (1,2,3), (4,5,6), (7,8,9)</code>'],
		['both', 'both of the above<br> &nbsp; &nbsp; &nbsp; Example: <code>INSERT INTO tbl_name (col_A,col_B,col_C) VALUES (1,2,3), (4,5,6), (7,8,9)</code>'],
		['none', 'neither of the above<br> &nbsp; &nbsp; &nbsp; Example: <code>INSERT INTO tbl_name VALUES (1,2,3)</code>'],
	]);
	const data = main('data', 'Data creation options').setForce('structure')
		.add(bool('truncate', 'Truncate table before insert'))
		.add(new OptionsGroup('subgroup')
			// Upstream passes this text as the name, so the message itself renders empty.
			.setHeader(new OptionsItem('message', 'Instead of <code>INSERT</code> statements, use:'))
			.add(bool('delayed', '<code>INSERT DELAYED</code> statements'))
			.add(bool('ignore', '<code>INSERT IGNORE</code> statements')))
		.add(new OptionsItem('select', 'type', 'Function to use when dumping data:').setValues([['INSERT', 'INSERT'], ['UPDATE', 'UPDATE'], ['REPLACE', 'REPLACE']]))
		.add(new OptionsGroup('subgroup')
			.setHeader(new OptionsItem('message', null, 'Syntax to use when inserting data:'))
			.add(insertSyntax))
		.add(new OptionsItem('number', 'max_query_size', 'Maximal length of created query'))
		.add(bool('hex_for_binary', 'Dump binary columns in hexadecimal notation <i>(for example, "abc" becomes 0x616263)</i>'))
		.add(bool('utc_time', 'Dump TIMESTAMP columns in UTC <i>(enables TIMESTAMP columns to be dumped and reloaded between servers in different time zones)</i>'));
	options.add(data);
	return properties('SQL', 'sql', 'text/x-sql', options);
}

function texytext(): PluginProperties {
	const options = root()
		.add(main('general_opts', 'Dump table').add(structureOrData()))
		.add(main('data', 'Data dump options').setForce('structure')
			.add(bool('columns', 'Put columns names in the first row'))
			.add(textItem('null', 'Replace NULL with:')));
	return properties('Texy! text', 'txt', 'text/plain', options);
}

function xml(): PluginProperties {
	const structure = main('structure', 'Object creation options (all are recommended)')
		.add(bool('export_events', 'Events'))
		.add(bool('export_functions', 'Functions'))
		.add(bool('export_procedures', 'Procedures'))
		.add(bool('export_tables', 'Tables'))
		.add(bool('export_triggers', 'Triggers'))
		.add(bool('export_views', 'Views'));
	const options = root()
		.add(main('general_opts').add(hidden('structure_or_data')))
		.add(structure)
		.add(main('data', 'Data dump options').add(bool('export_contents', 'Export contents')));
	return properties('XML', 'xml', 'text/xml', options);
}

function yaml(): PluginProperties {
	return properties('YAML', 'yml', 'text/yaml', root().add(main('general_opts').add(hidden('structure_or_data'))), true);
}

const EXPORT_PLUGINS: Record<string, (param: ExportPluginParam) => PluginProperties> = {
	codegen,
	csv,
	excel,
	htmlword,
	json,
	latex,
	mediawiki,
	ods,
	odt,
	pdf,
	phparray,
	sql,
	texytext,
	xml,
	yaml,
};

/** Plugins::getPlugin('export', $format): null for an unknown format. */
export function getExportPlugin(format: string, param: ExportPluginParam): PluginInfo | null {
	const name = format.toLowerCase();
	if (!Object.hasOwn(EXPORT_PLUGINS, name)) {
		return null;
	}
	return { name, properties: EXPORT_PLUGINS[name](param) };
}

/** Plugins::getExport(): the available plugins sorted by their display name. */
export function getExportList(param: ExportPluginParam): PluginInfo[] {
	return Object.keys(EXPORT_PLUGINS)
		// ExportXml cannot export a whole server.
		.filter(name => name !== 'xml' || param.db !== '')
		.map((name) => { return { name, properties: EXPORT_PLUGINS[name](param) }; })
		.toSorted((left, right) => strcasecmp(left.properties.text, right.properties.text));
}

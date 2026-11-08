// The setProperties() of each Plugins\Import\Import* class the import page offers.
import { SQL_COMPATIBILITIES } from './export-plugins.ts';
import {
	OptionsGroup,
	OptionsItem,
	type PluginInfo,
	type PluginProperties,
} from './properties.ts';
import { strcasecmp } from '../php-compare.ts';

/** Plugins::getImport()'s $plugin_param plus what the CSV plugin renders next to its column list. */
export interface ImportPluginParam {
	/** server, database or table. */
	importType: string;
	/** Generator::showHint() of the CSV column order hint. */
	columnsHint: string;
}

/** The CSV column order hint, which Generator::showHint() wraps. */
export const CSV_COLUMNS_HINT = 'If the data in each row of the file is not in the same order as in the database, list the corresponding column names here. Column names must be separated by commas and not enclosed in quotations.';

// ImportPluginProperties::getForceFile() is always true.
function properties(text: string, extension: string, options: OptionsGroup | null, mimeType = ''): PluginProperties {
	return { text, extension, mimeType, forceFile: true, options };
}

const text = (name: string, label: string, size: number | null = null, len: number | null = null): OptionsItem => {
	const item = new OptionsItem('text', name, label);
	item.size = size;
	item.len = len;
	return item;
};
const bool = (name: string, label: string): OptionsItem => new OptionsItem('bool', name, label);

// AbstractImportCsv::getGeneralOptions().
function csvGeneralOptions(): OptionsGroup {
	return new OptionsGroup('main', 'general_opts')
		.add(bool('replace', 'Update data when duplicate keys found on import (add ON DUPLICATE KEY UPDATE)'))
		.add(text('terminated', 'Columns separated with:', 2))
		.add(text('enclosed', 'Columns enclosed with:', 2, 2))
		.add(text('escaped', 'Columns escaped with:', 2, 2))
		.add(text('new_line', 'Lines terminated with:', 2));
}

function csv(param: ImportPluginParam): PluginProperties {
	const general = csvGeneralOptions();
	if (param.importType === 'table') {
		general.add(new OptionsItem('number', 'partial_import', 'Import these many number of rows (optional):'));
		general.add(text('columns', `Column names: ${param.columnsHint}`));
	} else {
		general.add(text('new_tbl_name', 'Name of the new table (optional):'));
		if (param.importType === 'server') {
			general.add(text('new_db_name', 'Name of the new database (optional):'));
		}
		general.add(new OptionsItem('number', 'partial_import', 'Import these many number of rows (optional):'));
		general.add(bool('col_names', 'The first line of the file contains the table column names <i>(if this is unchecked, the first line will become part of the data)</i>'));
	}
	general.add(bool('ignore', 'Do not abort on INSERT error'));
	return properties('CSV', 'csv', new OptionsGroup('root', 'Format Specific Options').add(general));
}

function ldi(): PluginProperties {
	const general = csvGeneralOptions()
		.add(text('columns', 'Column names: '))
		.add(bool('ignore', 'Do not abort on INSERT error'))
		.add(bool('local_option', 'Use LOCAL keyword'));
	return properties('CSV using LOAD DATA', 'ldi', new OptionsGroup('root', 'Format Specific Options').add(general));
}

function ods(): PluginProperties {
	const general = new OptionsGroup('main', 'general_opts')
		.add(bool('col_names', 'The first line of the file contains the table column names <i>(if this is unchecked, the first line will become part of the data)</i>'))
		.add(bool('empty_rows', 'Do not import empty rows'))
		.add(bool('recognize_percentages', 'Import percentages as proper decimals <i>(ex. 12.00% to .12)</i>'))
		.add(bool('recognize_currency', 'Import currencies <i>(ex. $5.00 to 5.00)</i>'));
	return properties('OpenDocument Spreadsheet', 'ods', new OptionsGroup('root', 'Format Specific Options').add(general));
}

function sql(): PluginProperties {
	const general = new OptionsGroup('main', 'general_opts')
		.add(new OptionsItem('select', 'compatibility', 'SQL compatibility mode:').setValues(SQL_COMPATIBILITIES.map(value => [value, value])))
		.add(bool('no_auto_value_on_zero', 'Do not use <code>AUTO_INCREMENT</code> for zero values'));
	return properties('SQL', 'sql', new OptionsGroup('root', 'Format Specific Options').add(general));
}

const IMPORT_PLUGINS: Record<string, (param: ImportPluginParam) => PluginProperties> = {
	csv,
	ldi,
	mediawiki: () => properties('MediaWiki Table', 'txt', null, 'text/plain'),
	ods,
	shp: () => properties('ESRI Shape File', 'shp', null),
	sql,
	xml: () => properties('XML', 'xml', null, 'text/xml'),
};

/** Plugins::getImport(): LOAD DATA is only offered on a table, and the list is sorted by display name. */
export function getImportList(param: ImportPluginParam): PluginInfo[] {
	return Object.keys(IMPORT_PLUGINS)
		.filter(name => name !== 'ldi' || param.importType === 'table')
		.map((name) => { return { name, properties: IMPORT_PLUGINS[name](param) }; })
		.toSorted((left, right) => strcasecmp(left.properties.text, right.properties.text));
}

/** Plugins::getPlugin('import', $format): null for an unknown format or LOAD DATA outside a table. */
export function getImportPlugin(format: string, param: ImportPluginParam): PluginInfo | null {
	return getImportList(param).find(plugin => plugin.name === format.toLowerCase()) ?? null;
}

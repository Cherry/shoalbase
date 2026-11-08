// The setProperties() of Plugins\Schema\Schema{Dia,Eps,Pdf,Svg}, which the designer's export dialog lists.
import {
	OptionsGroup,
	OptionsItem,
	type PluginInfo,
	type PluginProperties,
} from '../export-import/properties.ts';

const bool = (name: string, text: string): OptionsItem => new OptionsItem('bool', name, text);
const select = (name: string, text: string, values: [string, string][]): OptionsItem => new OptionsItem('select', name, text).setValues(values);
const ORIENTATION: [string, string][] = [['L', 'Landscape'], ['P', 'Portrait']];

/** SchemaPlugin::addCommonOptions() plus the plugin's own options, in one general_opts group. */
function properties(text: string, extension: string, items: OptionsItem[]): PluginProperties {
	const general = new OptionsGroup('main', 'general_opts')
		.add(bool('show_color', 'Show color'))
		.add(bool('show_keys', 'Only show keys'));
	for (const item of items) {
		general.add(item);
	}
	return { text, extension, mimeType: `application/${extension}`, forceFile: true, options: new OptionsGroup('root', 'Format Specific Options').add(general) };
}

/** Plugins::getSchema(), in the alphabetical order the plugin directory is read in. */
export function getSchemaPlugins(paperSizes: string[]): PluginInfo[] {
	const paper = (): OptionsItem => select('paper', 'Paper size', paperSizes.map(size => [size, size]));
	const sameWidth = (): OptionsItem => bool('all_tables_same_width', 'Same width for all tables');
	return [
		{ name: 'dia', properties: properties('Dia', 'dia', [select('orientation', 'Orientation', ORIENTATION), paper()]) },
		{ name: 'eps', properties: properties('EPS', 'eps', [sameWidth(), select('orientation', 'Orientation', ORIENTATION)]) },
		{
			name: 'pdf',
			properties: properties('PDF', 'pdf', [
				sameWidth(),
				select('orientation', 'Orientation', ORIENTATION),
				paper(),
				bool('show_grid', 'Show grid'),
				bool('with_doc', 'Data dictionary'),
				select('table_order', 'Order of the tables', [['', 'None'], ['name_asc', 'Name (Ascending)'], ['name_desc', 'Name (Descending)']]),
			]),
		},
		{ name: 'svg', properties: properties('SVG', 'svg', [sameWidth()]) },
	];
}

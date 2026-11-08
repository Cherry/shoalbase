// Pure parts of PhpMyAdmin\Server\Plugins and Server\Plugin, plus PluginsController's grouping.
import { phpCompareStrings } from '../php-compare.ts';

type Row = Record<string, string | null>;

export interface PluginArray {
	name: string;
	version: string | null;
	status: string;
	type: string;
	type_version: string | null;
	library: string | null;
	library_version: string | null;
	author: string | null;
	description: string | null;
	license: string;
	load_option: string | null;
	maturity: string | null;
	auth_version: string | null;
}

/** The first column present in the row, like PHP's chained ?? operators. */
function pick(row: Row, ...keys: string[]): string | null {
	for (const key of keys) {
		const value = row[key];
		if (value !== undefined && value !== null) {
			return value;
		}
	}
	return null;
}

/** Plugins::mapRowToPlugin() followed by Plugin::toArray(), for information_schema.PLUGINS or SHOW PLUGINS rows. */
export function pluginFromRow(row: Row): PluginArray {
	return {
		name: pick(row, 'PLUGIN_NAME', 'Name') ?? '',
		version: pick(row, 'PLUGIN_VERSION'),
		status: pick(row, 'PLUGIN_STATUS', 'Status') ?? '',
		type: pick(row, 'PLUGIN_TYPE', 'Type') ?? '',
		type_version: pick(row, 'PLUGIN_TYPE_VERSION'),
		library: pick(row, 'PLUGIN_LIBRARY', 'Library'),
		library_version: pick(row, 'PLUGIN_LIBRARY_VERSION'),
		author: pick(row, 'PLUGIN_AUTHOR'),
		description: pick(row, 'PLUGIN_DESCRIPTION'),
		license: pick(row, 'PLUGIN_LICENSE', 'License') ?? '',
		load_option: pick(row, 'LOAD_OPTION'),
		maturity: pick(row, 'PLUGIN_MATURITY'),
		auth_version: pick(row, 'PLUGIN_AUTH_VERSION'),
	};
}

/** PluginsController: plugins grouped by type (ksort()ed) and each type's CSS-safe name. */
export function groupPlugins(plugins: PluginArray[]): { plugins: Map<string, PluginArray[]>; cleanTypes: Map<string, string>; } {
	const grouped = Map.groupBy(plugins, plugin => plugin.type);
	const sorted = new Map([...grouped].toSorted(([left], [right]) => phpCompareStrings(left, right)));
	const cleanTypes = new Map(sorted.keys().map(type => [type, type.toLowerCase().replaceAll(/[^a-z]/g, '')]));
	return { plugins: sorted, cleanTypes };
}


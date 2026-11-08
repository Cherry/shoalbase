// Shared steps of the export and import controllers.
import { type ExportPluginParam, getExportList } from '../../../../lib/pma/export-import/export-plugins.ts';
import { twigVariables } from '../../../../lib/pma/server/twig-data.ts';
import { renderTemplate } from '../../../twig/render.ts';
import { Table } from '../../core/table.ts';

import type { OptionRequest, PluginInfo } from '../../../../lib/pma/export-import/properties.ts';
import type { PmaContext } from '../../core/context.ts';

/** Renders a template with Maps turned into Twig arrays. */
export async function render(context: PmaContext, name: string, variables: Record<string, unknown>): Promise<string> {
	return renderTemplate(name, twigVariables(variables), await context.templateState());
}

/** A request value as a string, or undefined when absent or an array. */
export function stringParam(value: unknown): string | undefined {
	if (typeof value === 'string') {
		return value;
	}
	return undefined;
}

/** The request state Plugins::getDefault() and checkboxCheck() read for $cfg['Export'] or $cfg['Import']. */
export function optionRequest(context: PmaContext, section: 'Export' | 'Import', timeoutPassed = false): OptionRequest {
	return {
		get: context.request.query,
		request: context.request.params,
		timeoutPassed,
		section: context.config[section] as unknown as Record<string, unknown>,
	};
}

export async function exportPluginParam(context: PmaContext, exportType: string, singleTable: boolean): Promise<ExportPluginParam> {
	let isView = false;
	// Only the SQL plugin's table options ask, and only when its structure options are shown.
	if (exportType === 'table' && (singleTable || context.request.params.raw_query !== undefined)) {
		isView = await Table.get(context, context.table, context.db).isView();
	}
	return { exportType, singleTable, rawQuery: context.request.params.raw_query !== undefined, isView, db: context.db };
}
/** Plugins::getExport($type, $singleTable) with what the plugins read from the request and the current table. */
export async function exportPlugins(context: PmaContext, exportType: string, singleTable: boolean): Promise<PluginInfo[]> {
	return getExportList(await exportPluginParam(context, exportType, singleTable));
}


/** $GLOBALS['single_table'] = $_POST['single_table'] ?? $_GET['single_table'] ?? null. */
export function singleTableParam(context: PmaContext): string | string[] | undefined {
	return context.request.post.single_table ?? context.request.query.single_table;
}

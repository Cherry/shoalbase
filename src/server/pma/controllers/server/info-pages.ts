// Ports of the read-only server pages: Server\CollationsController, Server\EnginesController and Server\PluginsController.
import { withMysqlDie } from './mysql-die.ts';
import { renderServerTemplate } from './render.ts';
import { groupPlugins, pluginFromRow } from '../../../../lib/pma/server/plugins.ts';
import { getCharsets, getCollations } from '../../core/charsets.ts';
import { getStorageEngines } from '../../core/storage-engine.ts';

import type { PmaContext } from '../../core/context.ts';

/** The `if ($dbi->isSuperUser()) $dbi->selectDb('mysql')` every server page starts with. */
export async function selectMysqlForSuperUser(context: PmaContext): Promise<void> {
	if (await context.dbi.isSuperUser()) {
		await context.dbi.selectDb('mysql');
	}
}

export async function collationsController(context: PmaContext): Promise<Response> {
	const charsetMap = await getCharsets(context);
	const collationMap = await getCollations(context);
	await selectMysqlForSuperUser(context);
	const charsets = charsetMap.values().map((charset) => {
		const collations = [...(collationMap.get(charset.getName())?.values() ?? [])].map((collation) => {
			return { name: collation.getName(), description: collation.getDescription(), is_default: collation.isDefault() };
		});
		return { name: charset.getName(), description: charset.getDescription(), collations };
	}).toArray();
	context.response.addHTML(await renderServerTemplate(context, 'server/collations/index', { charsets }));
	return context.response.response();
}

export async function enginesController(context: PmaContext): Promise<Response> {
	await selectMysqlForSuperUser(context);
	const engines = await getStorageEngines(context);
	context.response.addHTML(await renderServerTemplate(context, 'server/engines/index', { engines }));
	return context.response.response();
}

export async function pluginsController(context: PmaContext): Promise<Response> {
	return withMysqlDie(context, async () => {
		const { config, dbi, response } = context;
		await selectMysqlForSuperUser(context);
		response.addScriptFiles(['vendor/jquery/jquery.tablesorter.js', 'server/plugins.js']);
		let sql = 'SELECT * FROM information_schema.PLUGINS ORDER BY PLUGIN_TYPE, PLUGIN_NAME';
		if (config.Server.DisableIS) {
			sql = 'SHOW PLUGINS';
		}
		const result = await dbi.query(sql);
		const rows = result.fetchAllAssoc();
		const { plugins, cleanTypes } = groupPlugins(rows.map(row => pluginFromRow(row)));
		response.addHTML(await renderServerTemplate(context, 'server/plugins/index', { plugins, clean_types: cleanTypes }));
		return response.response();
	});
}

export const controllers = {
	'Server/CollationsController': collationsController,
	'Server/EnginesController': enginesController,
	'Server/PluginsController': pluginsController,
};

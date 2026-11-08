// CheckRelationsController: the configuration storage status page, which always reports storage as not configured.
// Creating pma__ tables (fixall_pmadb, fix_pmadb) is not ported: production must keep storage disabled.
import { renderTemplate } from '../../../twig/render.ts';

import type { PmaContext } from '../../core/context.ts';

// RelationParameters::toArray() when no configuration storage is set up.
const RELATION_PARAMETERS = {
	version: '5.2.3',
	user: null,
	db: null,
	bookmark: null,
	central_columns: null,
	column_info: null,
	designer_settings: null,
	export_templates: null,
	favorite: null,
	history: null,
	navigationhiding: null,
	pdf_pages: null,
	recent: null,
	relation: null,
	savedsearches: null,
	table_coords: null,
	table_info: null,
	table_uiprefs: null,
	tracking: null,
	userconfig: null,
	usergroups: null,
	users: null,
	bookmarkwork: false,
	mimework: false,
	centralcolumnswork: false,
	commwork: false,
	menuswork: false,
	designersettingswork: false,
	displaywork: false,
	exporttemplateswork: false,
	favoritework: false,
	navwork: false,
	pdfwork: false,
	recentwork: false,
	relwork: false,
	savedsearcheswork: false,
	historywork: false,
	trackingwork: false,
	uiprefswork: false,
	userconfigwork: false,
	allworks: false,
};

/** Relation::createPmaDatabase(): the attempt runs on the user's link, so customers get the privileges message. */
async function createPmaDatabase(context: PmaContext): Promise<void> {
	const { dbi, response } = context;
	await dbi.connect();
	if (await dbi.tryQuery('CREATE DATABASE IF NOT EXISTS `phpmyadmin`') !== false) {
		return;
	}
	if (dbi.getLastError()?.errno === 1044) {
		response.globals.message = 'You do not have necessary privileges to create a database named \'phpmyadmin\'. '
			+ 'You may go to \'Operations\' tab of any database to set up the phpMyAdmin configuration storage there.';
		return;
	}
	response.globals.message = dbi.getError();
}

export async function checkRelationsController(context: PmaContext): Promise<Response> {
	const { config, response } = context;
	if (context.request.post.create_pmadb !== undefined) {
		await createPmaDatabase(context);
	}
	response.addHTML(await renderTemplate('relation/check_relations', {
		db: context.db,
		zero_conf: config.ZeroConf,
		relation_parameters: RELATION_PARAMETERS,
		sql_dir: './sql/',
		config_storage_database_name: 'phpmyadmin',
		are_config_storage_tables_defined: false,
	}, await context.templateState()));
	return response.response();
}

export const controllers = {
	CheckRelationsController: checkRelationsController,
};

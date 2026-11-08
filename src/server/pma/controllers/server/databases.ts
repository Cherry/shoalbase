// Port of Controllers\Server\DatabasesController (route /server/databases): the database list with its create form.
import { withMysqlDie } from './mysql-die.ts';
import { renderServerTemplate } from './render.ts';
import { loadReplicationInfo } from './replication-info.ts';
import { isSystemSchema } from '../../../../lib/pma/dbi-sql.ts';
import { Message } from '../../../../lib/pma/message.ts';
import {
	type StatisticColumn,
	charsetQueryPart,
	sortDetails,
	statisticsColumns,
} from '../../../../lib/pma/server/databases.ts';
import { phpEmpty, phpInt } from '../../../../lib/pma/server/php.ts';
import { isReplicated } from '../../../../lib/pma/server/replication-info.ts';
import { getScriptNameForOption } from '../../../../lib/pma/util.ts';
import { backquote } from '../../../../lib/twig/sanitize.ts';
import { getCommon } from '../../../../lib/twig/url.ts';
import { findCollationByName, getCharsets, getCollations } from '../../core/charsets.ts';
import { getMessage } from '../../core/generator.ts';

import type { Collation } from '../../../../lib/pma/charsets.ts';
import type { ReplicationSideInfo } from '../../../../lib/pma/server/replication-info.ts';
import type { PmaContext } from '../../core/context.ts';
import type { DbiRow } from '../../core/dbi.ts';

interface DatabaseEntry {
	name: string;
	collation: [] | { name: string; description: string; };
	statistics: Record<string, StatisticColumn>;
	replication: { primary: Record<string, boolean>; replica: Record<string, boolean>; };
	is_system_schema: boolean;
	is_pmadb: boolean;
	url: string;
}

function replicationStatus(info: ReplicationSideInfo, name: string): Record<string, boolean> {
	if (!info.status) {
		return { status: false };
	}
	return { status: true, is_replicated: isReplicated(info, name) };
}

/** DatabasesController::getDatabases(). */
async function describeDatabases(context: PmaContext, rows: DbiRow[], hasStatistics: boolean, primary: ReplicationSideInfo, replica: ReplicationSideInfo) {
	const { config } = context;
	const databases = new Map<string, DatabaseEntry>();
	const totalStatistics = statisticsColumns();
	for (const row of rows) {
		const name = row.SCHEMA_NAME ?? '';
		const statistics = statisticsColumns();
		if (hasStatistics) {
			for (const [key, column] of Object.entries(statistics)) {
				column.raw = phpInt(row[key] ?? 0);
				(totalStatistics[key] as StatisticColumn).raw += column.raw;
			}
		}
		let url = getScriptNameForOption(context.urlState(), config.DefaultTabDatabase, 'database');
		let divider = '&';
		if (!url.includes('?')) {
			divider = '?';
		}
		url += getCommon(context.urlState(), { db: name }, divider);
		const entry: DatabaseEntry = {
			name,
			collation: [],
			statistics,
			replication: { primary: replicationStatus(primary, name), replica: replicationStatus(replica, name) },
			is_system_schema: isSystemSchema(name, true),
			is_pmadb: name === (config.Server.pmadb ?? ''),
			url,
		};
		databases.set(name, entry);
		const collation = await findCollationByName(context, row.DEFAULT_COLLATION_NAME ?? null);
		if (collation !== null) {
			entry.collation = { name: collation.getName(), description: collation.getDescription() };
		}
	}
	return { databases, totalStatistics };
}

async function charsetList(context: PmaContext) {
	const charsets = await getCharsets(context);
	const collations = await getCollations(context);
	const serverCollation = await context.dbi.getServerCollation();
	return charsets.values().map((charset) => {
		const collationList = (collations.get(charset.getName()) ?? new Map<string, Collation>()).values().map((collation) => {
			return { name: collation.getName(), description: collation.getDescription(), is_selected: serverCollation === collation.getName() };
		}).toArray();
		return { name: charset.getName(), description: charset.getDescription(), collations: collationList };
	}).toArray();
}

export async function databasesController(context: PmaContext): Promise<Response> {
	const { config, dbi, response, request } = context;
	const privileges = await dbi.getUserPrivileges();
	response.addScriptFiles(['server/databases.js']);

	if (await dbi.isSuperUser()) {
		await dbi.selectDb('mysql');
	}
	const replication = await loadReplicationInfo(context, request.post.primary_connection);

	const { sortBy, sortOrder } = sortDetails(request.params.sort_by, request.params.sort_order);
	const hasStatistics = !phpEmpty(request.params.statistics);
	let position = 0;
	if (!phpEmpty(request.params.pos)) {
		position = phpInt(request.params.pos);
	}

	let rows: DbiRow[] = [];
	let databaseCount = 0;
	if (context.server > 0) {
		rows = await dbi.getDatabasesFull(null, hasStatistics, sortBy, sortOrder, position, true);
		const databaseList = await dbi.getDatabaseList();
		databaseCount = databaseList.length;
	}

	const urlParams = { statistics: hasStatistics, pos: position, sort_by: sortBy, sort_order: sortOrder };
	const { databases, totalStatistics } = await describeDatabases(context, rows, hasStatistics, replication.primaryInfo, replication.replicaInfo);

	let charsets: Awaited<ReturnType<typeof charsetList>> = [];
	if (config.ShowCreateDb && privileges.isCreateDbPriv) {
		charsets = await charsetList(context);
	}

	response.addHTML(await renderServerTemplate(context, 'server/databases/index', {
		is_create_database_shown: config.ShowCreateDb,
		has_create_database_privileges: privileges.isCreateDbPriv,
		has_statistics: hasStatistics,
		database_to_create: privileges.dbToCreate,
		databases,
		total_statistics: totalStatistics,
		header_statistics: statisticsColumns(),
		charsets,
		database_count: databaseCount,
		pos: position,
		url_params: urlParams,
		max_db_list: config.MaxDbList,
		has_primary_replication: replication.primaryInfo.status,
		has_replica_replication: replication.replicaInfo.status,
		is_drop_allowed: await dbi.isSuperUser() || config.AllowUserDropDatabase,
		text_dir: 'ltr',
	}));
	return response.response();
}

/** Databases\CreateController (POST /server/databases/create). */
export async function createDatabaseController(context: PmaContext): Promise<Response> {
	const { config, dbi, response, request } = context;
	let newDb = request.post.new_db;
	if (typeof newDb !== 'string' || newDb.length === 0 || !response.isAjax) {
		response.addJSON({ message: Message.error() });
		return response.response();
	}
	const dbCollation = request.post.db_collation;
	// With lower_case_table_names=1 the server stores `DB` as `db`.
	if (await dbi.getLowerCaseNames() === '1') {
		newDb = newDb.toLowerCase();
	}
	let sqlQuery = `CREATE DATABASE ${backquote(newDb)}`;
	if (!phpEmpty(dbCollation) && typeof dbCollation === 'string') {
		const [databaseCharset = ''] = dbCollation.split('_', 1);
		const charsets = await getCharsets(context);
		const collations = await getCollations(context);
		if (charsets.has(databaseCharset) && collations.get(databaseCharset)?.has(dbCollation)) {
			sqlQuery += ` DEFAULT${charsetQueryPart(dbCollation)}`;
		}
	}
	sqlQuery += ';';

	const result = await dbi.tryQuery(sqlQuery);
	if (result === false) {
		// Keeps the database that was not created out of the header and navigation.
		context.db = '';
		response.setRequestStatus(false);
		response.addJSON({ message: Message.rawError(dbi.getError()) });
		return response.response();
	}
	context.db = newDb;
	const message = Message.success('Database %1$s has been created.');
	message.addParam(newDb);
	const scriptName = getScriptNameForOption(context.urlState(), config.DefaultTabDatabase, 'database');
	let divider = '&';
	if (!scriptName.includes('?')) {
		divider = '?';
	}
	response.addJSON({
		message,
		sql_query: await getMessage(context, '', { sqlQuery, type: 'success' }),
		url: scriptName + getCommon(context.urlState(), { db: newDb }, divider),
	});
	return response.response();
}

/** Databases\DestroyController (POST /server/databases/destroy). */
export async function destroyDatabaseController(context: PmaContext): Promise<Response> {
	const { config, dbi, response, request } = context;
	if (!response.isAjax || (!await dbi.isSuperUser() && !config.AllowUserDropDatabase)) {
		response.setRequestStatus(false);
		response.addJSON({ message: Message.error() });
		return response.response();
	}
	const posted = request.post.selected_dbs;
	let selected: unknown[] = [];
	if (Array.isArray(posted)) {
		selected = posted;
	} else if (posted !== null && typeof posted === 'object') {
		selected = Object.values(posted);
	}
	const databases = selected.filter((database): database is string => typeof database === 'string' && !isSystemSchema(database, true) && database !== (config.Server.pmadb ?? ''));
	if (databases.length === 0) {
		response.setRequestStatus(false);
		response.addJSON({ message: Message.error('No databases selected.') });
		return response.response();
	}
	return withMysqlDie(context, async () => {
		for (const database of databases) {
			response.globals.reload = true;
			await dbi.query(`DROP DATABASE ${backquote(database)}`);
		}
		let text = '%1$d databases have been dropped successfully.';
		if (databases.length === 1) {
			text = '%1$d database has been dropped successfully.';
		}
		const message = Message.success(text);
		message.addParam(databases.length);
		response.addJSON({ message });
		return response.response();
	});
}

export const controllers = {
	'Server/DatabasesController': databasesController,
	'Server/Databases/CreateController': createDatabaseController,
	'Server/Databases/DestroyController': destroyDatabaseController,
};

// Ports of Controllers\Database\OperationsController and Operations\CollationController without configuration storage.
import { getDbInfo, hasDatabase, render } from './common.ts';
import { getDefinition, getProceduresOrFunctions, getTriggers } from './objects.ts';
import { isSystemSchema } from '../../../../lib/pma/dbi-sql.ts';
import { Message } from '../../../../lib/pma/message.ts';
import { charsetQueryPart } from '../../../../lib/pma/server/databases.ts';
import { phpEmpty } from '../../../../lib/pma/server/php.ts';
import { backquote } from '../../../../lib/twig/sanitize.ts';
import { getCommon, getFromRoute } from '../../../../lib/twig/url.ts';
import { getCharsets, getCollations } from '../../core/charsets.ts';
import { getMessage } from '../../core/generator.ts';
import { Table } from '../../core/table.ts';
import { withMysqlDie } from '../server/mysql-die.ts';
import { moveCopy } from '../table-structure/move-copy.ts';

import type { PmaContext } from '../../core/context.ts';

/** Operations::runProcedureAndFunctionDefinitions() and runEventDefinitionsForDb(): recreates each definition in the new database. */
async function copyDefinitions(context: PmaContext, db: string, newName: string, which: 'PROCEDURE' | 'FUNCTION' | 'EVENT', names: string[]): Promise<void> {
	const { dbi, response } = context;
	for (const name of names) {
		await dbi.selectDb(db);
		const definition = await getDefinition(context, db, which, name);
		if (definition === null && which !== 'EVENT') {
			continue;
		}
		response.globals.sqlQuery += `\n${definition ?? ''}`;
		await dbi.selectDb(newName);
		await dbi.query(definition ?? '');
	}
}

/** ExportSql::getTableDefStandIn() as Operations calls it, without DROP or IF NOT EXISTS. */
async function standInDefinition(context: PmaContext, db: string, view: string): Promise<string> {
	const columns = await context.dbi.getColumnsFull(db, view);
	const lines = [...columns].map(([name, definition]) => `${backquote(name)} ${definition.Type}\n`);
	return `CREATE TABLE ${backquote(view)} (\n${lines.join(',')});\n`;
}

/** The rename and copy part of OperationsController::__invoke(); returns the message upstream sets. */
async function renameOrCopy(context: PmaContext, move: boolean, newName: string): Promise<Message> {
	const { db, dbi, request, response } = context;
	const post = request.post;
	const globals = response.globals;
	if (move || !phpEmpty(post.create_database_before_copying)) {
		// Operations::createDbBeforeCopy().
		let query = `CREATE DATABASE IF NOT EXISTS ${backquote(newName)}`;
		if (post.db_collation !== undefined) {
			query += ` DEFAULT${charsetQueryPart(String(post.db_collation))}`;
		}
		query += ';';
		globals.sqlQuery += query;
		await dbi.query(query);
		await dbi.query('SET SQL_MODE=\'NO_AUTO_VALUE_ON_ZERO\'');
	}
	await copyDefinitions(context, db, newName, 'PROCEDURE', await getProceduresOrFunctions(context, db, 'PROCEDURE'));
	await copyDefinitions(context, db, newName, 'FUNCTION', await getProceduresOrFunctions(context, db, 'FUNCTION'));
	await dbi.selectDb(db);
	const tableNames = await dbi.getTables(db);
	const dropIfExists = post.drop_if_exists === 'true';

	// Operations::getViewsAndCreateSqlViewStandIn().
	const views: string[] = [];
	for (const table of tableNames) {
		if (!await Table.get(context, table, db).isView()) {
			continue;
		}
		if (post.what !== 'nocopy' && dropIfExists) {
			const dropQuery = `DROP VIEW IF EXISTS ${backquote(newName)}.${backquote(table)}`;
			await dbi.query(dropQuery);
			globals.sqlQuery += `\n${dropQuery};`;
		}
		views.push(table);
		const standIn = await standInDefinition(context, db, table);
		await dbi.selectDb(newName);
		await dbi.query(standIn);
		globals.sqlQuery += `\n${standIn}`;
	}

	// Operations::copyTables(); a failed copy only stops the loop, as upstream's error flag never reaches the controller.
	for (const table of tableNames) {
		const object = Table.get(context, table, db);
		if (await object.isView()) {
			continue;
		}
		let what = String(post.what ?? 'data');
		if (await object.isMerge()) {
			if (what === 'data') {
				what = 'structure';
			} else if (what === 'dataonly') {
				what = 'nocopy';
			}
		}
		if (what === 'nocopy') {
			continue;
		}
		const triggers = await getTriggers(context, db, table, '');
		const copied = await moveCopy(context, { sourceDb: db, sourceTable: table, targetDb: newName, targetTable: table, what, move, addDropIfExists: dropIfExists });
		if (!copied.ok) {
			break;
		}
		if (triggers.length === 0) {
			continue;
		}

		await dbi.selectDb(newName);
		for (const trigger of triggers) {
			await dbi.query(trigger.create);
			globals.sqlQuery += `\n${trigger.create};`;
		}
	}
	for (const view of views) {
		const copied = await moveCopy(context, { sourceDb: db, sourceTable: view, targetDb: newName, targetTable: view, what: 'structure', move, addDropIfExists: true });
		if (!copied.ok) {
			break;
		}
	}
	if (dbi.getVersion() >= 50100) {
		const events = await dbi.fetchResult<string>(`SELECT EVENT_NAME FROM information_schema.EVENTS WHERE EVENT_SCHEMA= '${dbi.escapeString(db)}';`);
		await copyDefinitions(context, db, newName, 'EVENT', events.map(String));
	}
	await dbi.selectDb(db);
	let message: Message;
	if (move) {
		const dropQuery = `DROP DATABASE ${backquote(db)};`;
		globals.sqlQuery += `\n${dropQuery}`;
		await dbi.query(dropQuery);
		message = Message.success('Database %1$s has been renamed to %2$s.');
	} else {
		message = Message.success('Database %1$s has been copied to %2$s.');
	}
	message.addParam(db);
	message.addParam(newName);
	globals.reload = true;
	if (move) {
		context.db = newName;
	} else if (post.switch_to_new === 'true') {
		context.session.data.pma_switch_to_new = true;
		context.db = newName;
	} else {
		context.session.data.pma_switch_to_new = false;
	}
	return message;
}

/** OperationsController::__invoke(). */
export async function operationsController(context: PmaContext): Promise<Response> {
	const { config, dbi, request, response } = context;
	const privileges = await dbi.getUserPrivileges();
	response.addScriptFiles(['database/operations.js']);
	response.globals.sqlQuery = '';
	const post = request.post;
	return withMysqlDie(context, async () => {
		let message: Message | undefined;
		if (context.db !== '' && (!phpEmpty(post.db_rename) || !phpEmpty(post.db_copy))) {
			const move = !phpEmpty(post.db_rename);
			let newName = typeof post.newname === 'string' ? post.newname : '';
			if (newName === '') {
				message = Message.error('The database name is empty!');
			} else {
				if (await dbi.getLowerCaseNames() === '1') {
					newName = newName.toLowerCase();
				}
				if (newName === request.params.db) {
					message = Message.error('Cannot copy database to the same name. Change the name and try again.');
				} else {
					message = await renameOrCopy(context, move, newName);
				}
			}
			if (response.isAjax) {
				response.setRequestStatus(message.isSuccess());
				response.addJSON('message', message);
				response.addJSON('newname', post.newname ?? null);
				response.addJSON('sql_query', await getMessage(context, '', { sqlQuery: response.globals.sqlQuery }));
				response.addJSON('db', context.db);
				return response.response();
			}
		}
		if (!await hasDatabase(context)) {
			return response.response();
		}
		const { isSystemSchema: systemSchema } = await getDbInfo(context, '_structure');
		let oldMessage = '';
		if (message !== undefined) {
			oldMessage = await getMessage(context, message, { sqlQuery: response.globals.sqlQuery });
		}
		const dbCollation = await dbi.getDbCollation(context.db);
		if (isSystemSchema(context.db)) {
			return response.response();
		}
		const hasAdjustPrivileges = privileges.dbPriv && privileges.tablePriv && privileges.colPriv && privileges.procPriv && privileges.isReloadPriv;
		const isDropDatabaseAllowed = (await dbi.isSuperUser() || config.AllowUserDropDatabase) && !systemSchema && context.db !== 'mysql';
		const charsets = await getCharsets(context);
		const collations = await getCollations(context);
		// unset() only drops the local alias, so a rename or copy message stays the global one the Header shows.
		if (message !== undefined) {
			response.globals.message = message;
		} else if (!config.PmaNoRelation_DisableWarning) {
			const notice = Message.notice('The phpMyAdmin configuration storage has been deactivated. %sFind out why%s.');
			notice.addParamHtml(`<a href="${getFromRoute(context.urlState(), '/check-relations')}" data-post="${getCommon(context.urlState(), { db: context.db })}">`);
			notice.addParamHtml('</a>');
			response.globals.message = notice;
		}
		response.addHTML(await render(context, 'database/operations/index', {
			message: oldMessage,
			db: context.db,
			has_comment: false,
			db_comment: '',
			db_collation: dbCollation,
			has_adjust_privileges: hasAdjustPrivileges,
			is_drop_database_allowed: isDropDatabaseAllowed,
			switch_to_new: context.session.data.pma_switch_to_new === true,
			charsets,
			collations,
		}));
		return response.response();
	});
}

/** Operations\CollationController. */
export async function collationController(context: PmaContext): Promise<Response> {
	const { db, dbi, request, response } = context;
	if (!response.isAjax) {
		return response.response();
	}
	const collation = request.post.db_collation;
	if (phpEmpty(collation)) {
		response.setRequestStatus(false);
		response.addJSON('message', Message.error('No collation provided.'));
		return response.response();
	}
	if (!await hasDatabase(context)) {
		return response.response();
	}
	const collationName = String(collation);
	return withMysqlDie(context, async () => {
		await dbi.query(`ALTER DATABASE ${backquote(db)} DEFAULT${charsetQueryPart(collationName)}`);
		if (request.post.change_all_tables_collations === 'on') {
			const { tables } = await getDbInfo(context, '');
			for (const tableName of tables.keys()) {
				// Views have no collation of their own (issue #15283).
				if (await Table.get(context, tableName, db).isView()) {
					continue;
				}
				await dbi.query(`ALTER TABLE ${backquote(db)}.${backquote(tableName)} DEFAULT${charsetQueryPart(collationName)}`);
				if (request.post.change_all_tables_columns_collations !== 'on') {
					continue;
				}
				// Operations::changeAllColumnsCollation().
				await dbi.selectDb(db);
				await dbi.query(`ALTER TABLE ${backquote(tableName)} CONVERT TO${charsetQueryPart(collationName, true)}`);
			}
		}
		const message = Message.success();
		response.setRequestStatus(message.isSuccess());
		response.addJSON('message', message);
		return response.response();
	});
}

export const controllers = {
	'Database/OperationsController': operationsController,
	'Database/Operations/CollationController': collationController,
};

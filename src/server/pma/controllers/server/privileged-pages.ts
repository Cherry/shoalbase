// Ports of the administrator pages as unprivileged accounts get them: Privileges (and account locking), Replication,
// Binary log and User groups. Without pmadb the user group pages have nothing to manage.
import { selectMysqlForSuperUser } from './info-pages.ts';
import { withMysqlDie } from './mysql-die.ts';
import { renderServerTemplate } from './render.ts';
import { replicationAdministration } from './replication.ts';
import { Message } from '../../../../lib/pma/message.ts';
import { phpEmpty, phpInt } from '../../../../lib/pma/server/php.ts';
import { getMessage } from '../../core/generator.ts';
import { privilegesController } from '../../privileges/controller.ts';

import type { PmaContext } from '../../core/context.ts';
import type { DbiRow } from '../../core/dbi.ts';

/** Compatibility::hasAccountLocking(). */
function hasAccountLocking(isMariaDB: boolean, version: number): boolean {
	return (isMariaDB && version >= 100402) || (!isMariaDB && version >= 50706);
}

async function accountLocking(context: PmaContext, action: 'LOCK' | 'UNLOCK'): Promise<Response> {
	const { dbi, response, request } = context;
	response.isAjax = true;
	const user = request.post.username;
	const host = request.post.hostname;
	let error: string | null = null;
	await dbi.connect();
	if (typeof user !== 'string' || typeof host !== 'string') {
		// AccountLocking's string parameters reject a missing value under strict_types.
		const argument = typeof user === 'string' ? 2 : 1;
		const name = argument === 1 ? 'user' : 'host';
		error = String.raw`PhpMyAdmin\Server\Privileges\AccountLocking::${action === 'LOCK' ? 'lock' : 'unlock'}(): Argument #${argument} ($${name}) must be of type string, null given, called in /var/www/html/libraries/classes/Controllers/Server/Privileges/Account${action === 'LOCK' ? 'Lock' : 'Unlock'}Controller.php on line 38`;
	} else if (!hasAccountLocking(dbi.isMariaDB(), dbi.getVersion())) {
		error = 'Account locking is not supported.';
	} else if (await dbi.tryQuery(`ALTER USER '${dbi.escapeString(user)}'@'${dbi.escapeString(host)}' ACCOUNT ${action};`) === false) {
		error = dbi.getError();
	}
	if (error !== null) {
		response.setHttpResponseCode(400);
		response.setRequestStatus(false);
		response.addJSON({ message: Message.error(error) });
		return response.response();
	}
	let text = 'The account %s@%s has been successfully unlocked.';
	if (action === 'LOCK') {
		text = 'The account %s@%s has been successfully locked.';
	}
	const message = Message.success(text);
	message.addParam(user as string);
	message.addParam(host as string);
	response.addJSON({ message });
	return response.response();
}

export async function replicationController(context: PmaContext): Promise<Response> {
	const { dbi, response } = context;
	await selectMysqlForSuperUser(context);
	response.addScriptFiles(['server/privileges.js', 'replication.js', 'vendor/zxcvbn-ts.js']);
	if (await dbi.isSuperUser()) {
		return replicationAdministration(context);
	}
	response.addHTML(await renderServerTemplate(context, 'server/replication/index', { is_super_user: false }));
	return response.response();
}

// The template sums File_size with `+`: PHP's Twig coerces mysqli's numeric strings, Twing rejects strings.
function withNumericFileSizes(binaryLogs: Map<string, DbiRow>): Map<string, Record<string, unknown>> {
	const logs = new Map<string, Record<string, unknown>>();
	for (const [name, row] of binaryLogs) {
		if (row.File_size === undefined || row.File_size === null) {
			logs.set(name, row);
		} else {
			logs.set(name, { ...row, File_size: Number(row.File_size) });
		}
	}
	return logs;
}

export async function binlogController(context: PmaContext): Promise<Response> {
	const { config, dbi, request } = context;
	const binaryLogs = await dbi.fetchResult('SHOW BINARY LOGS', 'Log_name');
	return withMysqlDie(context, async () => {
		const log = request.post.log ?? null;
		await selectMysqlForSuperUser(context);
		const position = phpEmpty(request.post.pos) ? 0 : phpInt(request.post.pos);
		const maxRows = config.MaxRows;
		const urlParams: Record<string, unknown> = {};
		if (typeof log === 'string' && binaryLogs.has(log)) {
			urlParams.log = log;
		}
		const isFullQuery = !phpEmpty(request.post.is_full_query);
		if (isFullQuery) {
			urlParams.is_full_query = 1;
		}
		let sqlQuery = 'SHOW BINLOG EVENTS';
		if (typeof log === 'string' && !phpEmpty(log)) {
			sqlQuery += ` IN '${log}'`;
		}
		sqlQuery += ` LIMIT ${position}, ${maxRows}`;
		const result = await dbi.query(sqlQuery);
		const numRows = result.numRows();
		const previousParams = { ...urlParams };
		const fullQueriesParams: Record<string, unknown> = { ...urlParams };
		const nextParams = { ...urlParams };
		if (position > 0) {
			fullQueriesParams.pos = position;
			if (position > maxRows) {
				previousParams.pos = position - maxRows;
			}
		}
		fullQueriesParams.is_full_query = 1;
		if (isFullQuery) {
			delete fullQueriesParams.is_full_query;
		}
		if (numRows >= maxRows) {
			nextParams.pos = position + maxRows;
		}
		const values: DbiRow[] = result.fetchAllAssoc();
		const mode = config.TableNavigationLinksMode;
		context.response.addHTML(await renderServerTemplate(context, 'server/binlog/index', {
			url_params: urlParams,
			binary_logs: withNumericFileSizes(binaryLogs),
			log,
			sql_message: await getMessage(context, Message.success(), { sqlQuery }),
			values,
			has_previous: position > 0,
			has_next: numRows >= maxRows,
			previous_params: previousParams,
			full_queries_params: fullQueriesParams,
			next_params: nextParams,
			has_icons: mode === 'icons' || mode === 'both',
			is_full_query: isFullQuery,
		}));
		return context.response.response();
	});
}

/** UserGroupsController: without the configurable menus feature (no pmadb) the page stays empty. */
export async function userGroupsController(context: PmaContext): Promise<Response> {
	return context.response.response();
}

/** UserGroupsFormController. */
export async function userGroupsFormController(context: PmaContext): Promise<Response> {
	const { dbi, response, request } = context;
	response.isAjax = true;
	const username = request.query.username;
	response.setRequestStatus(false);
	response.setHttpResponseCode(400);
	if (username === undefined || String(username) === '') {
		response.addJSON('message', 'Missing parameter: username');
		return response.response();
	}
	await dbi.getUserPrivileges();
	response.addJSON('message', 'User groups management is not enabled.');
	return response.response();
}

export const controllers = {
	'Server/PrivilegesController': privilegesController,
	'Server/Privileges/AccountLockController': (context: PmaContext) => accountLocking(context, 'LOCK'),
	'Server/Privileges/AccountUnlockController': (context: PmaContext) => accountLocking(context, 'UNLOCK'),
	'Server/ReplicationController': replicationController,
	'Server/BinlogController': binlogController,
	'Server/UserGroupsController': userGroupsController,
	'Server/UserGroupsFormController': userGroupsFormController,
};

// Port of Controllers\Server\PrivilegesController with the database and table "Users having access" views it embeds.
import { PhpFatalError, Privileges } from './privileges.ts';
import { escapeString } from '../../../lib/pma/dbi-sql.ts';
import { Message } from '../../../lib/pma/message.ts';
import {
	getDataForDbInfo,
	isEmpty,
	isSet,
	looseCountEquals,
	looseStringEquals,
	updatePasswordError,
	wildcardEscapeForGrant,
} from '../../../lib/pma/privileges/grants.ts';
import {
	type ColumnPrivs,
	addColumnPrivs,
	copyDatabaseGrant,
	copyTableGrant,
	createDatabaseQueries,
	deleteUsersQueries,
	exportUserParts,
	generateQueriesForUpdatePrivileges,
	getSqlQueriesForDisplayAndAddUser,
	maskedSetPassword,
	needsHashedPassword,
	passwordHashingQuery,
	passwordQueries,
	revokeQueries,
} from '../../../lib/pma/privileges/queries.ts';
import { getScriptNameForOption } from '../../../lib/pma/util.ts';
import { htmlspecialchars, urlencode } from '../../../lib/twig/php.ts';
import { escapeMysqlWildcards } from '../../../lib/twig/sanitize.ts';
import { getFromRoute } from '../../../lib/twig/url.ts';
import { internalErrorPage } from '../controllers/database/common.ts';
import { selectMysqlForSuperUser } from '../controllers/server/info-pages.ts';
import { mysqlDieMessage } from '../controllers/server/mysql-die.ts';
import { renderServerTemplate } from '../controllers/server/render.ts';
import { DbiQueryError } from '../core/dbi.ts';
import { generatorState, getMessage } from '../core/generator.ts';

import type { PmaContext } from '../core/context.ts';

/** Generator::mysqlDie()'s exit, carrying the finished error box. */
class MysqlDie extends Error {
	constructor(readonly html: string) {
		super('mysqlDie');
	}
}

const TEXT_DIR = 'ltr';

/** Generator::mysqlDie($error, $query, false, $errorUrl): the error box with a Back link outside AJAX. */
function dieWithBackLink(context: PmaContext, error: string, sqlQuery: string): MysqlDie {
	let html = mysqlDieMessage(context, error, sqlQuery, false);
	if (!context.response.isAjax) {
		const backUrl = `${getFromRoute(context.urlState(), '/')}&amp;no_history=true`;
		html += `<fieldset class="pma-fieldset tblFooters">[ <a href="${backUrl}">Back</a> ]</fieldset>\n\n`;
	}
	return new MysqlDie(html);
}

class PrivilegesActions {
	private origOldPasswords: string | null = null;
	readonly privileges: Privileges;
	/** isset($_POST['change_copy']), which getDataForChangeOrCopyUser() unsets when the old user is missing. */
	changeCopy: boolean;
	/** The controller's global $message, which the page header still shows when a query dies. */
	message: Message | null = null;
	/** header() calls made before a fatal error, which the bare error page keeps. */
	sentHeaders: Record<string, string> = {};

	constructor(private readonly context: PmaContext) {
		this.privileges = new Privileges(context);
		this.changeCopy = context.request.post.change_copy !== undefined;
	}

	private get post(): Record<string, unknown> {
		return this.context.request.post;
	}

	/** The pre-5.7.6 MySQL and pre-10.0 MariaDB branches of updatePassword(), which change the plugin first. */
	private async legacyPasswordQueries(username: string, hostname: string, plugin: string, posted: unknown): Promise<{ sqlQuery: string; localQuery: string; }> {
		const { dbi } = this.context;
		// A missing $_POST['pma_pw'] is loosely equal to '' here, so it sets an empty password.
		const password = typeof posted === 'string' ? posted : '';
		const sqlQuery = maskedSetPassword(username, hostname, password);
		const hashing = async (): Promise<void> => {
			if (plugin === 'mysql_native_password') {
				await dbi.tryQuery('SET old_passwords = 0;');
			} else if (plugin === 'sha256_password') {
				await dbi.tryQuery('SET `old_passwords` = 2;');
			}
		};
		const where = ` WHERE \`User\` = '${escapeString(username)}' AND Host = '${escapeString(hostname)}';`;
		if (dbi.isMariaDB() && dbi.getVersion() >= 50200 && await dbi.isSuperUser()) {
			await hashing();
			const hashed = await this.getHashedPassword(posted);
			return { sqlQuery, localQuery: `UPDATE \`mysql\`.\`user\` SET  \`authentication_string\` = '${hashed}', \`Password\` = '',  \`plugin\` = '${plugin}'${where}` };
		}
		const row = await dbi.fetchSingleRow('SELECT @@old_passwords;');
		this.origOldPasswords = String(row?.['@@old_passwords'] ?? '');
		const updatePluginQuery = `UPDATE \`mysql\`.\`user\` SET \`plugin\` = '${plugin}'${where}`;
		if (await dbi.tryQuery(updatePluginQuery) === false) {
			throw dieWithBackLink(this.context, dbi.getError(), updatePluginQuery);
		}
		await dbi.tryQuery('FLUSH PRIVILEGES;');
		await hashing();
		if (Array.isArray(posted)) {
			throw new PhpFatalError();
		}
		let value = '\'\'';
		if (password !== '') {
			value = `PASSWORD('${escapeString(password)}')`;
		}
		return { sqlQuery, localQuery: `SET PASSWORD FOR '${escapeString(username)}'@'${escapeString(hostname)}' = ${value}` };
	}

	/** empty($_POST['change_copy']) once getDataForChangeOrCopyUser() ran. */
	changeCopyEmpty(): boolean {
		return !this.changeCopy || isEmpty(this.post.change_copy);
	}

	/** Privileges::getDataForChangeOrCopyUser(). */
	async getDataForChangeOrCopyUser(): Promise<{ queries: string[] | null; password: string | null; }> {
		const { dbi, response } = this.context;
		if (!this.changeCopy) {
			return { queries: null, password: null };
		}
		const { old_username: oldUsername, old_hostname: oldHostname } = this.post;
		if (typeof oldUsername !== 'string' || typeof oldHostname !== 'string') {
			throw new PhpFatalError();
		}
		const condition = ` WHERE \`User\` = '${escapeString(oldUsername)}' AND \`Host\` = '${escapeString(oldHostname)}';`;
		const row = await dbi.fetchSingleRow(`SELECT * FROM \`mysql\`.\`user\` ${condition}`);
		if (row === null) {
			response.addHTML(Message.notice('No user found.').getDisplay(generatorState(this.context)));
			this.changeCopy = false;
			return { queries: null, password: null };
		}
		for (const [key, value] of Object.entries(row)) {
			this.privileges.globals.set(key, value);
		}
		const { isMariaDb, version } = this.privileges.server();
		let password: string | null = row.password ?? row.Password ?? null;
		if (!isMariaDb && version >= 50606 && version < 50706 && ((isSet(row.authentication_string) && isEmpty(password)) || row.plugin === 'sha256_password')) {
			password = row.authentication_string;
		}
		if (isMariaDb && version >= 50500 && isSet(row.authentication_string) && isEmpty(password)) {
			password = row.authentication_string;
		}
		if (!isMariaDb && version >= 50706 && isSet(row.authentication_string)) {
			password = row.authentication_string;
		}
		return { queries: [], password };
	}

	/** Privileges::setProperPasswordHashing(). */
	async setProperPasswordHashing(plugin: unknown): Promise<void> {
		await this.context.dbi.tryQuery(passwordHashingQuery(plugin));
	}

	/** Privileges::checkIfMariaDBPwdCheckPluginActive(). */
	async checkIfMariaDbPwdCheckPluginActive(): Promise<boolean> {
		const { dbi } = this.context;
		if (!(dbi.isMariaDB() && dbi.getVersion() >= 100002)) {
			return false;
		}
		const result = await dbi.tryQuery('SHOW PLUGINS SONAME LIKE \'%_password_check%\'');
		if (result === false) {
			return false;
		}
		return result.fetchAllAssoc().some(row => row.Status === 'ACTIVE');
	}

	/** Privileges::getHashedPassword(), whose escapeString() makes anything but a string a TypeError. */
	async getHashedPassword(password: unknown): Promise<string> {
		if (typeof password !== 'string') {
			throw new PhpFatalError();
		}
		const row = await this.context.dbi.fetchSingleRow(`SELECT PASSWORD('${escapeString(password)}') AS \`password\`;`);
		return String(row?.password ?? '');
	}

	/** Privileges::addUser(). */
	async addUser(dbname: string | string[] | null, usernameIn: string, hostnameIn: string, password: string | null): Promise<{ message: Message | null; queries: string[] | null; queriesForDisplay: Map<number, string> | null; sqlQuery: string; error: boolean; }> {
		const { dbi } = this.context;
		const empty = { message: null, queries: null, queriesForDisplay: null, sqlQuery: '', error: false };
		if (this.post.adduser_submit === undefined && !this.changeCopy) {
			return empty;
		}
		let username = usernameIn;
		let hostname = hostnameIn;
		if ((this.post.pred_username ?? '') === 'any') {
			username = '';
		}
		switch (this.post.pred_hostname) {
			case 'any': {
				hostname = '%';
				break;
			}
			case 'localhost': {
				hostname = 'localhost';
				break;
			}
			case 'hosttable': {
				hostname = '';
				break;
			}
			case 'thishost': {
				const current = await dbi.fetchValue('SELECT USER()');
				if (typeof current === 'string') {
					hostname = current.slice(current.lastIndexOf('@') + 1);
				}
				break;
			}
		}
		const exists = await dbi.fetchValue(`SELECT '1' FROM \`mysql\`.\`user\` WHERE \`User\` = '${escapeString(username)}' AND \`Host\` = '${escapeString(hostname)}';`);
		if (exists === '1') {
			const message = Message.error('The user %s already exists!');
			message.addParam(`[em]'${username}'@'${hostname}'[/em]`);
			this.privileges.get.adduser = '1';
			return { ...empty, message, error: true };
		}

		const mariaDbPwdPluginActive = await this.checkIfMariaDbPwdCheckPluginActive();
		const privileges = await this.privileges.extractPrivInfo();
		const plugin = this.post.authentication_plugin;
		if (plugin !== undefined) {
			await this.setProperPasswordHashing(plugin);
		}
		const server = this.privileges.server();
		let hashedPassword: string | undefined;
		if (needsHashedPassword(server, mariaDbPwdPluginActive, this.post.pred_password)) {
			hashedPassword = await this.getHashedPassword(this.post.pma_pw);
		}
		const sql = getSqlQueriesForDisplayAndAddUser({
			username,
			hostname,
			password: password ?? '',
			server,
			mariaDbPwdPluginActive,
			privileges,
			post: this.context.request.post,
			globals: this.privileges.globals,
			isGrantUser: await dbi.isGrantUser(),
			hashedPassword,
		});

		if (this.changeCopyEmpty()) {
			let error = false;
			let sqlQuery = sql.sqlQuery;
			if (await dbi.tryQuery(sql.createUserReal) === false) {
				error = true;
			}
			if (sql.passwordSetReal !== null && plugin !== undefined && !isEmpty(sql.passwordSetReal)) {
				await this.setProperPasswordHashing(plugin);
				if (await dbi.tryQuery(sql.passwordSetReal) !== false) {
					sqlQuery += sql.passwordSetShow;
				}
			}
			sqlQuery = sql.createUserShow + sqlQuery;
			const created = await this.addUserAndCreateDatabase(error, sql.realSqlQuery, sqlQuery, username, hostname, dbname, sql.alterRealSqlQuery, sql.alterSqlQuery);
			return { message: created.message, queries: null, queriesForDisplay: null, sqlQuery: created.sqlQuery, error };
		}

		const queries = [sql.createUserReal, sql.realSqlQuery];
		if (sql.passwordSetReal !== null && plugin !== undefined && !isEmpty(sql.passwordSetReal)) {
			await this.setProperPasswordHashing(plugin);
			queries.push(sql.passwordSetReal);
		}
		const count = queries.length;
		const queriesForDisplay = new Map<number, string>([[count - 2, sql.createUserShow]]);
		if (sql.passwordSetReal !== null && !isEmpty(sql.passwordSetReal)) {
			queriesForDisplay.set(count - 3, sql.createUserShow);
			queriesForDisplay.set(count - 2, sql.sqlQuery);
			queriesForDisplay.set(count - 1, sql.passwordSetShow ?? '');
		} else {
			queriesForDisplay.set(count - 1, sql.sqlQuery);
		}
		return { message: null, queries, queriesForDisplay, sqlQuery: sql.sqlQuery, error: false };
	}

	/** Privileges::addUserAndCreateDatabase(). */
	async addUserAndCreateDatabase(error: boolean, realSqlQuery: string, sqlQueryIn: string, username: string, hostname: string, dbname: unknown, alterRealSqlQuery: string, alterSqlQuery: string): Promise<{ sqlQuery: string; message: Message; }> {
		const { dbi, response } = this.context;
		let sqlQuery = sqlQueryIn;
		let createDb1 = this.post['createdb-1'] !== undefined;
		let createDb2 = this.post['createdb-2'] !== undefined;
		let createDb3 = this.post['createdb-3'] !== undefined;
		let message: Message;
		const failed = error
			|| (!isEmpty(realSqlQuery) && await dbi.tryQuery(realSqlQuery) === false)
			|| (alterRealSqlQuery !== '' && await dbi.tryQuery(alterRealSqlQuery) === false);
		if (failed) {
			createDb1 = false;
			createDb2 = false;
			createDb3 = false;
			message = Message.rawError(dbi.getError());
		} else {
			sqlQuery += alterSqlQuery;
			message = Message.success('You have added a new user.');
		}
		const { createDatabase, grants } = createDatabaseQueries(username, hostname, dbname, { createDb1, createDb2, createDb3 });
		const run = async (query: string): Promise<void> => {
			sqlQuery += query;
			if (await dbi.tryQuery(query) === false) {
				message = Message.rawError(dbi.getError());
			}
		};
		if (createDatabase !== undefined) {
			await run(createDatabase);
			response.globals.reload = true;
			this.context.db = username;
		}
		for (const grant of grants) {
			await run(grant);
		}
		return { sqlQuery, message };
	}

	/** Privileges::getDbSpecificPrivsQueriesForChangeOrCopyUser() with getTablePrivsQueriesForChangeOrCopyUser(). */
	async getDbSpecificPrivsQueriesForChangeOrCopyUser(queriesIn: string[], username: string, hostname: string): Promise<string[]> {
		const { dbi } = this.context;
		const queries = [...queriesIn];
		const oldUsername = String(this.post.old_username ?? '');
		const condition = ` WHERE \`User\` = '${escapeString(oldUsername)}' AND \`Host\` = '${escapeString(String(this.post.old_hostname ?? ''))}';`;
		const dbResult = await dbi.query(`SELECT * FROM \`mysql\`.\`db\`${condition}`);
		for (let row = dbResult.fetchAssoc(); row !== null; row = dbResult.fetchAssoc()) {
			queries.push(copyDatabaseGrant(await this.privileges.extractPrivInfo(row), String(row.Db), username, hostname, row.Grant_priv === 'Y'));
		}
		const tableResult = await dbi.query(`SELECT \`Db\`, \`Table_name\`, \`Table_priv\` FROM \`mysql\`.\`tables_priv\`${condition}`);
		for (let row = tableResult.fetchAssoc(); row !== null; row = tableResult.fetchAssoc()) {
			// Upstream compares Host with the old user name here, so column privileges are rarely copied.
			const columnResult = await dbi.query(`SELECT \`Column_name\`, \`Column_priv\` FROM \`mysql\`.\`columns_priv\` WHERE \`User\` = '${escapeString(oldUsername)}' AND \`Host\` = '${escapeString(oldUsername)}' AND \`Db\` = '${escapeString(String(row.Db))}' AND \`Table_name\` = '${escapeString(String(row.Table_name))}';`);
			const privileges = await this.privileges.extractPrivInfo(row);
			const columns: ColumnPrivs = { Select: [], Insert: [], Update: [], References: [] };
			for (let column = columnResult.fetchAssoc(); column !== null; column = columnResult.fetchAssoc()) {
				addColumnPrivs(columns, String(column.Column_name), String(column.Column_priv));
			}
			const tableRow = { Db: String(row.Db), Table_name: String(row.Table_name), Table_priv: String(row.Table_priv) };
			queries.push(copyTableGrant(privileges, columns, tableRow, username, hostname));
		}
		return queries;
	}

	/** Privileges::updatePrivileges(). */
	async updatePrivileges(username: string, hostname: string, tablename: string, dbname: string, itemType: string): Promise<[string, Message]> {
		const { dbi } = this.context;
		const dbAndTable = wildcardEscapeForGrant(dbname, tablename);
		let [sqlQuery0, sqlQuery1] = revokeQueries(itemType, dbAndTable, username, hostname);
		if (this.post.Grant_priv === 'Y') {
			sqlQuery1 = '';
		}
		let grantBackQuery: string | null = null;
		let alterUserQuery: string | null = null;
		const privileges = await this.privileges.extractPrivInfo();
		if (tablename === '' || privileges.join('') !== 'USAGE') {
			[grantBackQuery, alterUserQuery] = generateQueriesForUpdatePrivileges({
				itemType,
				dbAndTable,
				username,
				hostname,
				dbname,
				privileges,
				server: this.privileges.server(),
				post: this.context.request.post,
				globals: this.privileges.globals,
			});
		}
		if (await dbi.tryQuery(sqlQuery0) === false) {
			sqlQuery0 = '';
		}
		if (sqlQuery1 !== '' && await dbi.tryQuery(sqlQuery1) === false) {
			sqlQuery1 = '';
		}
		if (grantBackQuery !== null) {
			await dbi.query(grantBackQuery);
		}
		if (alterUserQuery !== null) {
			await dbi.query(alterUserQuery);
		}
		const sqlQuery = `${sqlQuery0} ${sqlQuery1} ${grantBackQuery ?? ''} ${alterUserQuery ?? ''}`;
		const message = Message.success('You have updated the privileges for %s.');
		message.addParam(`'${username}'@'${hostname}'`);
		return [sqlQuery, message];
	}

	/** Privileges::getMessageAndSqlQueryForPrivilegesRevoke(). */
	async revokePrivileges(dbname: string, tablename: string, username: string, hostname: string, itemType: string): Promise<[Message, string]> {
		const { dbi } = this.context;
		const [sqlQuery0, revokeGrant] = revokeQueries(itemType, wildcardEscapeForGrant(dbname, tablename), username, hostname);
		await dbi.query(sqlQuery0);
		let sqlQuery1 = revokeGrant;
		if (await dbi.tryQuery(sqlQuery1) === false) {
			sqlQuery1 = '';
		}
		const message = Message.success('You have revoked the privileges for %s.');
		message.addParam(`'${username}'@'${hostname}'`);
		return [message, `${sqlQuery0} ${sqlQuery1}`];
	}

	/** Privileges::updatePassword(). */
	async updatePassword(username: string, hostname: string): Promise<Message> {
		const { dbi } = this.context;
		const { post } = this;
		const error = updatePasswordError(this.context.request.post);
		if (error !== null) {
			return Message.error(error);
		}
		const plugin = String(post.authentication_plugin ?? await this.privileges.getCurrentAuthenticationPlugin('change', username, hostname));
		const posted = post.pma_pw;
		const server = this.privileges.server();
		let queries = passwordQueries(server, username, hostname, plugin, typeof posted === 'string' ? posted : '');
		if (queries === null) {
			queries = await this.legacyPasswordQueries(username, hostname, plugin, posted);
		} else if (typeof posted !== 'string') {
			// The ALTER USER and SET PASSWORD branches escape $_POST['pma_pw'], which must be a string.
			throw new PhpFatalError();
		}
		if (await dbi.tryQuery(queries.localQuery) === false) {
			throw dieWithBackLink(this.context, dbi.getError(), queries.sqlQuery);
		}
		await dbi.tryQuery('FLUSH PRIVILEGES;');
		const message = Message.success('The password for %s was changed successfully.');
		message.addParam(`'${username}'@'${hostname}'`);
		if (this.origOldPasswords !== null) {
			await dbi.tryQuery(`SET \`old_passwords\` = ${this.origOldPasswords};`);
		}
		return message;
	}

	/** Privileges::deleteUser(). */
	async deleteUser(queriesIn: string[]): Promise<[string, Message]> {
		const { dbi } = this.context;
		if (queriesIn.length === 0) {
			return ['', Message.error('No users selected for deleting!')];
		}
		const queries = [...queriesIn];
		if (looseCountEquals(3, this.post.mode)) {
			queries.push('# Reloading the privileges …', 'FLUSH PRIVILEGES;');
		}
		let dropUserError = '';
		for (const query of queries) {
			if (query.startsWith('#')) {
				continue;
			}
			if (await dbi.tryQuery(query) === false) {
				dropUserError += `${dbi.getError()}\n`;
			}
		}
		this.context.db = '';
		const sqlQuery = queries.join('\n');
		if (dropUserError !== '') {
			return [sqlQuery, Message.rawError(dropUserError)];
		}
		return [sqlQuery, Message.success('The selected users have been deleted successfully.')];
	}

	/** Privileges::getDataForQueries(): runs the copy statements, then shows the password-hiding versions. */
	async getDataForQueries(queries: string[], queriesForDisplay: Map<number, string> | null): Promise<string[]> {
		const result = [...queries];
		for (const [index, query] of queries.entries()) {
			// Accounts without the global grant option leave an empty GRANT here.
			if (query === '') {
				throw new PhpFatalError('ValueError');
			}
			if (!query.startsWith('#')) {
				await this.context.dbi.query(query);
			}
			const display = queriesForDisplay?.get(index);
			if (display !== undefined) {
				result[index] = display;
			}
		}
		return result;
	}

	/** Privileges::getListForExportUserDefinition(). */
	async getListForExportUserDefinition(username: string, hostname: string): Promise<[string, string]> {
		let exportText = '<textarea class="export" cols="60" rows="15">';
		const selected = this.post.selected_usr;
		let title: string;
		if (selected === undefined) {
			title = `User \`${htmlspecialchars(username)}\`@\`${htmlspecialchars(hostname)}\``;
			exportText += await this.privileges.getGrants(username, hostname);
		} else {
			title = 'Privileges';
			// array_unique() of a string is a TypeError.
			if (!Array.isArray(selected)) {
				throw new PhpFatalError();
			}
			for (const exportUser of new Set(selected.map(String))) {
				const [user, host] = exportUserParts(exportUser);
				exportText += `# Privileges for \`${htmlspecialchars(user)}\`@\`${htmlspecialchars(host)}\`\n\n`;
				exportText += `${await this.privileges.getGrants(user, host)}\n`;
			}
		}
		return [title, `${exportText.trim()}</textarea>`];
	}

	/** Privileges::getExtraDataForAjaxBehavior(). */
	async getExtraDataForAjaxBehavior(password: string, sqlQuery: string, hostname: string, username: string): Promise<Record<string, unknown>> {
		const { dbi } = this.context;
		const { post } = this;
		const get = this.privileges.get;
		const dbnameIsWildcard = this.privileges.dbnameIsWildcard();
		const extraData: Record<string, unknown> = {};
		const newPrivileges = await this.privileges.extractPrivInfo(null, true);
		if (sqlQuery !== '') {
			extraData.sql_query = await this.privileges.sqlQueryBox(sqlQuery);
		}
		if (this.changeCopy) {
			const user = {
				name: username,
				host: hostname,
				has_password: !isEmpty(password) || post.pma_pw !== undefined,
				privileges: newPrivileges.join(', '),
				has_group: false,
				has_group_edit: false,
				has_grant: post.Grant_priv === 'Y',
			};
			extraData.new_user_string = await renderServerTemplate(this.context, 'server/privileges/new_user_ajax', {
				user,
				is_grantuser: await dbi.isGrantUser(),
				initial: get.initial ?? '',
			});
			const initial = [...username].slice(0, 1).join('').toUpperCase();
			extraData.new_user_initial = initial;
			extraData.new_user_initial_string = `<a href="${getFromRoute(this.context.urlState(), '/server/privileges', { initial })}">${initial}</a>`;
		}
		if (post.update_privs !== undefined) {
			extraData.db_specific_privs = false;
			extraData.db_wildcard_privs = false;
			if (dbnameIsWildcard !== undefined) {
				extraData.db_specific_privs = !dbnameIsWildcard;
				extraData.db_wildcard_privs = dbnameIsWildcard;
			}
			extraData.new_privileges = newPrivileges.join(', ');
		}
		if (get.validate_username !== undefined) {
			if (typeof get.username !== 'string') {
				throw new PhpFatalError();
			}
			const result = await dbi.query(`SELECT * FROM \`mysql\`.\`user\` WHERE \`User\` = '${escapeString(get.username)}';`);
			extraData.user_exists = result.fetchRow() !== null;
		}
		return extraData;
	}
}

/** Controllers\Database\PrivilegesController. */
async function databasePrivileges(context: PmaContext, privileges: Privileges, checkprivsdb: string): Promise<string> {
	const { dbi, config } = context;
	let db = checkprivsdb;
	if (await dbi.getLowerCaseNames() === '1') {
		db = checkprivsdb.toLowerCase();
	}
	const isSuperUser = await dbi.isSuperUser();
	let all = new Map<string, Record<string, unknown>>();
	if (isSuperUser) {
		all = await privileges.getAllPrivileges(db);
	}
	return renderServerTemplate(context, 'database/privileges/index', {
		is_superuser: isSuperUser,
		db,
		database_url: getScriptNameForOption(context.urlState(), config.DefaultTabDatabase, 'database'),
		text_dir: TEXT_DIR,
		is_createuser: await dbi.isCreateUser(),
		is_grantuser: await dbi.isGrantUser(),
		privileges: all,
	});
}

/** Controllers\Table\PrivilegesController. */
async function tablePrivileges(context: PmaContext, privileges: Privileges, checkprivsdb: string, checkprivstable: string): Promise<string> {
	const { dbi, config } = context;
	let db = checkprivsdb;
	let table = checkprivstable;
	if (await dbi.getLowerCaseNames() === '1') {
		db = checkprivsdb.toLowerCase();
		table = checkprivstable.toLowerCase();
	}
	const isSuperUser = await dbi.isSuperUser();
	let all = new Map<string, Record<string, unknown>>();
	if (isSuperUser) {
		all = await privileges.getAllPrivileges(db, table);
	}
	return renderServerTemplate(context, 'table/privileges/index', {
		db,
		table,
		is_superuser: isSuperUser,
		table_url: getScriptNameForOption(context.urlState(), config.DefaultTabTable, 'table'),
		text_dir: TEXT_DIR,
		is_createuser: await dbi.isCreateUser(),
		is_grantuser: await dbi.isGrantUser(),
		privileges: all,
	});
}

/** `$_POST['mode'] < 4` with PHP 8 comparison of a request value. */
function looseLessThanFour(mode: unknown): boolean {
	if (mode === undefined || mode === null) {
		return true;
	}
	if (typeof mode === 'string' && /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?\s*$/i.test(mode)) {
		return Number(mode) < 4;
	}
	return typeof mode === 'string' && mode < '4';
}

/** Privileges::getDataForDeleteUsers(). */
async function getDataForDeleteUsers(context: PmaContext, changeCopy: boolean, queries: string[] | null): Promise<string[]> {
	const { post } = context.request;
	let selected: unknown = post.selected_usr;
	let base: string[] = [];
	if (changeCopy) {
		selected = [`${String(post.old_username ?? '')}&amp;#27;${String(post.old_hostname ?? '')}`];
		base = queries ?? [];
	}
	if (!Array.isArray(selected)) {
		return [];
	}
	const result = deleteUsersQueries(selected, base, post.drop_users_db !== undefined);
	if (result === null) {
		throw new PhpFatalError();
	}
	if (post.drop_users_db !== undefined && selected.length > 0) {
		context.response.globals.reload = true;
	}
	return result;
}

/** `$username == $_POST['old_username']` with PHP 8 loose comparison, where a missing value is null. */
function looseEqualsPost(value: string | null, posted: unknown): boolean {
	if (posted === undefined) {
		return value === null || value === '';
	}
	if (typeof posted !== 'string') {
		return false;
	}
	return looseStringEquals(value ?? '', posted);
}

/** The administration part of PrivilegesController::__invoke() after the access check. */
async function administer(context: PmaContext, actions: PrivilegesActions, isGrantUser: boolean, isCreateUser: boolean): Promise<Response> {
	const { dbi, response, request } = context;
	const { post } = request;
	const { privileges } = actions;
	const info = getDataForDbInfo(post, request.params);
	const { dbname, tablename, routinename, dbnameIsWildcard } = info;
	let { username, hostname } = info;
	privileges.username = username;
	privileges.hostname = hostname;
	privileges.dbname = dbname;
	const state = generatorState(context);
	if (!isGrantUser && !isCreateUser) {
		response.addHTML(Message.notice('You do not have the privileges to administrate the users!').getDisplay(state));
	}
	if (post.change_copy !== undefined && looseEqualsPost(username, post.old_username) && looseEqualsPost(hostname, post.old_hostname)) {
		response.addHTML(Message.error('Username and hostname didn\'t change. If you only want to change the password, \'Change password\' tab should be used.').getDisplay(state));
		response.setRequestStatus(false);
		return response.response();
	}

	const copy = await actions.getDataForChangeOrCopyUser();
	let queries = copy.queries;
	const password = copy.password;
	const added = await actions.addUser(dbname, username ?? '', hostname ?? '', password);
	actions.message = added.message;
	// $sql_query is a global too, so the header of a later mysqlDie() shows it.
	response.globals.sqlQuery = added.sqlQuery;
	if (added.queries !== null) {
		queries = added.queries;
	}
	if (actions.changeCopy && username !== null && hostname !== null) {
		queries = await actions.getDbSpecificPrivsQueriesForChangeOrCopyUser(queries ?? [], username, hostname);
	}

	let itemType = '';
	if (!isEmpty(routinename) && typeof dbname === 'string') {
		itemType = await privileges.getRoutineType(dbname, routinename as string);
	}
	const objectName = tablename ?? routinename ?? '';
	if (!isEmpty(post.update_privs)) {
		if (Array.isArray(dbname)) {
			const statements: string[] = [];
			for (const name of dbname) {
				const [statement, updated] = await actions.updatePrivileges(username ?? '', hostname ?? '', objectName, name, itemType);
				statements.push(statement);
				actions.message = updated;
			}
			response.globals.sqlQuery = statements.join('\n');
		} else {
			const [statement, updated] = await actions.updatePrivileges(username ?? '', hostname ?? '', objectName, dbname ?? '', itemType);
			response.globals.sqlQuery = statement;
			actions.message = updated;
		}
	}
	if (post.revokeall !== undefined) {
		const [revoked, statement] = await actions.revokePrivileges(typeof dbname === 'string' ? dbname : '', objectName, username ?? '', hostname ?? '', itemType);
		actions.message = revoked;
		response.globals.sqlQuery = statement;
	}
	if (post.change_pw !== undefined) {
		actions.message = await actions.updatePassword(username ?? '', hostname ?? '');
	}
	if (post.delete !== undefined || (actions.changeCopy && looseLessThanFour(post.mode))) {
		queries = await getDataForDeleteUsers(context, actions.changeCopy, queries);
		if (actions.changeCopyEmpty()) {
			const [statement, deleted] = await actions.deleteUser(queries);
			response.globals.sqlQuery = statement;
			actions.message = deleted;
		}
	}
	if (actions.changeCopy) {
		queries = await actions.getDataForQueries(queries ?? [], added.queriesForDisplay);
		actions.message = Message.success();
		response.globals.sqlQuery = queries.join('\n');
	}
	const get = privileges.get;
	if (get.flush_privileges !== undefined) {
		await dbi.tryQuery('FLUSH PRIVILEGES;');
		actions.message = Message.success('The privileges were reloaded successfully.');
	}
	if (get.validate_username !== undefined) {
		actions.message = Message.success();
	}

	const isExport = get.export !== undefined || post.submit_mult === 'export';
	const ajaxPageRequest = !isEmpty(request.params.ajax_page_request);
	const initialEmpty = get.initial === undefined || get.initial === '';
	if (response.isAjax && !ajaxPageRequest && !isExport && (initialEmpty || post.delete === 'Go') && get.showall === undefined) {
		const extraData = await actions.getExtraDataForAjaxBehavior(password ?? '', response.globals.sqlQuery, hostname ?? '', username ?? '');
		if (actions.message !== null) {
			// The controller returns before unset($GLOBALS['message']), so the header shows it again.
			response.globals.message = actions.message;
			response.setRequestStatus(actions.message.isSuccess());
			response.addJSON('message', actions.message);
			response.addJSON(extraData);
			return response.response();
		}
	}

	if (get.viewing_mode === 'db') {
		// Util::getDbInfo() hands the database to string parameters, so a missing or array checkprivsdb is a TypeError.
		if (typeof get.checkprivsdb !== 'string') {
			throw new PhpFatalError();
		}
		context.db = get.checkprivsdb;
		response.addHTML('\n');
		if (actions.message !== null) {
			response.globals.message = actions.message;
		}
	} else if (actions.message !== null) {
		response.addHTML(await getMessage(context, actions.message));
		actions.message = null;
	}

	if (isExport) {
		const [title, exportText] = await actions.getListForExportUserDefinition(username ?? '', hostname ?? '');
		// unset() of the globalized names only drops the controller's own references.
		username = null;
		hostname = null;
		if (response.isAjax) {
			response.addJSON('message', exportText);
			response.addJSON('title', title);
			return response.response();
		}
		response.addHTML(`<h2>${title}</h2>${exportText}`);
	}

	if (get.adduser !== undefined || added.error) {
		response.addHTML(await privileges.getHtmlForAddUser(escapeMysqlWildcards(typeof dbname === 'string' ? dbname : '')));
	} else if (typeof get.checkprivsdb === 'string') {
		if (typeof get.checkprivstable === 'string') {
			response.addHTML(await tablePrivileges(context, privileges, get.checkprivsdb, get.checkprivstable));
			response.addHTML(await renderServerTemplate(context, 'export_modal', {}));
		} else if (response.isAjax && !ajaxPageRequest) {
			const userAdded = Message.success('User has been added.');
			response.globals.message = userAdded;
			response.addJSON('message', userAdded);
			return response.response();
		} else {
			response.addHTML(await databasePrivileges(context, privileges, get.checkprivsdb));
			response.addHTML(await renderServerTemplate(context, 'export_modal', {}));
		}
	} else {
		let urlDbname = '';
		if (dbname !== null && !Array.isArray(dbname)) {
			urlDbname = urlencode(dbname.replaceAll(String.raw`\_`, '_').replaceAll(String.raw`\%`, '%'));
		}
		if (username === null) {
			response.addHTML(await privileges.getHtmlForUserOverview(TEXT_DIR));
		} else if (!isEmpty(routinename)) {
			response.addHTML(await privileges.getHtmlForRoutineSpecificPrivileges(username, hostname ?? '', typeof dbname === 'string' ? dbname : '', routinename as string, escapeMysqlWildcards(urlDbname)));
		} else {
			if (response.isAjax) {
				actions.sentHeaders['Cache-Control'] = 'no-cache';
			}
			response.addHTML(await privileges.getHtmlForUserProperties(dbnameIsWildcard, escapeMysqlWildcards(urlDbname), username, hostname ?? '', dbname ?? '', tablename ?? ''));
		}
	}
	return response.response();
}

/** Controllers\Server\PrivilegesController. */
export async function privilegesController(context: PmaContext): Promise<Response> {
	const { dbi, response } = context;
	await dbi.getUserPrivileges();
	response.addScriptFiles(['server/privileges.js', 'vendor/zxcvbn-ts.js']);
	await selectMysqlForSuperUser(context);
	const isGrantUser = await dbi.isGrantUser();
	const isCreateUser = await dbi.isCreateUser();
	if (!await dbi.isSuperUser() && !isGrantUser && !isCreateUser) {
		response.addHTML(await renderServerTemplate(context, 'server/sub_page_header', { type: 'privileges', is_image: false }));
		response.addHTML(Message.error('No Privileges').getDisplay());
		return response.response();
	}
	const actions = new PrivilegesActions(context);
	try {
		return await administer(context, actions, isGrantUser, isCreateUser);
	} catch (error) {
		if (error instanceof PhpFatalError) {
			// PHP's fatal error page follows whatever was already added, without the phpMyAdmin page around it.
			return internalErrorPage(context, error.errorClass, actions.sentHeaders);
		}
		// Upstream's $message is a global, so the page header still shows it after mysqlDie().
		if (actions.message !== null) {
			response.globals.message = actions.message;
		}
		let html: string;
		if (error instanceof MysqlDie) {
			html = error.html;
		} else if (error instanceof DbiQueryError) {
			html = mysqlDieMessage(context, error.formatted, error.query);
		} else {
			throw error;
		}
		if (response.isAjax) {
			response.setRequestStatus(false);
			response.addJSON('message', html);
		} else if (response.isHtmlEmpty()) {
			// ResponseRenderer::response() only takes the echoed error when nothing was added before.
			response.addHTML(html);
		}
		return response.response();
	}
}


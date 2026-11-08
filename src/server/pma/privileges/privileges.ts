// Port of PhpMyAdmin\Server\Privileges (without pmadb, so the configurable menus feature is always off).
import { escapeString } from '../../../lib/pma/dbi-sql.ts';
import { Message } from '../../../lib/pma/message.ts';
import { phpCompareStrings, strnatcasecmp } from '../../../lib/pma/php-compare.ts';
import {
	type PrivRow,
	TABLE_GRANTS,
	extractPrivInfo as extractPrivInfoPure,
	fillInTablePrivileges,
	isEmpty,
	isSet,
	isWildcardDbname,
	looseStringEquals,
	parseProcPriv,
	parseTablePrivTypes,
	rangeOfUsers,
	unescapeMysqlWildcards,
} from '../../../lib/pma/privileges/grants.ts';
import {
	type ServerFlavor,
	dbRightsForUserOverviewQuery,
	getSqlQueryForDisplayPrivTable,
	rowHasPassword,
	userOverviewQueries,
	userSpecificRightsQueries,
} from '../../../lib/pma/privileges/queries.ts';
import { getScriptNameForOption, getTitleForTarget } from '../../../lib/pma/util.ts';
import { backquote, escapeMysqlWildcards } from '../../../lib/twig/sanitize.ts';
import { getFromRoute } from '../../../lib/twig/url.ts';
import { getRoutines } from '../controllers/database/objects.ts';
import { renderServerTemplate } from '../controllers/server/render.ts';
import { generatorState, getMessage, showMySQLDocumentation } from '../core/generator.ts';

import type { RequestParams } from '../../../lib/pma-request.ts';
import type { PmaContext } from '../core/context.ts';
import type { DbiRow } from '../core/dbi.ts';

// Core::setPostAsGlobal() patterns of PrivilegesController.
const POST_PATTERNS = [/_priv$/i, /^max_/i];

/** PHP integer-like array keys become ints, which `same as` in templates tells apart from strings. */
function phpArrayKey(key: string): string | number {
	if (/^(?:0|-?[1-9]\d*)$/.test(key) && Number.isSafeInteger(Number(key))) {
		return Number(key);
	}
	return key;
}

/** ksort() with PHP 8's default comparison of string keys. */
function ksort<T>(map: Map<string, T>): Map<string, T> {
	return new Map([...map].toSorted(([left], [right]) => phpCompareStrings(left, right)));
}

/** An uncaught PHP Error such as a TypeError, which upstream answers with the bare "Internal error" page. */
export class PhpFatalError extends Error {
	constructor(readonly errorClass = 'TypeError') {
		super(errorClass);
	}
}

export class Privileges {
	private predHostname: string | null = null;
	private tablePrivTypes: string[] | undefined;
	/** $GLOBALS entries this class reads: POSTed privilege and limit fields, and a copied user's mysql.user row. */
	readonly globals = new Map<string, unknown>();
	/** $_GET itself, since addUser() sets adduser on it and the header's return_url reads it afterwards. */
	readonly get: RequestParams;
	/** The global $username and $hostname of the controller, read by several renderers. */
	username: string | null = null;
	hostname: string | null = null;
	/** The global $dbname, read by getExtraDataForAjaxBehavior(). */
	dbname: string | string[] | null = null;

	constructor(private readonly context: PmaContext) {
		this.get = context.request.query;
		for (const [key, value] of Object.entries(context.request.post)) {
			if (POST_PATTERNS.some(pattern => pattern.test(key))) {
				this.globals.set(key, value);
			}
		}
	}

	private render(name: string, variables: Record<string, unknown>): Promise<string> {
		return renderServerTemplate(this.context, name, variables);
	}

	/** rangeOfUsers($_GET['initial']) when the initial is set; its ?string parameter makes an array a TypeError. */
	private rangeForInitial(): string {
		const initial = this.get.initial;
		if (initial === undefined) {
			return '';
		}
		if (typeof initial !== 'string') {
			throw new PhpFatalError();
		}
		return rangeOfUsers(initial);
	}

	/** SHOW TABLES FROM `mysql`, to skip privilege tables a server lacks. */
	private async getMysqlTables(): Promise<string[]> {
		const tables = await this.context.dbi.fetchResult<string>('SHOW TABLES FROM `mysql`;');
		return tables.map(String);
	}

	/** The plugin list of the login and password forms: every plugin except mysql_old_password, or native only. */
	private async activeAuthPlugins(useServerList: boolean): Promise<Map<string, string>> {
		if (!useServerList) {
			return new Map([['mysql_native_password', 'Native MySQL authentication']]);
		}
		const plugins = await this.getAuthenticationPlugins();
		plugins.delete('mysql_old_password');
		return plugins;
	}

	private async getSpecificPrivilege(row: DbiRow): Promise<Record<string, unknown>> {
		const privilege: Record<string, unknown> = { type: row.Type, database: row.Db };
		if (row.Type === 'r') {
			privilege.routine = row.Routine_name;
			privilege.has_grant = String(row.Proc_priv ?? '').includes('Grant');
			privilege.privileges = String(row.Proc_priv ?? '').split(',');
		} else if (row.Type === 't') {
			privilege.table = row.Table_name;
			privilege.has_grant = String(row.Table_priv ?? '').includes('Grant');
			const tablePrivs = String(row.Table_priv ?? '').split(',');
			const specific: PrivRow = {};
			for (const [name] of TABLE_GRANTS) {
				specific[name] = tablePrivs.some(priv => looseStringEquals(name, priv)) ? 'Y' : 'N';
			}
			privilege.privileges = await this.extractPrivInfo(specific, true, true);
		} else {
			privilege.has_grant = row.Grant_priv === 'Y';
			privilege.privileges = await this.extractPrivInfo(row, true);
		}
		return privilege;
	}

	private async getGlobalAndDatabasePrivileges(db: string): Promise<DbiRow[]> {
		const listOfPrivileges = `\`Select_priv\`,
            \`Insert_priv\`,
            \`Update_priv\`,
            \`Delete_priv\`,
            \`Create_priv\`,
            \`Drop_priv\`,
            \`Grant_priv\`,
            \`Index_priv\`,
            \`Alter_priv\`,
            \`References_priv\`,
            \`Create_tmp_table_priv\`,
            \`Lock_tables_priv\`,
            \`Create_view_priv\`,
            \`Show_view_priv\`,
            \`Create_routine_priv\`,
            \`Alter_routine_priv\`,
            \`Execute_priv\`,
            \`Event_priv\`,
            \`Trigger_priv\`,`;
		const compared = `BINARY \`Select_priv\` = 'N' AND
            BINARY \`Insert_priv\` = 'N' AND
            BINARY \`Update_priv\` = 'N' AND
            BINARY \`Delete_priv\` = 'N' AND
            BINARY \`Create_priv\` = 'N' AND
            BINARY \`Drop_priv\` = 'N' AND
            BINARY \`Grant_priv\` = 'N' AND
            BINARY \`References_priv\` = 'N' AND
            BINARY \`Create_tmp_table_priv\` = 'N' AND
            BINARY \`Lock_tables_priv\` = 'N' AND
            BINARY \`Create_view_priv\` = 'N' AND
            BINARY \`Show_view_priv\` = 'N' AND
            BINARY \`Create_routine_priv\` = 'N' AND
            BINARY \`Alter_routine_priv\` = 'N' AND
            BINARY \`Execute_priv\` = 'N' AND
            BINARY \`Event_priv\` = 'N' AND
            BINARY \`Trigger_priv\` = 'N'`;
		const query = `
            (
                SELECT \`User\`, \`Host\`, ${listOfPrivileges} '*' AS \`Db\`, 'g' AS \`Type\`
                FROM \`mysql\`.\`user\`
                WHERE NOT (${compared})
            )
            UNION
            (
                SELECT \`User\`, \`Host\`, ${listOfPrivileges} \`Db\`, 'd' AS \`Type\`
                FROM \`mysql\`.\`db\`
                WHERE '${escapeString(db)}' LIKE \`Db\` AND NOT (${compared})
            )
            ORDER BY \`User\` ASC, \`Host\` ASC, \`Db\` ASC;
        `;
		const result = await this.context.dbi.query(query);
		return result.fetchAllAssoc();
	}

	private async getTablePrivileges(db: string, table: string): Promise<DbiRow[]> {
		// Upstream binds both names as statement parameters; inline literals compare the same way.
		const query = `
            SELECT \`User\`, \`Host\`, \`Db\`, 't' AS \`Type\`, \`Table_name\`, \`Table_priv\`
            FROM \`mysql\`.\`tables_priv\`
            WHERE
                '${escapeString(db)}' LIKE \`Db\` AND
                '${escapeString(table)}' LIKE \`Table_name\` AND
                NOT (\`Table_priv\` = '' AND Column_priv = '')
            ORDER BY \`User\` ASC, \`Host\` ASC, \`Db\` ASC, \`Table_priv\` ASC;
        `;
		const result = await this.context.dbi.tryQuery(query);
		if (result === false) {
			return [];
		}
		return result.fetchAllAssoc();
	}

	private async getRoutinesPrivileges(db: string): Promise<DbiRow[]> {
		const query = `
            SELECT *, 'r' AS \`Type\`
            FROM \`mysql\`.\`procs_priv\`
            WHERE Db = '${escapeString(db)}';
        `;
		const result = await this.context.dbi.query(query);
		return result.fetchAllAssoc();
	}

	/** Privileges::getUserPrivileges(): the account's mysql.user row, with MariaDB's lock state from global_priv. */
	private async getAccountRow(user: string, host: string, hasAccountLocking: boolean): Promise<PrivRow | null> {
		const { dbi } = this.context;
		const condition = `WHERE \`User\` = '${escapeString(user)}' AND \`Host\` = '${escapeString(host)}';`;
		const result = await dbi.tryQuery(`SELECT * FROM \`mysql\`.\`user\` ${condition}`);
		const row: PrivRow | null = result === false ? null : result.fetchAssoc();
		if (row === null) {
			return null;
		}
		if (!hasAccountLocking || !dbi.isMariaDB()) {
			return row;
		}
		row.account_locked = 'N';
		const globalResult = await dbi.tryQuery(`SELECT * FROM \`mysql\`.\`global_priv\` ${condition}`);
		const globalRow = globalResult === false ? null : globalResult.fetchAssoc();
		if (globalRow === null) {
			return row;
		}
		let privileges: unknown;
		try {
			privileges = JSON.parse(globalRow.Priv ?? '[]');
		} catch {
			return row;
		}
		if (privileges !== null && typeof privileges === 'object' && !isEmpty((privileges as Record<string, unknown>).account_locked)) {
			row.account_locked = 'Y';
		}
		return row;
	}

	get post(): RequestParams {
		return this.context.request.post;
	}

	/** $_REQUEST, with $_GET changes applied below the POST values. */
	get request(): RequestParams {
		return { ...this.get, ...this.context.request.post };
	}

	server(): ServerFlavor {
		return { isMariaDb: this.context.dbi.isMariaDB(), version: this.context.dbi.getVersion() };
	}

	/** Privileges::extractPrivInfo(), filling table privileges from mysql.tables_priv's column type first. */
	async extractPrivInfo(row: PrivRow | null = null, enableHtml = false, tablePrivs = false): Promise<string[]> {
		let filled = row;
		if (row !== null && isSet(row.Table_priv)) {
			filled = await this.fillInTablePrivileges(row);
		}
		const env = { globals: this.globals, columnCount: this.request.column_count, grantCount: this.post.grant_count };
		return extractPrivInfoPure(filled, enableHtml, tablePrivs, env);
	}

	async fillInTablePrivileges(row: PrivRow): Promise<PrivRow> {
		if (this.tablePrivTypes === undefined) {
			const column = await this.context.dbi.fetchSingleRow('SHOW COLUMNS FROM `mysql`.`tables_priv` LIKE \'Table_priv\';');
			this.tablePrivTypes = parseTablePrivTypes(String(column?.Type ?? ''));
		}
		return fillInTablePrivileges(row, this.tablePrivTypes);
	}

	/** Privileges::getHtmlToDisplayPrivilegesTable(). */
	async getHtmlToDisplayPrivilegesTable(db = '*', tableName = '*', submit = true): Promise<string> {
		const { dbi } = this.context;
		const table = db === '*' ? '*' : tableName;
		let username = '';
		let hostname = '';
		let row: PrivRow | null = null;
		if (this.username !== null) {
			// getSqlQueryForDisplayPrivTable() takes a string, so a username without a hostname is a TypeError.
			if (this.hostname === null) {
				throw new PhpFatalError();
			}
			username = this.username;
			hostname = this.hostname;
			row = await dbi.fetchSingleRow(getSqlQueryForDisplayPrivTable(db, table, username, hostname));
		}
		if (row === null || Object.keys(row).length === 0) {
			if (table === '*' && await dbi.isSuperUser()) {
				row = {};
				const result = await dbi.query(`SHOW COLUMNS FROM \`mysql\`.${db === '*' ? '`user`' : '`db`'};`);
				for (let column = result.fetchRow(); column !== null; column = result.fetchRow()) {
					const name = String(column[0]);
					if (name.startsWith('max_')) {
						row[name] = 0;
					} else if (name.startsWith('x509_') || name.startsWith('ssl_')) {
						row[name] = '';
					} else {
						row[name] = 'N';
					}
				}
			} else if (table === '*') {
				row = {};
			} else {
				row = { Table_priv: '' };
			}
		}
		const columns = new Map<string, Record<string, boolean>>();
		if (isSet(row.Table_priv)) {
			row = await this.fillInTablePrivileges(row);
			const result = await dbi.tryQuery(`SHOW COLUMNS FROM ${backquote(unescapeMysqlWildcards(db))}.${backquote(table)};`);
			if (result !== false) {
				for (let column = result.fetchRow(); column !== null; column = result.fetchRow()) {
					columns.set(String(column[0]), { Select: false, Insert: false, Update: false, References: false });
				}
			}
		}
		if (columns.size > 0) {
			const result = await dbi.query(`SELECT \`Column_name\`, \`Column_priv\` FROM \`mysql\`.\`columns_priv\` WHERE \`User\` = '${escapeString(username)}' AND \`Host\` = '${escapeString(hostname)}' AND \`Db\` = '${escapeString(unescapeMysqlWildcards(db))}' AND \`Table_name\` = '${escapeString(table)}';`);
			for (let column = result.fetchRow(); column !== null; column = result.fetchRow()) {
				const name = String(column[0]);
				const privileges = columns.get(name) ?? {};
				for (const current of String(column[1]).split(',')) {
					privileges[current] = true;
				}
				columns.set(name, privileges);
			}
		}
		return this.render('server/privileges/privileges_table', {
			is_global: db === '*',
			is_database: table === '*',
			row: new Map(Object.entries(row)),
			columns,
			has_submit: submit,
			supports_references_privilege: !dbi.isMariaDB() && dbi.getVersion() >= 50622,
			is_mariadb: dbi.isMariaDB(),
		});
	}

	/** Privileges::getHtmlForRoutineSpecificPrivileges(). */
	async getHtmlForRoutineSpecificPrivileges(username: string, hostname: string, db: string, routine: string, urlDbname: string): Promise<string> {
		const { dbi } = this.context;
		const sql = `SELECT \`Proc_priv\` FROM \`mysql\`.\`procs_priv\` WHERE \`User\` = '${escapeString(username)}' AND \`Host\` = '${escapeString(hostname)}' AND \`Db\` = '${escapeString(unescapeMysqlWildcards(db))}' AND \`Routine_name\` LIKE '${escapeString(routine)}';`;
		const privileges = await dbi.fetchValue(sql);
		return this.render('server/privileges/edit_routine_privileges', {
			username,
			hostname,
			database: db,
			routine,
			privileges: parseProcPriv(privileges === false ? '' : privileges),
			dbname: urlDbname,
			current_user: await dbi.getCurrentUser(),
		});
	}

	/** Plugins::getAuthentication(). */
	async getAuthenticationPlugins(): Promise<Map<string, string>> {
		const result = await this.context.dbi.query('SELECT `PLUGIN_NAME`, `PLUGIN_DESCRIPTION` FROM `information_schema`.`PLUGINS` WHERE `PLUGIN_TYPE` = \'AUTHENTICATION\';');
		const plugins = new Map<string, string>();
		for (let row = result.fetchAssoc(); row !== null; row = result.fetchAssoc()) {
			plugins.set(String(row.PLUGIN_NAME), String(row.PLUGIN_DESCRIPTION ?? ''));
		}
		return plugins;
	}

	/** Privileges::getHtmlForLoginInformationFields(). */
	async getHtmlForLoginInformationFields(mode = 'new', user: string | null = null, host: string | null = null): Promise<string> {
		const { dbi } = this.context;
		const [usernameLength, hostnameLength] = await this.getUsernameAndHostnameLength();
		let predUsername: string | null = null;
		if (this.username === '') {
			predUsername = 'any';
		}
		const currentUser = await dbi.fetchValue('SELECT USER();');
		let thisHost: string | null = null;
		if (!isEmpty(currentUser)) {
			const value = String(currentUser);
			thisHost = value.slice(value.lastIndexOf('@') + 1).replaceAll('\'', '');
		}
		if (this.predHostname === null && this.hostname !== null) {
			switch (this.hostname.toLowerCase()) {
				case 'localhost':
				case '127.0.0.1': {
					this.predHostname = 'localhost';
					break;
				}
				case '%': {
					this.predHostname = 'any';
					break;
				}
				default: {
					this.predHostname = 'userdefined';
				}
			}
		}
		const server = this.server();
		const authPlugin = await this.getCurrentAuthenticationPlugin(mode, user, host);
		const isNew = (!server.isMariaDb && server.version >= 50507) || (server.isMariaDb && server.version >= 50200);
		return this.render('server/privileges/login_information_fields', {
			pred_username: predUsername,
			pred_hostname: this.predHostname,
			username_length: usernameLength,
			hostname_length: hostnameLength,
			username: this.username,
			new_username: null,
			hostname: this.hostname,
			this_host: thisHost,
			is_change: mode === 'change',
			auth_plugin: authPlugin,
			active_auth_plugins: await this.activeAuthPlugins(isNew),
			is_new: isNew,
		});
	}

	/** Privileges::getUsernameAndHostnameLength(). */
	async getUsernameAndHostnameLength(): Promise<[string | number, string | number]> {
		let usernameLength: string | number = 16;
		let hostnameLength: string | number = 41;
		const fields = await this.context.dbi.fetchResult('SELECT COLUMN_NAME, CHARACTER_MAXIMUM_LENGTH FROM information_schema.columns WHERE table_schema = \'mysql\' AND table_name = \'user\' AND COLUMN_NAME IN (\'User\', \'Host\')');
		for (const field of fields) {
			if (field.COLUMN_NAME === 'User') {
				usernameLength = field.CHARACTER_MAXIMUM_LENGTH ?? '';
			} else if (field.COLUMN_NAME === 'Host') {
				hostnameLength = field.CHARACTER_MAXIMUM_LENGTH ?? '';
			}
		}
		return [usernameLength, hostnameLength];
	}

	/** Privileges::getCurrentAuthenticationPlugin(). */
	async getCurrentAuthenticationPlugin(mode = 'new', username: string | null = null, hostname: string | null = null): Promise<string | null> {
		const { dbi } = this.context;
		let plugin: string | null = 'mysql_native_password';
		if (username !== null && hostname !== null && mode === 'change') {
			const row = await dbi.fetchSingleRow(`SELECT \`plugin\` FROM \`mysql\`.\`user\` WHERE \`User\` = "${escapeString(username)}" AND \`Host\` = "${escapeString(hostname)}" LIMIT 1`);
			if (isSet(row?.plugin)) {
				plugin = String(row?.plugin);
			}
		} else if (mode === 'change') {
			const [user = '', host = ''] = await dbi.getCurrentUserAndHost();
			const row = await dbi.fetchSingleRow(`SELECT \`plugin\` FROM \`mysql\`.\`user\` WHERE \`User\` = "${escapeString(user)}" AND \`Host\` = "${escapeString(host)}"`);
			if (isSet(row?.plugin)) {
				plugin = String(row?.plugin);
			}
		} else if (dbi.getVersion() >= 50702) {
			const row = await dbi.fetchSingleRow('SELECT @@default_authentication_plugin');
			plugin = row === null ? null : row['@@default_authentication_plugin'] ?? null;
		}
		return plugin;
	}

	/** Privileges::getGrants(). */
	async getGrants(user: string, host: string): Promise<string> {
		const grants = await this.context.dbi.fetchResult<string>(`SHOW GRANTS FOR '${escapeString(user)}'@'${escapeString(host)}'`);
		return grants.map(grant => `${String(grant)};\n\n`).join('');
	}

	/** Privileges::getHtmlForAddUser(). */
	async getHtmlForAddUser(dbname: string): Promise<string> {
		const isGrantUser = await this.context.dbi.isGrantUser();
		const loginInformationFieldsNew = await this.getHtmlForLoginInformationFields('new');
		let privilegesTable = '';
		if (isGrantUser) {
			privilegesTable = await this.getHtmlToDisplayPrivilegesTable('*', '*', false);
		}
		return this.render('server/privileges/add_user', {
			database: dbname,
			login_information_fields_new: loginInformationFieldsNew,
			is_grant_user: isGrantUser,
			privileges_table: privilegesTable,
		});
	}

	/** Privileges::getAllPrivileges(): who has access to a database or table, for the checkprivsdb views. */
	async getAllPrivileges(db: string, table = ''): Promise<Map<string, Record<string, unknown>>> {
		const all = [...await this.getGlobalAndDatabasePrivileges(db)];
		if (table !== '') {
			all.push(...await this.getTablePrivileges(db, table));
		}
		all.push(...await this.getRoutinesPrivileges(db));
		const privileges = new Map<string, { user: string; host: string; privileges: unknown[]; }>();
		for (const privilege of all) {
			const user = String(privilege.User ?? '');
			const host = String(privilege.Host ?? '');
			const entry = privileges.get(`${user}@${host}`) ?? { user, host, privileges: [] };
			entry.privileges.push(await this.getSpecificPrivilege(privilege));
			privileges.set(`${user}@${host}`, entry);
		}
		return privileges;
	}

	/** Privileges::getUserLink(). */
	async getUserLink(linkType: 'edit' | 'revoke' | 'export', username: string, hostname: string, dbname = '', tablename = '', routinename = '', initial = ''): Promise<string> {
		let linkClass = '';
		const params: Record<string, unknown> = { username, hostname };
		let action = { icon: 'b_usredit', text: 'Edit privileges' };
		if (linkType === 'edit') {
			linkClass = 'edit_user_anchor';
			Object.assign(params, { dbname, tablename, routinename });
		} else if (linkType === 'revoke') {
			Object.assign(params, { dbname, tablename, routinename, revokeall: 1 });
			action = { icon: 'b_usrdrop', text: 'Revoke' };
		} else {
			linkClass = 'export_user_anchor ajax';
			Object.assign(params, { initial, export: 1 });
			action = { icon: 'b_tblexport', text: 'Export' };
		}
		return this.render('server/privileges/get_user_link', {
			link_class: linkClass,
			is_revoke: linkType === 'revoke',
			url_params: params,
			action,
		});
	}

	/** Privileges::getUserSpecificRights(). */
	async getUserSpecificRights(username: string, hostname: string, type: string, dbname = ''): Promise<Map<string, PrivRow>> {
		const { dbi } = this.context;
		const mysqlTables = await this.getMysqlTables();
		const { union, main, key } = userSpecificRightsQueries(username, hostname, type, dbname, mysqlTables);
		const defaults: PrivRow = { [key]: '', Grant_priv: 'N', privs: ['USAGE'], Column_priv: true };
		const rights = new Map<string, PrivRow>();
		const unionResult = await dbi.query(union);
		for (let row = unionResult.fetchAssoc(); row !== null; row = unionResult.fetchAssoc()) {
			const merged: PrivRow = { ...defaults, ...row };
			if (type === 'database') {
				merged.Db = escapeMysqlWildcards(merged.Db);
			}
			rights.set(String(merged[key]), merged);
		}
		const result = await dbi.query(main);
		for (let row = result.fetchAssoc(); row !== null; row = result.fetchAssoc()) {
			const name = String(row[key]);
			rights.set(name, { ...rights.get(name), ...row });
			if (type !== 'database') {
				continue;
			}
			const db = String(row.Db);
			rights.set(db, { ...rights.get(db), can_delete: true });
		}
		return rights;
	}

	/** Privileges::getHtmlForAllTableSpecificRights(). */
	async getHtmlForAllTableSpecificRights(username: string, hostname: string, type: 'database' | 'table' | 'routine', dbname = ''): Promise<string> {
		const { dbi } = this.context;
		const uiData = {
			database: { form_id: 'database_specific_priv', sub_menu_label: 'Database', legend: 'Database-specific privileges', type_label: 'Database' },
			table: { form_id: 'table_specific_priv', sub_menu_label: 'Table', legend: 'Table-specific privileges', type_label: 'Table' },
			routine: { form_id: 'routine_specific_priv', sub_menu_label: 'Routine', legend: 'Routine-specific privileges', type_label: 'Routine' },
		};
		const rights = ksort(await this.getUserSpecificRights(username, hostname, type, dbname));
		const foundRows: string[] = [];
		const privileges: Record<string, unknown>[] = [];
		const isGrantUser = await dbi.isGrantUser();
		for (const row of rights.values()) {
			const one: Record<string, unknown> = {};
			let name: string;
			let paramDbName: string;
			let paramTableName = '';
			let paramRoutineName = '';
			if (type === 'database') {
				name = String(row.Db);
				one.grant = row.Grant_priv === 'Y';
				one.table_privs = !isEmpty(row.Table_priv) || !isEmpty(row.Column_priv);
				const privs = await this.extractPrivInfo(row, true);
				one.privileges = privs.join(',');
				paramDbName = name;
			} else if (type === 'table') {
				name = String(row.Table_name);
				one.grant = String(row.Table_priv ?? '').split(',').includes('Grant');
				one.column_privs = !isEmpty(row.Column_priv);
				const privs = await this.extractPrivInfo(row, true);
				one.privileges = privs.join(',');
				paramDbName = escapeMysqlWildcards(dbname);
				paramTableName = name;
			} else {
				name = String(row.Routine_name);
				one.grant = String(row.Proc_priv ?? '').split(',').includes('Grant');
				const privs = await this.extractPrivInfo(parseProcPriv(row.Proc_priv), true);
				one.privileges = privs.join(',');
				paramDbName = escapeMysqlWildcards(dbname);
				paramRoutineName = name;
			}
			foundRows.push(name);
			one.name = name;
			one.edit_link = '';
			if (isGrantUser) {
				one.edit_link = await this.getUserLink('edit', username, hostname, paramDbName, paramTableName, paramRoutineName);
			}
			one.revoke_link = '';
			if (type !== 'database' || !isEmpty(row.can_delete)) {
				one.revoke_link = await this.getUserLink('revoke', username, hostname, paramDbName, paramTableName, paramRoutineName);
			}
			privileges.push(one);
		}
		const data: Record<string, unknown> = { ...uiData[type], privileges, username, hostname, database: dbname, type };
		const found = (value: string): boolean => foundRows.some(row => looseStringEquals(row, value));
		if (type === 'database') {
			const databases: string[] = [];
			const escapedDatabases: string[] = [];
			for (const currentDb of await dbi.getDatabaseList()) {
				if (currentDb === 'information_schema' || currentDb === 'performance_schema') {
					continue;
				}
				const escaped = escapeMysqlWildcards(currentDb);
				if (found(escaped)) {
					continue;
				}
				databases.push(currentDb);
				escapedDatabases.push(escaped);
			}
			data.databases = databases;
			data.escaped_databases = escapedDatabases;
		} else if (type === 'table') {
			const result = await dbi.tryQuery(`SHOW TABLES FROM ${backquote(dbname)}`);
			const tables: string[] = [];
			if (result !== false) {
				for (let row = result.fetchRow(); row !== null; row = result.fetchRow()) {
					if (!found(String(row[0]))) {
						tables.push(String(row[0]));
					}
				}
			}
			data.tables = tables;
		} else {
			const routines = await getRoutines(this.context, dbname);
			data.routines = routines.map(routine => routine.name).filter(routine => !found(routine));
		}
		return this.render('server/privileges/privileges_summary', data);
	}

	/** Privileges::getUsersOverview(). */
	async getUsersOverview(rows: DbiRow[], dbRights: Map<string, Map<string, PrivRow>>, textDir: string): Promise<string> {
		const { dbi } = this.context;
		for (const row of rows) {
			const entry: PrivRow = { ...row, privs: await this.extractPrivInfo(row, true) };
			const user = String(row.User);
			const hosts = dbRights.get(user) ?? new Map<string, PrivRow>();
			hosts.set(String(row.Host), entry);
			dbRights.set(user, hosts);
		}
		const hasAccountLocking = (dbi.isMariaDB() && dbi.getVersion() >= 100402) || (!dbi.isMariaDB() && dbi.getVersion() >= 50706);
		const hosts: Record<string, unknown>[] = [];
		for (const user of dbRights.values()) {
			for (const host of ksort(user).values()) {
				const account = await this.getAccountRow(String(host.User), String(host.Host), hasAccountLocking);
				hosts.push({
					user: host.User,
					host: host.Host,
					has_password: rowHasPassword(account),
					has_select_priv: isSet(host.Select_priv),
					privileges: host.privs,
					group: '',
					has_grant: host.Grant_priv === 'Y',
					is_account_locked: account?.account_locked === 'Y',
				});
			}
		}
		return this.render('server/privileges/users_overview', {
			menus_work: false,
			user_group_count: 0,
			text_dir: textDir,
			initial: this.get.initial ?? '',
			hosts,
			is_grantuser: await dbi.isGrantUser(),
			is_createuser: await dbi.isCreateUser(),
			has_account_locking: hasAccountLocking,
		});
	}

	/** Privileges::getHtmlForInitials(). */
	async getHtmlForInitials(): Promise<string> {
		const initials = new Map<string, boolean>();
		for (let letter = 1; letter < 27; letter++) {
			initials.set(String.fromCodePoint(letter + 64), false);
		}
		const result = await this.context.dbi.tryQuery('SELECT DISTINCT UPPER(LEFT(`User`,1)) FROM `user` ORDER BY UPPER(LEFT(`User`,1)) ASC');
		if (result !== false) {
			for (let row = result.fetchRow(); row !== null; row = result.fetchRow()) {
				initials.set(row[0] ?? '', true);
			}
		}
		const sorted = [...initials].toSorted(([left], [right]) => strnatcasecmp(left, right));
		return this.render('server/privileges/initials_row', {
			array_initials: new Map(sorted.map(([key, found]) => [phpArrayKey(key), found])),
			initial: this.get.initial ?? null,
			viewing_mode: this.get.viewing_mode ?? null,
		});
	}

	/** Privileges::getDbRightsForUserOverview(). */
	async getDbRightsForUserOverview(): Promise<Map<string, Map<string, PrivRow>>> {
		const { dbi } = this.context;
		const mysqlTables = await this.getMysqlTables();
		const range = this.rangeForInitial();
		const result = await dbi.query(dbRightsForUserOverviewQuery(mysqlTables, range));
		const rights = new Map<string, Map<string, PrivRow>>();
		for (let row = result.fetchAssoc(); row !== null; row = result.fetchAssoc()) {
			const merged: PrivRow = { User: '', Host: '%', Password: '?', Grant_priv: 'N', privs: ['USAGE'], ...row };
			const user = String(merged.User);
			const hosts = rights.get(user) ?? new Map<string, PrivRow>();
			hosts.set(String(merged.Host), merged);
			rights.set(user, hosts);
		}
		return ksort(rights);
	}

	/** Privileges::getAddUserHtmlFieldset() as getHtmlForUserOverview() calls it, without a database. */
	async getAddUserHtmlFieldset(): Promise<string> {
		if (!await this.context.dbi.isCreateUser()) {
			return '';
		}
		return this.render('server/privileges/add_user_fieldset', { url_params: { adduser: 1 }, rel_params: [] });
	}

	/** Privileges::getHtmlForUserOverview(). */
	async getHtmlForUserOverview(textDir: string): Promise<string> {
		const { context } = this;
		const { dbi, request, response } = context;
		const state = generatorState(context);
		const initial = this.get.initial;
		const [sqlQuery, sqlQueryAll] = userOverviewQueries(this.server(), this.rangeForInitial());
		let result = await dbi.tryQuery(sqlQuery);
		const resultAll = await dbi.tryQuery(sqlQueryAll);
		let errorMessages = '';
		let emptyUserNotice = '';
		let initials = '';
		let usersOverview = '';
		let flushNotice = '';
		if (result === false) {
			result = await dbi.tryQuery('SELECT * FROM `mysql`.`user`');
			if (result === false) {
				errorMessages += Message.error('Not enough privilege to view users.').getDisplay(state);
				errorMessages += await this.getAddUserHtmlFieldset();
			} else {
				const raw = 'Your privilege table structure seems to be older than this MySQL version!<br>Please run the <code>mysql_upgrade</code> command that should be included in your MySQL server distribution to solve this problem!';
				errorMessages += Message.rawError(raw).getDisplay(state);
			}
		} else {
			const dbRights = await this.getDbRightsForUserOverview();
			const hasAnyLocalhost = dbRights.values().some(hosts => hosts.values().some(account => isEmpty(account.User) && account.Host === 'localhost'));
			if (hasAnyLocalhost) {
				emptyUserNotice = Message.notice(`A user account allowing any user from localhost to connect is present. This will prevent other users from connecting if the host part of their account allows a connection from any (%) host.${showMySQLDocumentation(state, 'problems-connecting')}`).getDisplay(state);
			}
			if (resultAll !== false && resultAll.numRows() > 20) {
				initials = await this.getHtmlForInitials();
			}
			if (initial !== undefined || this.get.showall !== undefined || result.numRows() < 50) {
				usersOverview = await this.getUsersOverview(result.fetchAllAssoc(), dbRights, textDir);
				usersOverview += await this.render('export_modal', {});
			}
			if (!response.isAjax || !isEmpty(request.params.ajax_page_request)) {
				let flushnote: Message;
				const userPrivileges = await dbi.getUserPrivileges();
				if (userPrivileges.isReloadPriv) {
					flushnote = new Message('Note: phpMyAdmin gets the users’ privileges directly from MySQL’s privilege tables. The content of these tables may differ from the privileges the server uses, if they have been changed manually. In this case, you should %sreload the privileges%s before you continue.');
					flushnote.addParamHtml(`<a href="${getFromRoute(context.urlState(), '/server/privileges', { flush_privileges: 1 })}" id="reload_privileges_anchor">`);
					flushnote.addParamHtml('</a>');
				} else {
					flushnote = new Message(`Note: phpMyAdmin gets the users’ privileges directly from MySQL’s privilege tables. The content of these tables may differ from the privileges the server uses, if they have been changed manually. In this case, the privileges have to be reloaded but currently, you don't have the RELOAD privilege.${showMySQLDocumentation(state, 'privileges-provided', false, null, null, 'priv_reload')}`);
				}
				flushNotice = flushnote.getDisplay(state);
			}
		}
		return this.render('server/privileges/user_overview', {
			error_messages: errorMessages,
			empty_user_notice: emptyUserNotice,
			initials,
			users_overview: usersOverview,
			is_createuser: await dbi.isCreateUser(),
			flush_notice: flushNotice,
		});
	}

	/** Privileges::getHtmlForUserProperties(). */
	async getHtmlForUserProperties(dbnameIsWildcard: boolean, urlDbname: string, username: string, hostname: string, dbname: string | string[], tablename: string): Promise<string> {
		const { context } = this;
		const { dbi, config } = context;
		const exists = await dbi.fetchValue(`SELECT '1' FROM \`mysql\`.\`user\` WHERE \`User\` = '${escapeString(username)}' AND \`Host\` = '${escapeString(hostname)}';`);
		const userDoesNotExist = isEmpty(exists);
		let loginInformationFields = '';
		if (userDoesNotExist) {
			loginInformationFields = await this.getHtmlForLoginInformationFields();
		}
		const params: Record<string, unknown> = { username, hostname, dbname };
		if (!Array.isArray(dbname) && dbname !== '' && tablename !== '') {
			params.tablename = tablename;
		}
		let privilegesDb = '*';
		if (typeof dbname === 'string' && dbname !== '') {
			privilegesDb = dbname;
		} else if (Array.isArray(dbname)) {
			privilegesDb = String(dbname[0]);
		}
		const privilegesTable = await this.getHtmlToDisplayPrivilegesTable(privilegesDb, tablename === '' ? '*' : tablename);
		let tableSpecificRights = '';
		if (!Array.isArray(dbname) && tablename === '' && !dbnameIsWildcard) {
			if (dbname === '') {
				tableSpecificRights += await this.getHtmlForAllTableSpecificRights(username, hostname, 'database');
			} else {
				const unescapedDb = unescapeMysqlWildcards(dbname);
				tableSpecificRights += await this.getHtmlForAllTableSpecificRights(username, hostname, 'table', unescapedDb);
				tableSpecificRights += await this.getHtmlForAllTableSpecificRights(username, hostname, 'routine', unescapedDb);
			}
		}
		const url = context.urlState();
		let changePassword = '';
		let changeLoginInfoFields = '';
		if (!Array.isArray(dbname) && dbname === '' && !userDoesNotExist) {
			changePassword = await this.getFormForChangePassword(username, hostname, true);
			changeLoginInfoFields = await this.getHtmlForLoginInformationFields('change', username, hostname);
		}
		return this.render('server/privileges/user_properties', {
			user_does_not_exists: userDoesNotExist,
			login_information_fields: loginInformationFields,
			params,
			privileges_table: privilegesTable,
			table_specific_rights: tableSpecificRights,
			change_password: changePassword,
			database: dbname,
			dbname: urlDbname,
			username,
			hostname,
			is_databases: dbnameIsWildcard || (Array.isArray(dbname) && dbname.length > 1),
			is_wildcard: dbnameIsWildcard,
			table: tablename,
			current_user: await dbi.getCurrentUser(),
			user_group: null,
			change_login_info_fields: changeLoginInfoFields,
			database_url: getScriptNameForOption(url, config.DefaultTabDatabase, 'database'),
			database_url_title: getTitleForTarget(config.DefaultTabDatabase),
			table_url: getScriptNameForOption(url, config.DefaultTabTable, 'table'),
			table_url_title: getTitleForTarget(config.DefaultTabTable),
		});
	}

	/** Privileges::getFormForChangePassword() on the privileges route. */
	async getFormForChangePassword(username: string, hostname: string, editOthers: boolean): Promise<string> {
		const { dbi } = this.context;
		const server = this.server();
		const origAuthPlugin = await this.getCurrentAuthenticationPlugin('change', username, hostname);
		const isNew = (!server.isMariaDb && server.version >= 50507) || (server.isMariaDb && server.version >= 50200);
		const hasMoreAuthPlugins = (!server.isMariaDb && server.version >= 50706) || (await dbi.isSuperUser() && editOthers);
		return this.render('server/privileges/change_password', {
			username,
			hostname,
			is_privileges: this.context.route === '/server/privileges',
			is_new: isNew,
			has_more_auth_plugins: hasMoreAuthPlugins,
			active_auth_plugins: await this.activeAuthPlugins(isNew && hasMoreAuthPlugins),
			orig_auth_plugin: origAuthPlugin,
		});
	}

	/** Privileges::getRoutineType(). */
	async getRoutineType(dbname: string, routineName: string): Promise<string> {
		const name = routineName.toLowerCase();
		const routines = await getRoutines(this.context, dbname);
		const routine = routines.find(item => item.name.toLowerCase() === name);
		return routine?.type ?? '';
	}

	/** Generator::getMessage('', $sqlQuery) for the AJAX extra data. */
	sqlQueryBox(sqlQuery: string): Promise<string> {
		return getMessage(this.context, '', { sqlQuery });
	}

	/** Whether the global $dbname has an unescaped wildcard, for getExtraDataForAjaxBehavior(). */
	dbnameIsWildcard(): boolean | undefined {
		if (this.dbname === null) {
			return undefined;
		}
		return isWildcardDbname(String(this.dbname));
	}
}

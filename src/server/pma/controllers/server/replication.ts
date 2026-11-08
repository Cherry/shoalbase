// Port of ReplicationController's superuser path and PhpMyAdmin\ReplicationGui: replication status, primary and replica setup and replica control.
import { renderServerTemplate } from './render.ts';
import { type ReplicationInfo, loadReplicationInfo } from './replication-info.ts';
import { isSystemSchema } from '../../../../lib/pma/dbi-sql.ts';
import { Message } from '../../../../lib/pma/message.ts';
import { phpEmpty } from '../../../../lib/pma/server/php.ts';
import {
	controlMessages,
	predefinedHostname,
	replicaControlLinks,
	replicaControlStatement,
	replicaThreadsRunning,
	resetReplicaStatement,
	showAllReplicasStatement,
	showReplicasStatement,
	skipCounterStatement,
	skipErrorsCount,
	statusTableVariables,
	thisHost,
	usernameHostnameLength,
} from '../../../../lib/pma/server/replication-gui.ts';
import { nestedParams } from '../../../../lib/pma/table-data/php-params.ts';
import { getCommon } from '../../../../lib/twig/url.ts';
import { commonUrlParams, internalErrorPage } from '../database/common.ts';

import type { PmaContext } from '../../core/context.ts';
import type { DbiRow } from '../../core/dbi.ts';

/** $GLOBALS['urlParams'], which ReplicationInfo::load() extends with the selected MariaDB connection. */
interface PageState {
	urlParams: Record<string, unknown>;
}

const flavourOf = (context: PmaContext) => { return { isMariaDB: context.dbi.isMariaDB(), version: context.dbi.getVersion() }; };

/** ReplicationInfo::load($_POST['primary_connection'] ?? null), including its $urlParams side effect. */
async function loadInfo(context: PmaContext, state?: PageState): Promise<ReplicationInfo> {
	const connection = context.request.post.primary_connection;
	const info = await loadReplicationInfo(context, connection);
	if (state !== undefined && info.multiPrimaryStatus.length > 0) {
		state.urlParams.primary_connection = connection;
	}
	return info;
}

/** ReplicationGui::getHtmlForReplicationStatusTable(); the status page calls it with the defaults. */
export async function replicationStatusTable(
	context: PmaContext,
	type: 'primary' | 'replica',
	isHidden = false,
	hasTitle = true,
	state?: PageState,
): Promise<string> {
	const info = await loadInfo(context, state);
	let row: DbiRow | undefined = info.primaryStatus[0];
	if (type === 'replica') {
		row = info.replicaStatus[0];
	}
	return renderServerTemplate(context, 'server/replication/status_table', {
		type,
		is_hidden: isHidden,
		has_title: hasTitle,
		variables: statusTableVariables(type, row),
	});
}

function replicationSession(context: PmaContext): Record<string, unknown> {
	const { data } = context.session;
	if (typeof data.replication !== 'object' || data.replication === null) {
		data.replication = {};
	}
	return data.replication as Record<string, unknown>;
}

/** Replication::replicaControl(); false covers both a failed query and upstream's -1 for an unknown action. */
async function replicaControl(context: PmaContext, action: string, control: string | null): Promise<boolean> {
	const statement = replicaControlStatement(action, control, flavourOf(context));
	if (statement === null) {
		return false;
	}
	return await context.dbi.tryQuery(statement) !== false;
}

/** ReplicationGui::handleRequestForReplicaServerControl(); null where strict types throw a TypeError. */
async function replicaServerControl(context: PmaContext): Promise<boolean | null> {
	const { dbi, request } = context;
	const action = request.post.sr_replica_action;
	if (action === 'reset') {
		const stopped = await replicaControl(context, 'STOP', null);
		const reset = await dbi.tryQuery(resetReplicaStatement(flavourOf(context)));
		const started = await replicaControl(context, 'START', null);
		return stopped && reset !== false && started;
	}
	const control = request.post.sr_replica_control_param;
	if (typeof action !== 'string' || Array.isArray(control)) {
		return null;
	}
	return replicaControl(context, action, control ?? null);
}

/** ReplicationGui::handleRequestForReplicaSkipError() without its unused result; null when PHP cannot multiply the count. */
async function replicaSkipError(context: PmaContext): Promise<null | undefined> {
	const count = skipErrorsCount(context.request.post.sr_skip_errors_count);
	if (count === null) {
		return null;
	}
	await replicaControl(context, 'STOP', null);
	await context.dbi.tryQuery(skipCounterStatement(flavourOf(context), count));
	await replicaControl(context, 'START', null);
	return undefined;
}

/** ReplicationGui::handleControlRequest(); a Response is the fatal page of a TypeError. */
async function handleControlRequest(context: PmaContext, state: PageState): Promise<Response | null> {
	const { request, response } = context;
	const { post } = request;
	if (post.sr_take_action === undefined) {
		return null;
	}
	if (post.replica_changeprimary !== undefined) {
		// The port never enables $cfg['AllowArbitraryServer'], so changing the primary always stops here as upstream does without it.
		const session = replicationSession(context);
		session.sr_action_status = 'error';
		session.sr_action_info = 'Connection to server is disabled, please enable $cfg[\'AllowArbitraryServer\'] in phpMyAdmin configuration.';
		return null;
	}
	if (post.sr_replica_server_control !== undefined) {
		const result = await replicaServerControl(context);
		if (result === null) {
			return internalErrorPage(context, 'TypeError');
		}
		const messages = controlMessages(post.sr_replica_action);
		if (response.isAjax) {
			response.setRequestStatus(result);
			response.addJSON('message', result ? Message.success(messages.success) : Message.error(messages.error));
		} else {
			// Core::sendHeaderLocation() only adds the header; the page still renders behind the redirect.
			response.header('Location', `/index.php?route=/server/replication${getCommon(context.urlState(), state.urlParams, '&')}`);
		}
		return null;
	}
	if (post.sr_replica_skip_error !== undefined && await replicaSkipError(context) === null) {
		return internalErrorPage(context, 'TypeError');
	}
	return null;
}

/** ReplicationGui::getHtmlForErrorMessage(): shows the stored action result once. */
function errorMessageHtml(context: PmaContext): string {
	const session = context.session.data.replication as Record<string, unknown> | undefined;
	const status = session?.sr_action_status;
	const info = session?.sr_action_info;
	if (session === undefined || status === undefined || status === null || info === undefined || info === null) {
		return '';
	}
	if (status === 'error') {
		session.sr_action_status = 'unknown';
		return Message.error(String(info)).getDisplay();
	}
	if (status === 'success') {
		session.sr_action_status = 'unknown';
		return Message.success(String(info)).getDisplay();
	}
	return '';
}

async function userHostLengths(context: PmaContext): Promise<{ username: number; hostname: number; }> {
	const columns = await context.dbi.getColumns('mysql', 'user');
	return usernameHostnameLength(columns.values());
}

/** ReplicationGui::getHtmlForReplicationPrimaryAddReplicaUser(). */
async function addReplicaUserHtml(context: PmaContext): Promise<string> {
	const { dbi, request } = context;
	const { username, hostname } = request.post;
	const lengths = await userHostLengths(context);
	let predefinedUsername = '';
	if (username === '') {
		predefinedUsername = 'any';
	}
	let usernameValue: unknown = '';
	if (!phpEmpty(username)) {
		usernameValue = username;
	}
	let predefinedHost = '';
	if (hostname !== undefined) {
		predefinedHost = predefinedHostname(hostname);
	}
	return renderServerTemplate(context, 'server/replication/primary_add_replica_user', {
		username_length: lengths.username,
		hostname_length: lengths.hostname,
		has_username: username !== undefined,
		username: usernameValue,
		hostname: hostname ?? '',
		predefined_username: predefinedUsername,
		predefined_hostname: predefinedHost,
		this_host: thisHost(await dbi.fetchValue('SELECT USER();')),
	});
}

/** ReplicationGui::getHtmlForPrimaryReplication(). */
async function primaryReplicationHtml(context: PmaContext, state: PageState): Promise<string> {
	const { dbi, request } = context;
	const clearScreen = request.post.repl_clear_scr !== undefined;
	let statusTable = '';
	let replicas: DbiRow[] = [];
	let urlParams: Record<string, unknown> = {};
	if (!clearScreen) {
		statusTable = await replicationStatusTable(context, 'primary', true, false, state);
		replicas = await dbi.fetchResult(showReplicasStatement(flavourOf(context)));
		urlParams = { ...state.urlParams, primary_add_user: true, repl_clear_scr: true };
	}
	let addReplicaUser = '';
	if (request.post.primary_add_user !== undefined) {
		addReplicaUser = await addReplicaUserHtml(context);
	}
	return renderServerTemplate(context, 'server/replication/primary_replication', {
		clear_screen: clearScreen,
		primary_status_table: statusTable,
		replicas,
		url_params: urlParams,
		primary_add_user: request.post.primary_add_user !== undefined,
		primary_add_replica_user: addReplicaUser,
	});
}

/** ReplicationGui::getHtmlForPrimaryConfiguration() with getHtmlForReplicationDbMultibox(). */
async function primaryConfigurationHtml(context: PmaContext): Promise<string> {
	const databaseList = await context.dbi.getDatabaseList();
	const databases = databaseList.filter(database => !isSystemSchema(database));
	const multibox = await renderServerTemplate(context, 'server/replication/database_multibox', { databases });
	return renderServerTemplate(context, 'server/replication/primary_configuration', { database_multibox: multibox });
}

/** ReplicationGui::getHtmlForReplicaConfiguration(); the thread flags come from the status read before any control action. */
async function replicaConfigurationHtml(context: PmaContext, state: PageState, info: ReplicationInfo): Promise<string> {
	const { dbi, request } = context;
	const multiStatement = showAllReplicasStatement(flavourOf(context));
	let multiReplication: DbiRow[] = [];
	if (multiStatement !== null) {
		multiReplication = await dbi.fetchResult(multiStatement);
	}
	const isReplica = info.replicaInfo.status;
	let running = { io: false, sql: false };
	let links: ReturnType<typeof replicaControlLinks> | null = null;
	let statusTable = '';
	if (isReplica) {
		running = replicaThreadsRunning(info.replicaStatus[0]);
		links = replicaControlLinks(context.urlState(), state.urlParams, running);
		statusTable = await replicationStatusTable(context, 'replica', true, false, state);
	}
	return renderServerTemplate(context, 'server/replication/replica_configuration', {
		server_replica_multi_replication: multiReplication,
		url_params: state.urlParams,
		primary_connection: request.post.primary_connection ?? '',
		server_replica_status: isReplica,
		replica_status_table: statusTable,
		// Upstream passes the two flags swapped.
		replica_sql_running: running.io,
		replica_io_running: running.sql,
		replica_control_full_link: links?.full ?? '',
		replica_control_reset_link: links?.reset ?? '',
		replica_control_sql_link: links?.sql ?? '',
		replica_control_io_link: links?.io ?? '',
		replica_skip_error_link: links?.skipError ?? '',
		reconfigure_primary_link: links?.reconfigurePrimary ?? '',
		has_replica_configure: request.post.replica_configure !== undefined,
	});
}

/** ReplicationGui::getHtmlForReplicationChangePrimary(). */
async function changePrimaryHtml(context: PmaContext, submitName: string): Promise<string> {
	const lengths = await userHostLengths(context);
	return renderServerTemplate(context, 'server/replication/change_primary', {
		server_id: Math.floor(Date.now() / 1000),
		username_length: lengths.username,
		hostname_length: lengths.hostname,
		submit_name: submitName,
	});
}

/** ReplicationController::__invoke() for a superuser, after the mysql database is selected and the scripts are added. */
export async function replicationAdministration(context: PmaContext): Promise<Response> {
	const { request, response } = context;
	const { post } = request;
	const state: PageState = { urlParams: commonUrlParams(context) };
	const info = await loadInfo(context, state);
	const postedUrlParams = nestedParams(post).url_params;
	if (typeof postedUrlParams === 'object') {
		state.urlParams = { ...postedUrlParams };
	}
	const fatal = await handleControlRequest(context, state);
	if (fatal !== null) {
		return fatal;
	}
	const errorMessages = errorMessageHtml(context);
	let primaryReplication = '';
	if (info.primaryInfo.status) {
		primaryReplication = await primaryReplicationHtml(context, state);
	}
	let primaryConfiguration = '';
	let replicaConfiguration = '';
	let changePrimary = '';
	if (post.primary_configure !== undefined) {
		primaryConfiguration = await primaryConfigurationHtml(context);
	} else {
		if (post.repl_clear_scr === undefined) {
			replicaConfiguration = await replicaConfigurationHtml(context, state, info);
		}
		if (post.replica_configure !== undefined) {
			changePrimary = await changePrimaryHtml(context, 'replica_changeprimary');
		}
	}
	response.addHTML(await renderServerTemplate(context, 'server/replication/index', {
		url_params: state.urlParams,
		is_super_user: true,
		error_messages: errorMessages,
		is_primary: info.primaryInfo.status,
		primary_configure: post.primary_configure ?? null,
		replica_configure: post.replica_configure ?? null,
		clear_screen: post.repl_clear_scr ?? null,
		primary_replication_html: primaryReplication,
		primary_configuration_html: primaryConfiguration,
		replica_configuration_html: replicaConfiguration,
		change_primary_html: changePrimary,
	}));
	return response.response();
}

// Pure parts of PhpMyAdmin\ReplicationGui, Replication and ReplicationInfo's variable lists for the replication admin page.
import { type UrlState, getCommon } from '../../twig/url.ts';
import { phpFloatString } from '../export-import/import-analysis.ts';

type StatusRow = Record<string, string | null>;

interface ServerFlavour {
	isMariaDB: boolean;
	version: number;
}

/** ReplicationInfo::$primaryVariables. */
export const PRIMARY_VARIABLES = ['File', 'Position', 'Binlog_Do_DB', 'Binlog_Ignore_DB'];

/** ReplicationInfo::$replicaVariables. */
export const REPLICA_VARIABLES = [
	'Slave_IO_State',
	'Replica_IO_State',
	'Master_Host',
	'Source_Host',
	'Master_User',
	'Source_User',
	'Master_Port',
	'Source_Port',
	'Connect_Retry',
	'Master_Log_File',
	'Source_Log_File',
	'Read_Master_Log_Pos',
	'Read_Source_Log_Pos',
	'Relay_Log_File',
	'Relay_Log_Pos',
	'Relay_Master_Log_File',
	'Relay_Source_Log_File',
	'Slave_IO_Running',
	'Replica_IO_Running',
	'Slave_SQL_Running',
	'Replica_SQL_Running',
	'Replicate_Do_DB',
	'Replicate_Ignore_DB',
	'Replicate_Do_Table',
	'Replicate_Ignore_Table',
	'Replicate_Wild_Do_Table',
	'Replicate_Wild_Ignore_Table',
	'Last_Errno',
	'Last_Error',
	'Skip_Counter',
	'Exec_Master_Log_Pos',
	'Exec_Source_Log_Pos',
	'Relay_Log_Space',
	'Until_Condition',
	'Until_Log_File',
	'Until_Log_Pos',
	'Master_SSL_Allowed',
	'Source_SSL_Allowed',
	'Master_SSL_CA_File',
	'Source_SSL_CA_File',
	'Master_SSL_CA_Path',
	'Source_SSL_CA_Path',
	'Master_SSL_Cert',
	'Source_SSL_Cert',
	'Master_SSL_Cipher',
	'Source_SSL_Cipher',
	'Master_SSL_Key',
	'Source_SSL_Key',
	'Seconds_Behind_Master',
	'Seconds_Behind_Source',
];

const WRAPPED_VARIABLES = new Set([
	'Replicate_Do_DB',
	'Replicate_Ignore_DB',
	'Replicate_Do_Table',
	'Replicate_Ignore_Table',
	'Replicate_Wild_Do_Table',
	'Replicate_Wild_Ignore_Table',
]);

const THREAD_VARIABLES = new Set(['Slave_IO_Running', 'Slave_SQL_Running', 'Replica_IO_Running', 'Replica_SQL_Running']);

export interface StatusVariable {
	name: string;
	status: '' | 'text-danger' | 'text-success';
	value: string;
}

/** The variables ReplicationGui::getHtmlForReplicationStatusTable() lists; isset() skips NULL columns. */
export function statusTableVariables(type: 'primary' | 'replica', row: StatusRow | undefined): StatusVariable[] {
	const names = type === 'replica' ? REPLICA_VARIABLES : PRIMARY_VARIABLES;
	const variables: StatusVariable[] = [];
	for (const name of names) {
		const value = row?.[name];
		if (value === undefined || value === null) {
			continue;
		}
		const variable: StatusVariable = { name, status: '', value };
		if (type === 'replica' && THREAD_VARIABLES.has(name)) {
			if (value === 'No') {
				variable.status = 'text-danger';
			} else if (value === 'Yes') {
				variable.status = 'text-success';
			}
		}
		if (WRAPPED_VARIABLES.has(name)) {
			variable.value = value.replaceAll(',', ', ');
		}
		variables.push(variable);
	}
	return variables;
}

const isSet = (row: StatusRow | undefined, key: string): boolean => row?.[key] !== undefined && row[key] !== null;

/** ReplicationGui::getHtmlForReplicaConfiguration()'s thread checks, including upstream's IO check that reads Replica_SQL_Running. */
export function replicaThreadsRunning(row: StatusRow | undefined): { io: boolean; sql: boolean; } {
	const io = (isSet(row, 'Slave_IO_Running') && row?.Slave_IO_Running !== 'No')
		|| (isSet(row, 'Replica_IO_Running') && row?.Replica_SQL_Running !== 'No');
	const sql = (isSet(row, 'Slave_SQL_Running') && row?.Slave_SQL_Running !== 'No')
		|| (isSet(row, 'Replica_SQL_Running') && row?.Replica_SQL_Running !== 'No');
	return { io, sql };
}

/** Whether the server takes the REPLICA spelling of the replica statements (MySQL 8.0.22, MariaDB 10.5.1). */
function usesReplicaKeyword({ isMariaDB, version }: ServerFlavour): boolean {
	return (!isMariaDB && version >= 80022) || (isMariaDB && version >= 100501);
}

/** ReplicationGui::getHtmlForPrimaryReplication()'s connected replicas statement. */
export function showReplicasStatement(flavour: ServerFlavour): string {
	if (!flavour.isMariaDB && flavour.version >= 80022) {
		return 'SHOW REPLICAS';
	}
	if (flavour.isMariaDB && flavour.version >= 100501) {
		return 'SHOW REPLICA HOSTS';
	}
	return 'SHOW SLAVE HOSTS';
}

/** ReplicationGui::getHtmlForReplicaConfiguration()'s multi-source statement, or null on MySQL. */
export function showAllReplicasStatement({ isMariaDB, version }: ServerFlavour): string | null {
	if (!isMariaDB) {
		return null;
	}
	if (version >= 100501) {
		return 'SHOW ALL REPLICAS STATUS';
	}
	return 'SHOW ALL SLAVES STATUS';
}

/** Replication::replicaControl()'s statement, or null where upstream returns -1 without querying. */
export function replicaControlStatement(action: string, control: string | null, flavour: ServerFlavour): string | null {
	const upperAction = action.toUpperCase();
	if (upperAction !== 'START' && upperAction !== 'STOP') {
		return null;
	}
	const upperControl = (control ?? '').toUpperCase();
	if (upperControl !== 'SQL_THREAD' && upperControl !== 'IO_THREAD' && upperControl !== '') {
		return null;
	}
	if (usesReplicaKeyword(flavour)) {
		return `${upperAction} REPLICA ${upperControl};`;
	}
	return `${upperAction} SLAVE ${upperControl};`;
}

/** ReplicationGui::handleRequestForReplicaServerControl()'s reset statement. */
export function resetReplicaStatement(flavour: ServerFlavour): string {
	if (usesReplicaKeyword(flavour)) {
		return 'RESET REPLICA;';
	}
	return 'RESET SLAVE;';
}

/** ReplicationGui::handleRequestForReplicaSkipError()'s statement for an already multiplied count. */
export function skipCounterStatement({ isMariaDB, version }: ServerFlavour, count: string): string {
	if (!isMariaDB && version >= 80400) {
		return `SET GLOBAL SQL_REPLICA_SKIP_COUNTER = ${count};`;
	}
	return `SET GLOBAL SQL_SLAVE_SKIP_COUNTER = ${count};`;
}

const INT64_MAX = (1n << 63n) - 1n;

const LEADING_NUMBER = /^[\t\n\v\f\r ]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i;

/**
 * `$_POST['sr_skip_errors_count'] * 1` as a string: integers stay integers, the rest become floats.
 * Null where PHP 8 throws a TypeError (an array or a string with no leading number).
 */
export function skipErrorsCount(value: unknown): string | null {
	if (value === undefined) {
		return '1';
	}
	if (typeof value !== 'string') {
		return null;
	}
	const match = LEADING_NUMBER.exec(value);
	if (match === null) {
		return null;
	}
	const number = match[0].trim();
	if (/^[+-]?\d+$/.test(number)) {
		const integer = BigInt(number);
		// Integers beyond PHP_INT_MAX become floats.
		if (integer <= INT64_MAX && integer >= -INT64_MAX - 1n) {
			return String(integer);
		}
	}
	return phpFloatString(Number(number));
}

/** ReplicationGui::handleControlRequest()'s messages for a replica server control action. */
export function controlMessages(action: unknown): { success: string; error: string; } {
	if (action === 'start') {
		return { success: 'Replication started successfully.', error: 'Error starting replication.' };
	}
	if (action === 'stop') {
		return { success: 'Replication stopped successfully.', error: 'Error stopping replication.' };
	}
	if (action === 'reset') {
		return { success: 'Replication resetting successfully.', error: 'Error resetting replication.' };
	}
	return { success: 'Success.', error: 'Error.' };
}

/** The second strtok($type, '()') token when it is all digits (Util::isInteger()), else the fallback. */
function typeLength(type: string, fallback: number): number {
	const tokens = type.split(/[()]+/).filter(token => token !== '');
	const length = tokens[1];
	if (length !== undefined && /^\d+$/.test(length)) {
		return Number(length);
	}
	return fallback;
}

/** ReplicationGui::getUsernameHostnameLength() from mysql.user's columns. */
export function usernameHostnameLength(columns: Iterable<Record<string, unknown>>): { username: number; hostname: number; } {
	let username = 16;
	let hostname = 41;
	for (const column of columns) {
		const type = typeof column.Type === 'string' ? column.Type : '';
		if (column.Field === 'User') {
			username = typeLength(type, username);
		} else if (column.Field === 'Host') {
			hostname = typeLength(type, hostname);
		}
	}
	return { username, hostname };
}

/** The "This host" option: the host part of USER() unless it is local; mb_strrpos() giving false starts at 1. */
export function thisHost(currentUser: unknown): string | null {
	if (typeof currentUser !== 'string' || currentUser === '' || currentUser === '0') {
		return null;
	}
	const host = currentUser.slice(currentUser.lastIndexOf('@') + 1 || 1).replaceAll('\'', '');
	if (host === 'localhost' || host === '127.0.0.1') {
		return null;
	}
	return host;
}

/** $GLOBALS['pred_hostname'] as getHtmlForReplicationPrimaryAddReplicaUser() derives it from the posted host. */
export function predefinedHostname(hostname: unknown): string {
	if (typeof hostname !== 'string') {
		return '';
	}
	const lower = hostname.toLowerCase();
	if (lower === 'localhost' || lower === '127.0.0.1') {
		return 'localhost';
	}
	if (lower === '%') {
		return 'any';
	}
	return 'userdefined';
}

export interface ReplicaLinks {
	io: string;
	sql: string;
	full: string;
	reset: string;
	skipError: string;
	reconfigurePrimary: string;
}

/** The data-post strings of getHtmlForReplicaConfiguration()'s control links (Url::getCommon($params, '', false)). */
export function replicaControlLinks(state: UrlState, urlParams: Record<string, unknown>, running: { io: boolean; sql: boolean; }): ReplicaLinks {
	const params: Record<string, unknown> = { ...urlParams, sr_take_action: true, sr_replica_server_control: true, sr_replica_action: running.io ? 'stop' : 'start', sr_replica_control_param: 'IO_THREAD' };
	const io = getCommon(state, params, '');
	params.sr_replica_action = running.sql ? 'stop' : 'start';
	params.sr_replica_control_param = 'SQL_THREAD';
	const sql = getCommon(state, params, '');
	params.sr_replica_action = running.io && running.sql ? 'stop' : 'start';
	params.sr_replica_control_param = null;
	const full = getCommon(state, params, '');
	params.sr_replica_action = 'reset';
	const reset = getCommon(state, params, '');
	const skipError = getCommon(state, { ...urlParams, sr_take_action: true, sr_replica_skip_error: true }, '');
	const reconfigurePrimary = getCommon(state, { ...urlParams, replica_configure: true, repl_clear_scr: true }, '');
	return { io, sql, full, reset, skipError, reconfigurePrimary };
}

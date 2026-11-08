import { describe, expect, it } from 'vitest';

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
} from './replication-gui.ts';

const mysql84 = { isMariaDB: false, version: 80400 };
const mysql8021 = { isMariaDB: false, version: 80021 };
const mysql57 = { isMariaDB: false, version: 50744 };
const mariadb12 = { isMariaDB: true, version: 120303 };
const mariadb104 = { isMariaDB: true, version: 100411 };

describe('statusTableVariables', () => {
	it('lists the primary columns in upstream order and skips NULL or missing ones', () => {
		const row = { Position: '157', File: 'binlog.000004', Binlog_Do_DB: 'a,b', Binlog_Ignore_DB: null, Executed_Gtid_Set: '' };
		expect(statusTableVariables('primary', row)).toEqual([
			{ name: 'File', status: '', value: 'binlog.000004' },
			{ name: 'Position', status: '', value: '157' },
			// Only the replica filter columns are spaced out.
			{ name: 'Binlog_Do_DB', status: '', value: 'a,b' },
		]);
		expect(statusTableVariables('primary', undefined)).toEqual([]);
	});

	it('flags the replica threads and spaces out the filter lists', () => {
		const row = {
			Replica_IO_Running: 'Connecting',
			Replica_SQL_Running: 'Yes',
			Slave_IO_Running: 'No',
			Replicate_Do_DB: 'one,two',
			Seconds_Behind_Source: null,
			Last_Error: 'No',
		};
		expect(statusTableVariables('replica', row)).toEqual([
			{ name: 'Slave_IO_Running', status: 'text-danger', value: 'No' },
			{ name: 'Replica_IO_Running', status: '', value: 'Connecting' },
			{ name: 'Replica_SQL_Running', status: 'text-success', value: 'Yes' },
			{ name: 'Replicate_Do_DB', status: '', value: 'one, two' },
			{ name: 'Last_Error', status: '', value: 'No' },
		]);
	});
});

describe('replicaThreadsRunning', () => {
	it('reads the Slave_ columns of older servers', () => {
		expect(replicaThreadsRunning({ Slave_IO_Running: 'Connecting', Slave_SQL_Running: 'No' })).toEqual({ io: true, sql: false });
		expect(replicaThreadsRunning({ Slave_IO_Running: 'No', Slave_SQL_Running: 'Yes' })).toEqual({ io: false, sql: true });
	});

	it('keeps upstream judging the Replica_ IO thread by the SQL thread column', () => {
		expect(replicaThreadsRunning({ Replica_IO_Running: 'No', Replica_SQL_Running: 'Yes' })).toEqual({ io: true, sql: true });
		expect(replicaThreadsRunning({ Replica_IO_Running: 'Yes', Replica_SQL_Running: 'No' })).toEqual({ io: false, sql: false });
	});

	it('treats a missing row or NULL columns as stopped', () => {
		expect(replicaThreadsRunning(undefined)).toEqual({ io: false, sql: false });
		expect(replicaThreadsRunning({ Replica_IO_Running: null, Replica_SQL_Running: null })).toEqual({ io: false, sql: false });
	});
});

describe('statements by server', () => {
	it('lists connected replicas with each server spelling', () => {
		expect(showReplicasStatement(mysql84)).toBe('SHOW REPLICAS');
		expect(showReplicasStatement(mariadb12)).toBe('SHOW REPLICA HOSTS');
		expect(showReplicasStatement(mysql8021)).toBe('SHOW SLAVE HOSTS');
		expect(showReplicasStatement(mariadb104)).toBe('SHOW SLAVE HOSTS');
	});

	it('reads multi-source status only on MariaDB', () => {
		expect(showAllReplicasStatement(mysql84)).toBeNull();
		expect(showAllReplicasStatement(mariadb12)).toBe('SHOW ALL REPLICAS STATUS');
		expect(showAllReplicasStatement(mariadb104)).toBe('SHOW ALL SLAVES STATUS');
	});

	it('resets with REPLICA from MySQL 8.0.22 and MariaDB 10.5.1', () => {
		expect(resetReplicaStatement(mysql84)).toBe('RESET REPLICA;');
		expect(resetReplicaStatement(mariadb12)).toBe('RESET REPLICA;');
		expect(resetReplicaStatement(mysql57)).toBe('RESET SLAVE;');
		expect(resetReplicaStatement(mariadb104)).toBe('RESET SLAVE;');
	});

	it('uses the REPLICA skip counter only from MySQL 8.4', () => {
		expect(skipCounterStatement(mysql84, '3')).toBe('SET GLOBAL SQL_REPLICA_SKIP_COUNTER = 3;');
		expect(skipCounterStatement(mysql8021, '1')).toBe('SET GLOBAL SQL_SLAVE_SKIP_COUNTER = 1;');
		expect(skipCounterStatement(mariadb12, '2.5')).toBe('SET GLOBAL SQL_SLAVE_SKIP_COUNTER = 2.5;');
	});
});

describe('replicaControlStatement', () => {
	it('upper-cases the action and thread and keeps the space before the semicolon', () => {
		expect(replicaControlStatement('start', 'io_thread', mysql84)).toBe('START REPLICA IO_THREAD;');
		expect(replicaControlStatement('Stop', null, mysql84)).toBe('STOP REPLICA ;');
		expect(replicaControlStatement('stop', 'SQL_THREAD', mysql57)).toBe('STOP SLAVE SQL_THREAD;');
		expect(replicaControlStatement('start', '', mariadb104)).toBe('START SLAVE ;');
	});

	it('refuses unknown actions and threads like upstream\'s -1', () => {
		expect(replicaControlStatement('reset', null, mysql84)).toBeNull();
		expect(replicaControlStatement('start', 'BOTH', mysql84)).toBeNull();
	});
});

describe('skipErrorsCount', () => {
	it('defaults to one when no count is posted', () => {
		expect(skipErrorsCount(undefined)).toBe('1');
	});

	it('multiplies numeric strings by one as PHP does', () => {
		expect(skipErrorsCount('3')).toBe('3');
		expect(skipErrorsCount(' 007 ')).toBe('7');
		expect(skipErrorsCount('2.5')).toBe('2.5');
		expect(skipErrorsCount('1e3')).toBe('1000');
		expect(skipErrorsCount('9007199254740993')).toBe('9007199254740993');
		expect(skipErrorsCount('-9223372036854775808')).toBe('-9223372036854775808');
		expect(skipErrorsCount('99999999999999999999')).toBe('1.0E+20');
	});

	it('keeps the leading number of a partly numeric string', () => {
		expect(skipErrorsCount('3abc')).toBe('3');
	});

	it('gives null where PHP 8 throws a TypeError', () => {
		expect(skipErrorsCount('abc')).toBeNull();
		expect(skipErrorsCount('')).toBeNull();
		expect(skipErrorsCount(['1'])).toBeNull();
	});
});

describe('controlMessages', () => {
	it('names the action, with generic messages for anything else', () => {
		expect(controlMessages('start').success).toBe('Replication started successfully.');
		expect(controlMessages('stop').error).toBe('Error stopping replication.');
		expect(controlMessages('reset')).toEqual({ success: 'Replication resetting successfully.', error: 'Error resetting replication.' });
		expect(controlMessages(undefined)).toEqual({ success: 'Success.', error: 'Error.' });
	});
});

describe('usernameHostnameLength', () => {
	it('reads the column widths of mysql.user', () => {
		const columns = [
			{ Field: 'Host', Type: 'char(255)' },
			{ Field: 'User', Type: 'char(32)' },
			{ Field: 'Select_priv', Type: 'enum(\'N\',\'Y\')' },
		];
		expect(usernameHostnameLength(columns)).toEqual({ username: 32, hostname: 255 });
	});

	it('keeps the defaults when a width is missing or not a whole number', () => {
		expect(usernameHostnameLength([])).toEqual({ username: 16, hostname: 41 });
		expect(usernameHostnameLength([{ Field: 'User', Type: 'text' }, { Field: 'Host', Type: 'decimal(10,2)' }])).toEqual({ username: 16, hostname: 41 });
		expect(usernameHostnameLength([{ Field: 'User', Type: null }])).toEqual({ username: 16, hostname: 41 });
	});
});

describe('thisHost', () => {
	it('offers the host part of USER() unless it is local', () => {
		expect(thisHost('root@172.21.0.5')).toBe('172.21.0.5');
		expect(thisHost('a@b@\'db.example\'')).toBe('db.example');
		expect(thisHost('root@localhost')).toBeNull();
		expect(thisHost('root@127.0.0.1')).toBeNull();
	});

	it('starts after the first character when there is no @, as mb_strrpos() giving false does', () => {
		expect(thisHost('xhost')).toBe('host');
	});

	it('has nothing to offer for an empty user', () => {
		expect(thisHost(false)).toBeNull();
		expect(thisHost('')).toBeNull();
		expect(thisHost('0')).toBeNull();
	});
});

describe('predefinedHostname', () => {
	it('maps the posted host onto the select options', () => {
		expect(predefinedHostname('LocalHost')).toBe('localhost');
		expect(predefinedHostname('127.0.0.1')).toBe('localhost');
		expect(predefinedHostname('%')).toBe('any');
		expect(predefinedHostname('db.example')).toBe('userdefined');
		expect(predefinedHostname(undefined)).toBe('');
	});
});

describe('replicaControlLinks', () => {
	const state = { server: 1, serverDefault: 1, lang: 'en', hasLangCookie: true, token: '' };
	const urlParams = { db: '', table: '', server: 1 };

	it('starts what is stopped and keeps the parameter order of upstream\'s reused array', () => {
		const links = replicaControlLinks(state, urlParams, { io: false, sql: true });
		const common = 'db=&table=&server=1&sr_take_action=1&sr_replica_server_control=1';
		expect(links.io).toBe(`${common}&sr_replica_action=start&sr_replica_control_param=IO_THREAD`);
		expect(links.sql).toBe(`${common}&sr_replica_action=stop&sr_replica_control_param=SQL_THREAD`);
		expect(links.full).toBe(`${common}&sr_replica_action=start`);
		expect(links.reset).toBe(`${common}&sr_replica_action=reset`);
		expect(links.skipError).toBe('db=&table=&server=1&sr_take_action=1&sr_replica_skip_error=1');
		expect(links.reconfigurePrimary).toBe('db=&table=&server=1&replica_configure=1&repl_clear_scr=1');
	});

	it('offers a full stop only when both threads run', () => {
		expect(replicaControlLinks(state, urlParams, { io: true, sql: true }).full).toContain('sr_replica_action=stop');
		expect(replicaControlLinks(state, urlParams, { io: true, sql: false }).full).toContain('sr_replica_action=start');
	});
});

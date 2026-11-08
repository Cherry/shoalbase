import { describe, expect, it } from 'vitest';

import { DatabaseInterface, DbiQueryError } from './dbi.ts';
import { createConfig } from '../../../lib/pma/config.ts';
import { MysqlType } from '../../../lib/pma/field-metadata.ts';

import type { Connection } from 'mysql2/promise';

interface FakeField {
	name: string;
	columnType?: number;
	characterSet?: number;
}

type Answer = { fields: FakeField[]; rows: (string | Buffer | null)[][]; } | { affectedRows: number; } | { errno: number; message: string; };

const field = (name: string, columnType: number = MysqlType.VAR_STRING, characterSet = 45): FakeField => {
	return { name, columnType, characterSet };
};

/** A mysql2 connection answering from a table of SQL strings, recording what was sent. */
function fakeConnection(answers: Record<string, Answer>): { connection: Connection; sent: string[]; } {
	const sent: string[] = [];
	const query = async ({ sql }: { sql: string; }) => {
		sent.push(sql);
		const answer = answers[sql] ?? { affectedRows: 0 };
		if ('errno' in answer) {
			throw Object.assign(new Error(answer.message), { errno: answer.errno, sqlMessage: answer.message });
		}
		if ('affectedRows' in answer) {
			return [{ affectedRows: answer.affectedRows, warningStatus: 0 }, undefined];
		}
		const rows = answer.rows.map(row => row.map(value => (typeof value === 'string' ? Buffer.from(value) : value)));
		const fields = answer.fields.map((item) => {
			return { orgName: item.name, table: 't', orgTable: 't', decimals: 0, columnLength: 10, flags: 0, ...item };
		});
		return [rows, fields];
	};
	return { connection: { query } as unknown as Connection, sent };
}

const versionAnswer: Answer = { fields: [field('@@version'), field('@@version_comment')], rows: [['8.4.13', 'MySQL Community Server - GPL']] };

function createDbi(answers: Record<string, Answer> = {}) {
	const fake = fakeConnection({ 'SELECT @@version, @@version_comment': versionAnswer, ...answers });
	const dbi = new DatabaseInterface({
		connect: async () => fake.connection,
		config: createConfig({ host: 'db', user: 'customer' }),
		routeUrl: route => `index.php?route=${route}`,
	});
	return { dbi, sent: fake.sent };
}

describe('DatabaseInterface', () => {
	it('runs postConnect() like upstream on first use, once', async () => {
		const { dbi, sent } = createDbi({ 'SELECT 1': { fields: [field('1', MysqlType.LONGLONG, 63)], rows: [['1']] } });
		expect(dbi.isConnected()).toBe(false);
		await Promise.all([dbi.fetchValue('SELECT 1'), dbi.connect()]);
		expect(sent).toEqual([
			'SELECT @@version, @@version_comment',
			'SET NAMES \'utf8mb4\' COLLATE \'utf8mb4_general_ci\';',
			'SET lc_messages = \'en_US\';',
			// Config::setConnectionCollation() applies DefaultConnectionCollation once the link is up.
			'SET collation_connection = \'utf8mb4_unicode_ci\';',
			'SELECT 1',
		]);
		expect(dbi.isConnected()).toBe(true);
		expect(dbi.getVersion()).toBe(80413);
		expect(dbi.isMySql()).toBe(true);
		expect(dbi.collationConnection).toBe('utf8mb4_unicode_ci');
	});

	it('returns values as mysqli does: strings, NULL, binary as byte strings and JSON as text', async () => {
		const { dbi } = createDbi({
			'SELECT x': {
				fields: [field('n', MysqlType.LONG, 63), field('s'), field('b', MysqlType.BLOB, 63), field('j', MysqlType.JSON, 63), field('z')],
				rows: [['5', 'é', Buffer.from([0xFF, 0x00]), '{"a": "é"}', null]],
			},
		});
		expect(await dbi.fetchSingleRow('SELECT x')).toEqual({ n: '5', s: 'é', b: 'ÿ\u{0}', j: '{"a": "é"}', z: null });
		expect(await dbi.fetchSingleRow('SELECT x', 'NUM')).toEqual(['5', 'é', 'ÿ\u{0}', '{"a": "é"}', null]);
	});

	it('shapes fetchResult() like PHP for lists, single columns, keys and nested keys', async () => {
		const players = { fields: [field('id', MysqlType.LONG, 63), field('team'), field('name')], rows: [['10', 'red', 'Ada'], ['2', 'blue', 'Grace'], ['3', 'red', 'Linus']] };
		const { dbi } = createDbi({ 'SELECT players': players, 'SELECT names': { fields: [field('name')], rows: [['Ada'], ['Grace']] } });

		expect(await dbi.fetchResult('SELECT names')).toEqual(['Ada', 'Grace']);
		expect(await dbi.fetchResult('SELECT players', null, 'name')).toEqual(['Ada', 'Grace', 'Linus']);
		// Map keeps PHP's insertion order where an object would move numeric keys first.
		const byId = await dbi.fetchResult('SELECT players', 'id', 'name');
		expect(byId.keys().toArray()).toEqual(['10', '2', '3']);
		const byPosition = await dbi.fetchResult('SELECT players', 0);
		expect(byPosition.get('2')).toEqual(['2', 'blue', 'Grace']);
		expect(await dbi.fetchResult('SELECT players', ['team', null], 'name')).toEqual(new Map([['red', ['Ada', 'Linus']], ['blue', ['Grace']]]));
		expect(await dbi.fetchResult('SELECT players', ['team', 'name'], 'id')).toEqual(new Map([['red', new Map([['Ada', '10'], ['Linus', '3']])], ['blue', new Map([['Grace', '2']])]]));
		expect(await dbi.fetchResult('SELECT players', [null, 'team'], 'name')).toEqual([new Map([['red', 'Ada']]), new Map([['blue', 'Grace']]), new Map([['red', 'Linus']])]);
	});

	it('reports SQL errors through getError() and query() failures as DbiQueryError', async () => {
		const { dbi } = createDbi({ 'SELECT bad': { errno: 1142, message: 'SELECT command denied to user \'customer\'' } });
		expect(await dbi.tryQuery('SELECT bad')).toBe(false);
		expect(dbi.getError()).toBe('#1142 - SELECT command denied to user &#039;customer&#039;');
		expect(dbi.getLastError()).toEqual({ errno: 1142, message: 'SELECT command denied to user \'customer\'' });
		expect(dbi.affectedRows()).toBe(-1);
		expect(await dbi.fetchResult('SELECT bad')).toEqual([]);
		expect(await dbi.fetchValue('SELECT bad')).toBe(false);
		await expect(dbi.query('SELECT bad')).rejects.toBeInstanceOf(DbiQueryError);

		await dbi.tryQuery('UPDATE t SET a = 1');
		expect(dbi.getError()).toBe('');
	});

	it('caches affected rows only for query() and tryQuery()', async () => {
		const { dbi } = createDbi({ 'UPDATE t': { affectedRows: 4 }, 'SELECT names': { fields: [field('name')], rows: [['Ada']] } });
		await dbi.query('UPDATE t');
		await dbi.fetchResult('SELECT names');
		expect(dbi.affectedRows()).toBe(4);
		await dbi.tryQuery('SELECT names');
		expect(dbi.affectedRows()).toBe(1);
	});

	it('computes the customer privileges from SHOW GRANTS like CheckUserPrivileges', async () => {
		const { dbi, sent } = createDbi({
			'SELECT CURRENT_USER();': { fields: [field('CURRENT_USER()')], rows: [['customer@%']] },
			'SHOW GRANTS': { fields: [field('Grants for customer@%')], rows: [['GRANT USAGE ON *.* TO `customer`@`%`'], ['GRANT ALL PRIVILEGES ON `customer\\_db`.* TO `customer`@`%`']] },
			'SELECT `SCHEMA_NAME` FROM `INFORMATION_SCHEMA`.`SCHEMATA`': { fields: [field('SCHEMA_NAME')], rows: [['performance_schema'], ['customer_db'], ['information_schema']] },
		});
		expect(await dbi.isCreateDatabaseUser()).toBe(false);
		expect(await dbi.getDatabaseList()).toEqual(['customer_db', 'information_schema', 'performance_schema']);
		expect(sent).toContain('USE `customer_db`');
		expect(await dbi.getCurrentUserAndHost()).toEqual(['customer', '%']);
	});

	it('raises mysqli\'s "No database selected" on the server for selectDb(\'\') instead of sending a bare USE', async () => {
		const signal = 'SIGNAL SQLSTATE \'3D000\' SET MYSQL_ERRNO = 1046, MESSAGE_TEXT = \'No database selected\'';
		const { dbi, sent } = createDbi({ [signal]: { errno: 1046, message: 'No database selected' } });
		expect(await dbi.selectDb('')).toBe(false);
		expect(dbi.getLastError()).toEqual({ errno: 1046, message: 'No database selected' });
		expect(sent).toContain(signal);
		expect(sent.some(sql => sql.startsWith('USE'))).toBe(false);
	});

	it('gives later columns of multi-column indexes a Key in getColumns(), like attachIndexInfoToColumns()', async () => {
		const columnFields = [field('Field'), field('Key')];
		const indexFields = [field('Key_name'), field('Non_unique'), field('Seq_in_index'), field('Column_name')];
		const { dbi, sent } = createDbi({
			'SHOW  COLUMNS FROM `d`.`t`': { fields: columnFields, rows: [['id', 'PRI'], ['title', 'MUL'], ['kind', ''], ['code', ''], ['note', '']] },
			'SHOW INDEXES FROM `d`.`t`': {
				fields: indexFields,
				rows: [['PRIMARY', '0', '1', 'id'], ['multi', '1', '1', 'title'], ['multi', '1', '2', 'kind'], ['pair', '0', '1', 'title'], ['pair', '0', '2', 'code']],
			},
		});
		const columns = await dbi.getColumns('d', 't');
		expect(columns.values().map(column => column.Key).toArray()).toEqual(['PRI', 'MUL', 'MUL', 'UNI', '']);
		await dbi.getColumns('d', 't', false);
		expect(sent.filter(sql => sql.startsWith('SHOW INDEXES'))).toHaveLength(1);
	});
});

import { describe, expect, it } from 'vitest';

import {
	MAX_REMEMBERED_QUERIES,
	MAX_SESSION_BYTES,
	PmaSession,
	type SessionTmpval,
	type TableRef,
	addToTableList,
	rememberQuerySettings,
	removeFromTableList,
	sessionBytes,
	tableList,
	trimTableList,
} from './session.ts';

describe('PmaSession', () => {
	it('reports nothing for an untouched session, even after reading nested values', () => {
		const session = new PmaSession({ userconfig: { db: { MaxRows: 50 }, ts: 1 }, profiling: true });
		expect(session.data.userconfig?.db.MaxRows).toBe(50);
		expect(session.changes()).toBeNull();
		expect(session.isChanged()).toBe(false);
	});

	it('reports only the top-level keys a request set, changed deep inside or removed', () => {
		const session = new PmaSession({ tmpval: { pos: 0 }, profiling: true, edit_next: 'x', kept: 1 });
		session.tmpval.pos = 30;
		session.data.userprefs_autoload = true;
		delete session.data.profiling;
		session.data.edit_next = undefined;
		expect(session.changes()).toEqual({ set: { tmpval: { pos: 30 }, userprefs_autoload: true }, unset: ['profiling', 'edit_next'] });
		expect(session.isChanged()).toBe(true);
	});

	it('creates tmpval on first use, like PHP auto-vivifying arrays', () => {
		const session = new PmaSession();
		session.tmpval.pftext = 'F';
		expect(session.changes()).toEqual({ set: { tmpval: { pftext: 'F' } }, unset: [] });
	});

	it('measures the stored size in UTF-8 bytes against a bound far above normal sessions', () => {
		expect(sessionBytes({ a: 'é' })).toBe('{"a":"é"}'.length + 1);
		expect(sessionBytes({ tmpval: { query: { q: { pftext: 'x'.repeat(1000) } } } })).toBeLessThan(MAX_SESSION_BYTES);
	});
});


describe('recent and favorite table lists', () => {
	it('reads an absent list without storing it, and creates it only when asked', () => {
		const session = new PmaSession();
		expect(tableList(session, 'recent', 1)).toEqual([]);
		expect(session.isChanged()).toBe(false);
		tableList(session, 'favorite', 2, true).push({ db: 'd', table: 't' });
		expect(session.data.tmpval?.favoriteTables).toEqual({ 2: [{ db: 'd', table: 't' }] });
		expect(tableList(session, 'favorite', 2, true)).toEqual([{ db: 'd', table: 't' }]);
	});

	it('moves a table to the front without duplicates, comparing names the way PHP == does', () => {
		const list: TableRef[] = [{ db: 'd', table: 'a' }, { db: 'd', table: '1' }, { db: 'd', table: 'b' }];
		addToTableList(list, { db: 'd', table: 'b' }, 10);
		expect(list.map(item => item.table)).toEqual(['b', 'a', '1']);
		addToTableList(list, { db: 'd', table: '01' }, 10);
		expect(list.map(item => item.table)).toEqual(['01', 'b', 'a']);
		addToTableList(list, { db: 'd', table: '01' }, 10);
		expect(list).toHaveLength(3);
	});

	it('trims to the configured maximum, treating negatives as zero', () => {
		const list: TableRef[] = [{ db: 'd', table: 'a' }];
		addToTableList(list, { db: 'd', table: 'b' }, 1);
		expect(list).toEqual([{ db: 'd', table: 'b' }]);
		expect(trimTableList(list, 5)).toBe(false);
		expect(trimTableList(list, -1)).toBe(true);
		expect(list).toEqual([]);
	});

	it('removes every entry of a table', () => {
		const list: TableRef[] = [{ db: 'd', table: 'a' }, { db: 'e', table: 'a' }];
		removeFromTableList(list, 'd', 'a');
		expect(list).toEqual([{ db: 'e', table: 'a' }]);
	});
});

describe('rememberQuerySettings', () => {
	it('keeps the most recent query last and forgets the oldest beyond the limit', () => {
		const tmpval: SessionTmpval = {};
		for (let index = 0; index <= MAX_REMEMBERED_QUERIES; index++) {
			rememberQuerySettings(tmpval, `q${index}`, { pos: index });
		}
		rememberQuerySettings(tmpval, 'q3', { pos: 30 });
		const keys = Object.keys(tmpval.query ?? {});
		expect(keys).toHaveLength(MAX_REMEMBERED_QUERIES);
		expect(keys[0]).toBe('q1');
		expect(keys.at(-1)).toBe('q3');
		expect(tmpval.query?.q3).toEqual({ pos: 30 });
	});
});

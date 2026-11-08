import { describe, expect, it } from 'vitest';

import {
	MAX_REMEMBERED_QUERIES,
	PmaSession,
	SESSION_CHUNK_SIZE,
	SESSION_MAX_CHUNKS,
	type SessionTmpval,
	type TableRef,
	addToTableList,
	fitSession,
	readSessionChunks,
	rememberQuerySettings,
	removeFromTableList,
	sealedLength,
	sessionChunkName,
	splitSessionChunks,
	tableList,
	trimTableList,
} from './session.ts';

const TOKEN = '0123456789abcdef0123456789abcdef';

describe('session cookies', () => {
	it('names the first chunk after the session and numbers the rest', () => {
		expect([0, 1, 2].map(index => sessionChunkName(index))).toEqual(['pmaSession', 'pmaSession1', 'pmaSession2']);
	});

	it('splits a sealed value into cookie-sized chunks and reads them back in order', () => {
		const sealed = 'x'.repeat(SESSION_CHUNK_SIZE * 2 + 5);
		const chunks = splitSessionChunks(sealed);
		expect(chunks.map(chunk => chunk.length)).toEqual([SESSION_CHUNK_SIZE, SESSION_CHUNK_SIZE, 5]);
		const jar = new Map(chunks.map((chunk, index) => [sessionChunkName(index), chunk]));
		expect(readSessionChunks(name => jar.get(name))).toEqual({ sealed, count: 3 });
	});

	it('stops at the first missing or empty chunk and never reads past the chunk limit', () => {
		expect(readSessionChunks(() => {})).toEqual({ sealed: '', count: 0 });
		const gap = new Map([['pmaSession', 'a'], ['pmaSession1', ''], ['pmaSession2', 'c']]);
		expect(readSessionChunks(name => gap.get(name))).toEqual({ sealed: 'a', count: 1 });
		expect(readSessionChunks(() => 'z').count).toBe(SESSION_MAX_CHUNKS);
	});

	it('predicts the AES-GCM base64url length so pruning needs no trial encryption', () => {
		expect(sealedLength(0)).toBe(38);
		expect(sealedLength(3)).toBe(42);
	});
});

describe('fitSession', () => {
	it('keeps a session that fits unchanged', () => {
		const data = { userprefs_autoload: true };
		expect(fitSession(TOKEN, data)).toBe(data);
	});

	it('drops the oldest remembered queries first, then table UI preferences, without touching the original', () => {
		const query: SessionTmpval['query'] = {};
		for (let index = 0; index < 10; index++) {
			query[`q${index}`] = { pftext: 'x'.repeat(1500) };
		}
		const data = { tmpval: { query }, userprefs_autoload: true };
		const fitted = fitSession(TOKEN, data);
		const kept = Object.keys(fitted?.tmpval?.query ?? {});
		expect(kept.length).toBeGreaterThan(0);
		expect(kept.length).toBeLessThan(10);
		expect(kept).toEqual(Object.keys(query).slice(-kept.length));
		expect(fitted?.userprefs_autoload).toBe(true);
		expect(Object.keys(data.tmpval.query)).toHaveLength(10);

		const uiOnly = { tmpval: { table_uiprefs: { 1: { db: { t: { col_order: 'y'.repeat(20000) } } } } } };
		expect(fitSession(TOKEN, uiOnly)?.tmpval).toEqual({});
	});

	it('gives up when even the pruned session is too large', () => {
		expect(fitSession(TOKEN, { userconfig: { db: { TitleDefault: 'z'.repeat(20000) }, ts: 1 } })).toBeNull();
	});
});

describe('PmaSession', () => {
	it('only counts a payload sealed for the current login token', () => {
		const restored = PmaSession.fromPayload({ token: TOKEN, data: { profiling: true } }, TOKEN, 1);
		expect(restored.data).toEqual({ profiling: true });
		expect(restored.isChanged()).toBe(false);

		const foreign = PmaSession.fromPayload({ token: 'other', data: { profiling: true } }, TOKEN, 2);
		expect(foreign.data).toEqual({});
		expect(foreign.isChanged()).toBe(true);
		expect(foreign.chunkCount).toBe(2);
		expect(PmaSession.fromPayload(null, TOKEN, 0).isChanged()).toBe(false);
		expect(PmaSession.fromPayload({ token: TOKEN, data: [] }, TOKEN, 1).data).toEqual({});
	});

	it('notices changes made anywhere in the data, including through tmpval', () => {
		const session = new PmaSession();
		expect(session.isEmpty()).toBe(true);
		session.tmpval.pftext = 'F';
		expect(session.isChanged()).toBe(true);
		expect(session.isEmpty()).toBe(false);
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

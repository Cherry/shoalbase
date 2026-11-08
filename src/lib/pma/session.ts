// $_SESSION for the Workers port: upstream-shaped data kept in sealed, chunked cookies that belong to one login.
import { looseEquals } from './navigation-node.ts';

/** The first cookie of the session; further chunks are pmaSession1, pmaSession2... */
export const SESSION_COOKIE = 'pmaSession';
// Browsers cap a cookie near 4096 bytes including its name and attributes.
export const SESSION_CHUNK_SIZE = 3800;
// Keeps the Cookie request header well under proxy and Worker header limits.
export const SESSION_MAX_CHUNKS = 4;
/** Display\Results::setConfigParamsForDisplayTable() remembers this many queries. */
export const MAX_REMEMBERED_QUERIES = 10;
// AES-GCM adds a 12 byte IV and a 16 byte tag around the JSON payload.
const SEAL_OVERHEAD_BYTES = 28;

/** One entry of the recent or favorite table lists. */
export interface TableRef {
	db: string;
	table: string;
}

/** $_SESSION['tmpval']['query'][$sqlMd5] without the query text, which upstream stores but never reads. */
export interface QuerySettings {
	repeat_cells?: number;
	max_rows?: number | 'all';
	pos?: number;
	pftext?: string;
	relational_display?: string;
	geoOption?: string;
	display_binary?: boolean;
	display_blob?: boolean;
	hide_transformation?: boolean;
}

/** $_SESSION['tmpval']. */
export interface SessionTmpval {
	/** RecentFavoriteTable lists keyed by server index. */
	recentTables?: Record<string, TableRef[]>;
	favoriteTables?: Record<string, TableRef[]>;
	favorites_synced?: Record<string, boolean>;
	query?: Record<string, QuerySettings>;
	pftext?: string;
	relational_display?: string;
	geoOption?: string;
	display_binary?: boolean;
	display_blob?: boolean;
	hide_transformation?: boolean;
	pos?: number;
	max_rows?: number | 'all';
	repeat_cells?: number;
	possible_as_geometry?: boolean;
	table_limit_offset?: number;
	table_limit_offset_db?: string;
	/** Table::loadUiPrefs(): [server][db][table] => prefs. */
	table_uiprefs?: Record<string, Record<string, Record<string, Record<string, unknown>>>>;
	aliases?: Record<string, unknown>;
	[key: string]: unknown;
}

/** $_SESSION with the keys the port uses; anything else upstream keeps there may be added under its own name. */
export interface SessionData {
	tmpval?: SessionTmpval;
	/** UserPreferences storage when there is no pmadb: path => value pairs and the save time. */
	userconfig?: { db: Record<string, unknown>; ts: number; };
	userprefs_autoload?: boolean;
	profiling?: boolean;
	edit_next?: string;
	pma_switch_to_new?: boolean;
	is_multi_query?: boolean;
	sql_from_query_box?: boolean;
	[key: string]: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Cookie name of chunk `index`. */
export function sessionChunkName(index: number): string {
	if (index === 0) {
		return SESSION_COOKIE;
	}
	return `${SESSION_COOKIE}${index}`;
}

/** Joins the chunks a request carries; `count` is how many were present, so a smaller session can delete the rest. */
export function readSessionChunks(read: (name: string) => string | undefined): { sealed: string; count: number; } {
	let sealed = '';
	let count = 0;
	while (count < SESSION_MAX_CHUNKS) {
		const chunk = read(sessionChunkName(count));
		if (chunk === undefined || chunk === '') {
			break;
		}
		sealed += chunk;
		count++;
	}
	return { sealed, count };
}

export function splitSessionChunks(sealed: string): string[] {
	const chunks: string[] = [];
	for (let offset = 0; offset < sealed.length; offset += SESSION_CHUNK_SIZE) {
		chunks.push(sealed.slice(offset, offset + SESSION_CHUNK_SIZE));
	}
	return chunks;
}

/** The base64url length the cookie cipher produces for a payload of this many UTF-8 bytes. */
export function sealedLength(payloadBytes: number): number {
	return Math.ceil(((payloadBytes + SEAL_OVERHEAD_BYTES) * 4) / 3);
}

/** What the cookie stores: the data plus the login token it belongs to. */
export function sessionPayload(token: string, data: SessionData): string {
	return JSON.stringify({ token, data });
}

const fits = (token: string, data: SessionData): boolean => {
	const bytes = new TextEncoder().encode(sessionPayload(token, data)).length;
	return sealedLength(bytes) <= SESSION_CHUNK_SIZE * SESSION_MAX_CHUNKS;
};

/**
 * Drops the most expendable state until the session fits its cookies: the oldest remembered query settings first, then
 * per-table UI preferences. Returns null when even that is not enough, so the previous cookie is kept.
 */
export function fitSession(token: string, data: SessionData): SessionData | null {
	if (fits(token, data)) {
		return data;
	}
	const pruned = structuredClone(data);
	const tmpval = pruned.tmpval ?? {};
	const queries = tmpval.query ?? {};
	for (const key of Object.keys(queries)) {
		delete queries[key];
		if (fits(token, pruned)) {
			return pruned;
		}
	}
	delete tmpval.table_uiprefs;
	if (fits(token, pruned)) {
		return pruned;
	}
	return null;
}

/** $_SESSION for one request: mutate `data` freely, and the response stores it again if it changed. */
export class PmaSession {
	/** Restores a session from an opened cookie payload, which only counts when it belongs to the current login token. */
	static fromPayload(payload: unknown, token: string, chunkCount: number): PmaSession {
		if (isRecord(payload) && payload.token === token && isRecord(payload.data)) {
			return new PmaSession(payload.data as SessionData, chunkCount);
		}
		return new PmaSession({}, chunkCount, chunkCount > 0);
	}

	private readonly snapshot: string;
	readonly data: SessionData;

	/**
	 * `chunkCount` is how many cookies the request carried; `stale` marks cookies from another login or a broken seal,
	 * which are replaced even when nothing changes.
	 */
	constructor(data: SessionData = {}, readonly chunkCount = 0, readonly stale = false) {
		this.data = data;
		this.snapshot = JSON.stringify(data);
	}

	/** $_SESSION['tmpval'], created on first use like PHP's auto-vivifying arrays. */
	get tmpval(): SessionTmpval {
		this.data.tmpval ??= {};
		return this.data.tmpval;
	}

	isChanged(): boolean {
		return this.stale || JSON.stringify(this.data) !== this.snapshot;
	}

	isEmpty(): boolean {
		return Object.keys(this.data).length === 0;
	}
}

/** RecentFavoriteTable's session list for a server; reading an absent list does not store an empty one, so the cookie stays unchanged. */
export function tableList(session: PmaSession, type: 'recent' | 'favorite', server: number, create = false): TableRef[] {
	const key = `${type}Tables` as const;
	const stored = session.data.tmpval?.[key]?.[server];
	if (stored !== undefined || !create) {
		return stored ?? [];
	}
	const byServer = session.tmpval[key] ?? {};
	session.tmpval[key] = byServer;
	byServer[server] = [];
	return byServer[server];
}

const sameTable = (left: TableRef, right: TableRef): boolean => looseEquals(left.db, right.db) && looseEquals(left.table, right.table);

/** RecentFavoriteTable::trim(): returns whether anything was dropped. */
export function trimTableList(list: TableRef[], max: number): boolean {
	const limit = Math.max(max, 0);
	const trimmed = list.length > limit;
	list.splice(limit);
	return trimmed;
}

/** RecentFavoriteTable::add() once the table is known to exist: moves it to the front, without duplicates, within `max`. */
export function addToTableList(list: TableRef[], entry: TableRef, max: number): void {
	if (list.length > 0 && sameTable(list[0], entry)) {
		return;
	}
	const unique = [{ db: entry.db, table: entry.table }, ...list].filter((item, index, all) => all.findIndex(other => sameTable(other, item)) === index);
	list.splice(0, list.length, ...unique);
	trimTableList(list, max);
}

/** RecentFavoriteTable::remove(). */
export function removeFromTableList(list: TableRef[], db: string, table: string): void {
	const kept = list.filter(item => !looseEquals(item.db, db) || !looseEquals(item.table, table));
	list.splice(0, list.length, ...kept);
}

/** Stores one query's display settings the way setConfigParamsForDisplayTable() does: most recent last, at most ten. */
export function rememberQuerySettings(tmpval: SessionTmpval, sqlMd5: string, settings: QuerySettings): void {
	const queries = tmpval.query ?? {};
	delete queries[sqlMd5];
	queries[sqlMd5] = settings;
	const keys = Object.keys(queries);
	if (keys.length > MAX_REMEMBERED_QUERIES) {
		delete queries[keys[0]];
	}
	tmpval.query = queries;
}

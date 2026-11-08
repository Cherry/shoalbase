// $_SESSION for the Workers port: upstream-shaped data that the session's Durable Object stores between requests.
import { looseEquals } from './navigation-node.ts';

/** Display\Results::setConfigParamsForDisplayTable() remembers this many queries. */
export const MAX_REMEMBERED_QUERIES = 10;
// Far above what phpMyAdmin keeps in a session and far below a Durable Object's 8 MB per value, so a runaway value cannot grow forever.
export const MAX_SESSION_BYTES = 1_048_576;

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


/** What a request changed in $_SESSION, by top-level key, so concurrent requests that touch different keys do not overwrite each other. */
export interface SessionChanges {
	set: Record<string, unknown>;
	unset: string[];
}

/** The stored size of a session, which MAX_SESSION_BYTES bounds. */
export function sessionBytes(data: SessionData): number {
	return new TextEncoder().encode(JSON.stringify(data)).length;
}

/** $_SESSION for one request: mutate `data` freely, and the changed keys are stored again at the end of the request. */
export class PmaSession {
	private readonly snapshot: Map<string, string>;
	readonly data: SessionData;

	constructor(data: SessionData = {}) {
		this.data = data;
		this.snapshot = new Map(Object.entries(data).map(([key, value]) => [key, JSON.stringify(value)]));
	}

	/** $_SESSION['tmpval'], created on first use like PHP's auto-vivifying arrays. */
	get tmpval(): SessionTmpval {
		this.data.tmpval ??= {};
		return this.data.tmpval;
	}

	/** The keys set or removed since the session was loaded; null when nothing changed. */
	changes(): SessionChanges | null {
		const set: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(this.data)) {
			if (value !== undefined && this.snapshot.get(key) !== JSON.stringify(value)) {
				set[key] = value;
			}
		}
		const unset = this.snapshot.keys().filter(key => this.data[key] === undefined).toArray();
		if (Object.keys(set).length === 0 && unset.length === 0) {
			return null;
		}
		return { set, unset };
	}

	isChanged(): boolean {
		return this.changes() !== null;
	}
}

/** RecentFavoriteTable's session list for a server; reading an absent list does not store an empty one, so the session stays unchanged. */
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

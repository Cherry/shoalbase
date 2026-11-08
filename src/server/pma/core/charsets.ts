// Port of PhpMyAdmin\Charsets: the server's character sets and collations, loaded once per request like its static cache.
import {
	CHARSETS_QUERY,
	Charset,
	type Collation,
	charsetsFromRows,
	collationsFromRows,
	collationsQuery,
} from '../../../lib/pma/charsets.ts';

import type { PmaContext } from './context.ts';

interface Loaded {
	charsets?: Map<string, Charset>;
	collations?: Map<string, Map<string, Collation>>;
}

const loaded = new WeakMap<PmaContext, Loaded>();

function cache(context: PmaContext): Loaded {
	let entry = loaded.get(context);
	if (entry === undefined) {
		entry = {};
		loaded.set(context, entry);
	}
	return entry;
}

/** Charsets::getCharsets(): keyed by name, sorted. */
export async function getCharsets(context: PmaContext): Promise<Map<string, Charset>> {
	const entry = cache(context);
	if (entry.charsets === undefined) {
		const sql = context.config.Server.DisableIS ? 'SHOW CHARACTER SET' : CHARSETS_QUERY;
		const result = await context.dbi.query(sql);
		entry.charsets = charsetsFromRows(result.fetchAllAssoc());
	}
	return entry.charsets;
}

/** Charsets::getCollations(): [charset][collation]. */
export async function getCollations(context: PmaContext): Promise<Map<string, Map<string, Collation>>> {
	const entry = cache(context);
	if (entry.collations === undefined) {
		const { dbi } = context;
		await dbi.connect();
		let sql = collationsQuery(dbi.isMariaDB(), dbi.getVersion());
		if (context.config.Server.DisableIS && !(dbi.isMariaDB() && dbi.getVersion() >= 101000)) {
			sql = 'SHOW COLLATION';
		}
		const result = await dbi.query(sql);
		entry.collations = collationsFromRows(result.fetchAllAssoc());
	}
	return entry.collations;
}

/** Charsets::findCollationByName(). */
export async function findCollationByName(context: PmaContext, name: string | null): Promise<Collation | null> {
	const charset = (name ?? '').split('_', 1)[0];
	const collations = await getCollations(context);
	return collations.get(charset)?.get(name ?? '') ?? null;
}

/** Charsets::getServerCharset(), with the utf8mb3 and unknown fallbacks. */
export async function getServerCharset(context: PmaContext): Promise<Charset> {
	const charsets = await getCharsets(context);
	let name = await context.dbi.getVariable('character_set_server');
	if (typeof name !== 'string') {
		name = await context.dbi.fetchValue('SELECT @@character_set_server;');
	}
	const found = charsets.get(String(name));
	if (found !== undefined) {
		return found;
	}
	if (name === 'utf8mb3' && charsets.has('utf8')) {
		return charsets.get('utf8') as Charset;
	}
	return Charset.fromServer({ Charset: 'Unknown', Description: 'Unknown' });
}

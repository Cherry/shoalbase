// The list parts of PhpMyAdmin\StorageEngine: SHOW STORAGE ENGINES, the drop-down array and the engine check.
import type { PmaContext } from './context.ts';
import type { DbiRow } from './dbi.ts';

export interface EngineOption {
	name: string;
	comment: string;
	is_default: boolean;
}

const loaded = new WeakMap<PmaContext, Map<string, DbiRow>>();

/** StorageEngine::getStorageEngines(): keyed by engine, with engines listed in @@disabled_storage_engines marked DISABLED. */
export async function getStorageEngines(context: PmaContext): Promise<Map<string, DbiRow>> {
	let engines = loaded.get(context);
	if (engines !== undefined) {
		return engines;
	}
	const { dbi } = context;
	engines = await dbi.fetchResult('SHOW STORAGE ENGINES', 'Engine');
	if (!dbi.isMariaDB() && dbi.getVersion() >= 50708) {
		const disabled = await dbi.fetchValue('SELECT @@disabled_storage_engines');
		for (const engine of String(disabled === false ? '' : disabled ?? '').split(',')) {
			const row = engines.get(engine);
			if (row !== undefined) {
				row.Support = 'DISABLED';
			}
		}
	}
	loaded.set(context, engines);
	return engines;
}

/** StorageEngine::getArray(): the engines a table can be created with. */
export async function getStorageEngineArray(context: PmaContext): Promise<Map<string, EngineOption>> {
	const options = new Map<string, EngineOption>();
	const engines = await getStorageEngines(context);
	for (const details of engines.values()) {
		if (details.Support === 'NO' || details.Support === 'DISABLED' || details.Engine === 'PERFORMANCE_SCHEMA') {
			continue;
		}
		const name = details.Engine ?? '';
		options.set(name, { name, comment: details.Comment ?? '', is_default: details.Support === 'DEFAULT' });
	}
	return options;
}

/** StorageEngine::isValid(). */
export async function isValidStorageEngine(context: PmaContext, engine: string): Promise<boolean> {
	if (engine === 'PBMS') {
		return true;
	}
	const engines = await getStorageEngines(context);
	return engines.has(engine);
}

/** StorageEngine::hasMroongaEngine(). */
export async function hasMroongaEngine(context: PmaContext): Promise<boolean> {
	return await context.dbi.tryQuery('SELECT mroonga_command(\'object_list\');') !== false;
}

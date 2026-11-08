// The small AJAX endpoints: database, table and column lists, and the config get/set pair behind Functions.configGet()/configSet().
import { configDefaults } from '../../../../lib/pma/config-defaults.ts';
import { arrayRead } from '../../../../lib/pma/config-forms.ts';
import { Message } from '../../../../lib/pma/message.ts';
import { setUserValue } from '../../../../lib/pma/user-preferences.ts';

import type { PmaContext } from '../../core/context.ts';

// PHP's json_decode() gives null for invalid input.
function jsonDecode(value: string): unknown {
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return null;
	}
}

function missingParameters(context: PmaContext): Promise<Response> {
	context.response.setRequestStatus(false);
	context.response.addJSON({ message: Message.error() });
	return context.response.response();
}

/** ColumnController. */
export async function columnController(context: PmaContext): Promise<Response> {
	const { db, table } = context.request.post;
	if (typeof db !== 'string' || typeof table !== 'string') {
		return missingParameters(context);
	}
	context.response.addJSON({ columns: await context.dbi.getColumnNames(db, table) });
	return context.response.response();
}

/** DatabaseController. */
export async function databaseController(context: PmaContext): Promise<Response> {
	// ListDatabase is an ArrayObject, which json_encode() writes as an object even with list keys.
	const list = await context.dbi.getDatabaseList();
	const databases = Object.fromEntries(list.map((name, index) => [String(index), name]));
	context.response.addJSON({ databases });
	return context.response.response();
}

/** TableController. */
export async function tableController(context: PmaContext): Promise<Response> {
	const { db } = context.request.post;
	if (typeof db !== 'string') {
		return missingParameters(context);
	}
	context.response.addJSON({ tables: await context.dbi.getTables(db) });
	return context.response.response();
}

/** Config\GetConfigController: Config::get() of a top-level setting, null when unset. */
export async function getConfigController(context: PmaContext): Promise<Response> {
	const { key } = context.request.post;
	if (typeof key !== 'string') {
		return missingParameters(context);
	}
	let value: unknown = (context.config as unknown as Record<string, unknown>)[key] ?? null;
	// Config::loadUserPreferences() records where preferences live; without pmadb that is the session.
	if (key === 'user_preferences') {
		value = 'session';
	}
	context.response.addJSON({ value });
	return context.response.response();
}

/** Config\SetConfigController: Config::setUserValue() with the JSON-decoded value, kept in the session preferences. */
export async function setConfigController(context: PmaContext): Promise<Response> {
	const { key, value } = context.request.post;
	if (typeof key !== 'string' || typeof value !== 'string') {
		return missingParameters(context);
	}
	const config = context.config as unknown as Record<string, unknown>;
	const defaultValue = arrayRead(key, configDefaults as unknown as Record<string, unknown>, null);
	setUserValue(context.session, config, key, jsonDecode(value), defaultValue, Math.floor(Date.now() / 1000));
	return context.response.response();
}

export const controllers = {
	'ColumnController': columnController,
	'DatabaseController': databaseController,
	'TableController': tableController,
	'Config/GetConfigController': getConfigController,
	'Config/SetConfigController': setConfigController,
};

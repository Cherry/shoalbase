// UserPreferences and Config::setUserValue() for production, where no pmadb exists and preferences live in the session.
import {
	applyUserPreferences,
	arrayRead,
	arrayWrite,
	replaceRecursive,
} from './config-forms.ts';

import type { PmaSession } from './session.ts';

export interface LoadedPreferences {
	/** path => value pairs, such as "Export/format" => "sql". */
	config_data: Record<string, unknown>;
	mtime: number;
	type: 'session';
}

/** UserPreferences::load(): the session copy, which starts empty. */
export function loadUserPreferences(session: PmaSession, now: number): LoadedPreferences {
	const stored = session.data.userconfig;
	return {
		config_data: { ...stored?.db },
		mtime: stored?.ts ?? now,
		type: 'session',
	};
}

/** UserPreferences::save(): replaces the stored preferences. */
export function saveUserPreferences(session: PmaSession, configData: Record<string, unknown>, now: number): void {
	session.data.userconfig = { db: configData, ts: now };
}

/** UserPreferences::persistOption(): stores one option, or forgets it when it is back to its default. */
export function persistOption(session: PmaSession, path: string, value: unknown, defaultValue: unknown, now: number): void {
	const prefs = loadUserPreferences(session, now);
	if (value === defaultValue) {
		if (!Object.hasOwn(prefs.config_data, path)) {
			return;
		}
		delete prefs.config_data[path];
	} else {
		prefs.config_data[path] = value;
	}
	saveUserPreferences(session, prefs.config_data, now);
}

/** Config::setUserValue() without a cookie name: persists the option and applies it to $cfg at once. */
export function setUserValue(session: PmaSession, config: Record<string, unknown>, path: string, value: unknown, defaultValue: unknown, now: number): void {
	persistOption(session, path, value, defaultValue, now);
	arrayWrite(path, config, value);
}

/** The part of Config::loadUserPreferences() that merges the stored preferences into $cfg. */
export function applySessionPreferences(session: PmaSession, config: Record<string, unknown>): void {
	const stored = session.data.userconfig?.db ?? {};
	const disallow = arrayRead('UserprefsDisallow', config, []) as string[];
	replaceRecursive(config, applyUserPreferences(stored, disallow));
}

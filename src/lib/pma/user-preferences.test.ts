import { describe, expect, it } from 'vitest';

import { createConfig } from './config.ts';
import { PmaSession } from './session.ts';
import {
	applySessionPreferences,
	loadUserPreferences,
	persistOption,
	saveUserPreferences,
	setUserValue,
} from './user-preferences.ts';

describe('session user preferences', () => {
	it('loads empty preferences with the current time until something is saved', () => {
		const session = new PmaSession();
		expect(loadUserPreferences(session, 100)).toEqual({ config_data: {}, mtime: 100, type: 'session' });
		expect(session.isChanged()).toBe(false);
		saveUserPreferences(session, { MaxRows: 50 }, 200);
		expect(loadUserPreferences(session, 300)).toEqual({ config_data: { MaxRows: 50 }, mtime: 200, type: 'session' });
	});

	it('persists an option, and forgets it again once it is back to its default', () => {
		const session = new PmaSession();
		persistOption(session, 'DefaultConnectionCollation', 'utf8mb4_bin', 'utf8mb4_unicode_ci', 1);
		expect(session.data.userconfig?.db).toEqual({ DefaultConnectionCollation: 'utf8mb4_bin' });
		persistOption(session, 'DefaultConnectionCollation', 'utf8mb4_unicode_ci', 'utf8mb4_unicode_ci', 2);
		expect(session.data.userconfig).toEqual({ db: {}, ts: 2 });
		persistOption(session, 'ThemeDefault', 'original', 'original', 3);
		expect(session.data.userconfig?.ts).toBe(2);
	});

	it('applies a set value to $cfg at once and merges stored preferences into a fresh config', () => {
		const session = new PmaSession();
		const config = createConfig({ host: 'h' }) as unknown as Record<string, unknown>;
		setUserValue(session, config, 'Export/format', 'csv', 'sql', 1);
		expect((config.Export as Record<string, unknown>).format).toBe('csv');

		const fresh = createConfig({ host: 'h' }) as unknown as Record<string, unknown>;
		session.data.userconfig = { db: { 'Export/format': 'csv', 'MaxRows': 50, 'blowfish_secret': 'nope' }, ts: 1 };
		applySessionPreferences(session, fresh);
		expect((fresh.Export as Record<string, unknown>).format).toBe('csv');
		expect((fresh.Export as Record<string, unknown>).charset).toBe('');
		expect(fresh.MaxRows).toBe(50);
		expect(fresh.blowfish_secret).toBe('');
	});

	it('leaves the config alone without stored preferences and honours UserprefsDisallow', () => {
		const config = createConfig({ host: 'h' }) as unknown as Record<string, unknown>;
		applySessionPreferences(new PmaSession(), config);
		expect(config.MaxRows).toBe(25);
		config.UserprefsDisallow = ['MaxRows'];
		applySessionPreferences(new PmaSession({ userconfig: { db: { MaxRows: 50 }, ts: 1 } }), config);
		expect(config.MaxRows).toBe(25);
	});
});

import { describe, expect, it } from 'vitest';

import {
	activeThemeId,
	isInstalledTheme,
	themeCookieName,
	themesArray,
} from './themes.ts';

describe('themes', () => {
	it('names the theme cookie per server only with ThemePerServer', () => {
		expect(themeCookieName(false, 3)).toBe('pma_theme');
		expect(themeCookieName(true, 3)).toBe('pma_theme-3');
	});

	it('prefers a valid cookie, then ThemeDefault, then pmahomme', () => {
		expect(activeThemeId('metro', 'pmahomme')).toBe('metro');
		expect(activeThemeId('nope', 'original')).toBe('original');
		expect(activeThemeId(undefined, 'missing')).toBe('pmahomme');
	});

	it('only accepts installed theme ids', () => {
		expect(isInstalledTheme('bootstrap')).toBe(true);
		expect(isInstalledTheme('Bootstrap')).toBe(false);
		expect(isInstalledTheme(['metro'])).toBe(false);
	});

	it('lists themes in directory order with the active one marked, as the home page shows them', () => {
		expect(themesArray('pmahomme')).toEqual([
			{ id: 'bootstrap', name: 'Bootstrap', version: '5.1', is_active: false },
			{ id: 'metro', name: 'Metro', version: '5.0', is_active: false },
			{ id: 'original', name: 'Original', version: '5.0', is_active: false },
			{ id: 'pmahomme', name: 'pmahomme', version: '5.0', is_active: true },
		]);
	});
});

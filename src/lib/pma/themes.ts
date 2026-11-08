// Port of the parts of PhpMyAdmin\ThemeManager the page needs: the installed themes and which one is active.

export interface ThemeInfo {
	id: string;
	name: string;
	version: string;
}

/** ThemeManager::FALLBACK_THEME. */
export const FALLBACK_THEME = 'pmahomme';

/** The themes under public/themes, in ThemeManager::loadThemes() order, with name and version from their theme.json. */
export const installedThemes: readonly ThemeInfo[] = [
	{ id: 'bootstrap', name: 'Bootstrap', version: '5.1' },
	{ id: 'metro', name: 'Metro', version: '5.0' },
	{ id: 'original', name: 'Original', version: '5.0' },
	{ id: 'pmahomme', name: 'pmahomme', version: '5.0' },
];

export function isInstalledTheme(id: unknown): id is string {
	return typeof id === 'string' && installedThemes.some(theme => theme.id === id);
}

/** ThemeManager::getThemeCookieName() before Config::getCookieName() adds the HTTPS decoration. */
export function themeCookieName(perServer: boolean, server: number): string {
	if (perServer) {
		return `pma_theme-${server}`;
	}
	return 'pma_theme';
}

/** ThemeManager::__construct(): a valid theme cookie wins, then $cfg['ThemeDefault'], then the fallback theme. */
export function activeThemeId(cookieTheme: string | undefined, themeDefault: string): string {
	if (isInstalledTheme(cookieTheme)) {
		return cookieTheme;
	}
	if (isInstalledTheme(themeDefault)) {
		return themeDefault;
	}
	return FALLBACK_THEME;
}

/** ThemeManager::getThemesArray(). */
export function themesArray(activeId: string): { id: string; name: string; version: string; is_active: boolean; }[] {
	return installedThemes.map((theme) => {
		return { ...theme, is_active: theme.id === activeId };
	});
}

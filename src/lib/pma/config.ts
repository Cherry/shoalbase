// The effective $cfg of production: config.default.php overlaid with config.user.inc.php, as PhpMyAdmin\Config builds it.
import { configDefaults, serverDefaults } from './config-defaults.ts';

import type { ShellConfig } from './header.ts';

/** $cfg['Servers'][$i], and $cfg['Server'] once a server is selected. */
export type ServerSettings = typeof serverDefaults;

/** $cfg after Config::selectServer(); every key of config.default.php is present and typed. */
export type PmaConfig = typeof configDefaults & { Server: ServerSettings; };

/** Top-level keys production's config.user.inc.php changes. */
export const productionOverrides = {
	DisplayServersList: false,
	ShowServerInfo: false,
	MaxExactCount: 0,
	MaxExactCountViews: 0,
	UploadDir: '',
	SaveDir: '',
	// The phpmyadmin Docker image copies its MAX_EXECUTION_TIME and MEMORY_LIMIT defaults into $cfg.
	ExecTimeLimit: 600,
	MemoryLimit: '512M',
} satisfies Partial<typeof configDefaults>;

/** Keys production's config.user.inc.php sets on every server entry; its connect_type is not a 5.2 setting and changes nothing. */
export const productionServerOverrides = {
	auth_type: 'cookie',
	compress: false,
	AllowNoPassword: false,
} satisfies Partial<ServerSettings>;

export interface SelectedServer {
	/** $cfg['Servers'][$i]['host']. */
	host: string;
	/** Only production's TLS hosts set ssl. */
	ssl?: boolean;
	/** The signed-in account, which AuthenticationCookie::authenticate() stores in $cfg['Server']['user']. */
	user?: string;
}

/** $GLOBALS['cfg'] for a request on the given server; production never sets a port, so it stays ''. */
export function createConfig(server: SelectedServer): PmaConfig {
	const selected: ServerSettings = {
		...serverDefaults,
		...productionServerOverrides,
		host: server.host,
		ssl: server.ssl ?? false,
	};
	if (server.user !== undefined) {
		selected.user = server.user;
	}
	return { ...structuredClone(configDefaults), ...productionOverrides, Server: selected };
}

/** The $cfg keys the page shell reads, taken from the effective config. */
export function shellConfig(config: PmaConfig): ShellConfig {
	return {
		AllowThirdPartyFraming: config.AllowThirdPartyFraming,
		CodemirrorEnable: config.CodemirrorEnable,
		LintEnable: config.LintEnable,
		SendErrorReports: config.SendErrorReports as ShellConfig['SendErrorReports'],
		enable_drag_drop_import: config.enable_drag_drop_import,
		DisableShortcutKeys: config.DisableShortcutKeys,
		ConsoleEnterExecutes: config.ConsoleEnterExecutes,
		FirstDayOfCalendar: config.FirstDayOfCalendar,
		LimitChars: config.LimitChars,
		Confirm: config.Confirm,
		LoginCookieValidity: config.LoginCookieValidity,
		DefaultTabDatabase: config.DefaultTabDatabase as ShellConfig['DefaultTabDatabase'],
		GridEditing: config.GridEditing as ShellConfig['GridEditing'],
		ShowHint: config.ShowHint,
		CSPAllow: config.CSPAllow,
	};
}

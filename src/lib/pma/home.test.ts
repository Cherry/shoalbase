import { describe, expect, it } from 'vitest';

import { createConfig } from './config.ts';
import { configStorageMessage, hasServerSelection, requirementErrors } from './home.ts';

describe('hasServerSelection', () => {
	it('shows the server list with several servers, or always when ServerDefault is 0', () => {
		const config = createConfig({ host: 'db' });
		expect(hasServerSelection(config, 1, 2)).toBe(true);
		expect(hasServerSelection(config, 1, 1)).toBe(false);
		expect(hasServerSelection(config, 0, 1)).toBe(true);
		expect(hasServerSelection({ ...config, NavigationDisplayServers: false }, 1, 5)).toBe(false);
		expect(hasServerSelection({ ...config, ServerDefault: 0, NavigationDisplayServers: false }, 1, 1)).toBe(true);
	});
});

describe('requirementErrors', () => {
	it('has nothing to report for the production configuration', () => {
		expect(requirementErrors(createConfig({ host: 'db' }), 1, 1440)).toEqual([]);
	});

	it('warns about short session lifetimes, a short cookie store and the default control user', () => {
		const config = createConfig({ host: 'db' });
		config.LoginCookieStore = 600;
		config.Server.controluser = 'pma';
		config.Server.controlpass = 'pmapass';
		const errors = requirementErrors(config, 1, 1000);
		expect(errors.map(error => error.severity)).toEqual(['warning', 'warning', 'warning']);
		expect(errors[0].message).toContain('[a@https://www.php.net/manual/en/session.configuration.php#ini.session.gc-maxlifetime@_blank]session.gc_maxlifetime[/a]');
		expect(errors[1].message).toMatch(/^Login cookie store is lower/);
		expect(errors[2].message).toMatch(/controluser 'pma'\.$/);
		// Without a server the control user is not in use yet, and the session warning can be switched off.
		config.LoginCookieValidityDisableWarning = true;
		expect(requirementErrors(config, 0, 1000)).toHaveLength(1);
	});
});

describe('configStorageMessage', () => {
	it('renders the notice the oracle shows without a pmadb', () => {
		const message = configStorageMessage(createConfig({ host: 'db' }), 'index.php?route=/check-relations', '');
		expect(message?.getDisplay()).toBe('<div class="alert alert-primary" role="alert">\n  <img src="themes/dot.gif" title="" alt="" class="icon ic_s_notice"> The phpMyAdmin configuration storage is not completely configured, some extended features have been deactivated. <a href="index.php?route=/check-relations" data-post="">Find out why</a>. <br>Or alternately go to \'Operations\' tab of any database to set it up there.\n</div>\n');
	});

	it('turns into an error when a pmadb is configured, drops the ZeroConf hint and can be disabled', () => {
		const config = createConfig({ host: 'db' });
		config.ZeroConf = false;
		config.Server.pmadb = 'phpmyadmin';
		const message = configStorageMessage(config, 'x', '?lang=en');
		expect(message?.isError()).toBe(true);
		expect(message?.getMessage()).not.toContain('Operations');
		expect(message?.getMessage()).toContain('data-post="?lang=en"');
		expect(configStorageMessage({ ...config, PmaNoRelation_DisableWarning: true }, 'x', '')).toBeNull();
	});
});

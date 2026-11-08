import { describe, expect, it } from 'vitest';

import { createConfig, shellConfig } from './config.ts';
import { defaultShellConfig } from './header.ts';

describe('createConfig', () => {
	it('applies the production overrides on top of the upstream defaults', () => {
		const config = createConfig({ host: 'db1.example.com' });

		expect(config.ShowServerInfo).toBe(false);
		expect(config.DisplayServersList).toBe(false);
		expect(config.MaxExactCount).toBe(0);
		expect(config.MaxExactCountViews).toBe(0);
		expect(config.UploadDir).toBe('');
		expect(config.SaveDir).toBe('');
		// Untouched defaults the controllers rely on.
		expect(config.NaturalOrder).toBe(true);
		expect(config.MaxDbList).toBe(100);
		expect(config.MaxTableList).toBe(250);
		expect(config.ZeroConf).toBe(true);
		expect(config.ServerDefault).toBe(1);
		expect(config.TitleTable).toBe('@HTTP_HOST@ / @VSERVER@ / @DATABASE@ / @TABLE@ | @PHPMYADMIN@');
	});

	it('selects the server like Config::selectServer() with production server settings', () => {
		const config = createConfig({ host: 'db2.example.com', ssl: true, user: 'customer' });

		expect(config.Server).toMatchObject({
			host: 'db2.example.com',
			port: '',
			ssl: true,
			auth_type: 'cookie',
			compress: false,
			AllowNoPassword: false,
			user: 'customer',
			DisableIS: false,
			only_db: '',
			hide_db: '',
			verbose: '',
			SessionTimeZone: '',
		});
	});

	it('keeps the default "root" user until a login stores the real one', () => {
		expect(createConfig({ host: 'localhost' }).Server).toMatchObject({ user: 'root', ssl: false });
	});

	it('gives each request its own copy so a controller cannot leak changes', () => {
		const first = createConfig({ host: 'a' });
		first.DBG.sql = true;
		first.Server.host = 'changed';

		const second = createConfig({ host: 'b' });
		expect(second.DBG.sql).toBe(false);
		expect(second.Server.host).toBe('b');
	});
});

describe('shellConfig', () => {
	it('matches the shell defaults the page renderer was ported against', () => {
		expect(shellConfig(createConfig({ host: 'localhost' }))).toEqual(defaultShellConfig);
	});
});

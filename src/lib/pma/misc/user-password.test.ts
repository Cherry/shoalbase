import { describe, expect, it } from 'vitest';

import { changePasswordMessage, changePasswordQueries } from './user-password.ts';

describe('changePasswordMessage', () => {
	it('checks the two password fields unless "no password" is chosen', () => {
		expect(changePasswordMessage(false, '', 'a').message.getMessage()).toBe('The password is empty!');
		expect(changePasswordMessage(false, ['a'], 'a').error).toBe(true);
		expect(changePasswordMessage(false, 'a', 7).error).toBe(true);
		expect(changePasswordMessage(false, 'a', 'b').message.getMessage()).toBe('The passwords aren\'t the same!');
		expect(changePasswordMessage(false, 'é'.repeat(129), 'é'.repeat(129)).message.getMessage()).toBe('Password is too long!');
		expect(changePasswordMessage(false, 'a'.repeat(256), 'a'.repeat(256)).error).toBe(false);
		const none = changePasswordMessage(true, undefined, undefined);
		expect(none.error).toBe(false);
		expect(none.message.getMessage()).toBe('The profile has been updated.');
	});
});

describe('changePasswordQueries', () => {
	const base = { username: 'cu\'st', hostname: '%', plugin: 'mysql_native_password', requestedPlugin: '', password: 'p\'w', escape: (value: string) => value.replaceAll('\'', String.raw`\'`), isMariaDB: false };

	it('uses ALTER USER on MySQL 5.7.6 and later, naming the plugin only when needed', () => {
		const current = changePasswordQueries({ ...base, version: 80400 });
		expect(current).toEqual({
			shown: String.raw`ALTER USER 'cu\'st'@'%' IDENTIFIED BY '***'`,
			real: String.raw`ALTER USER 'cu\'st'@'%' IDENTIFIED BY 'p\'w'`,
			oldPasswords: null,
		});
		expect(changePasswordQueries({ ...base, version: 80400, requestedPlugin: 'caching_sha2_password' }).shown)
			.toBe(String.raw`ALTER USER 'cu\'st'@'%' IDENTIFIED WITH caching_sha2_password BY '***'`);
		expect(changePasswordQueries({ ...base, version: 50720, password: '' }).shown)
			.toBe(String.raw`ALTER USER 'cu\'st'@'%' IDENTIFIED WITH mysql_native_password BY ''`);
	});

	it('sets old_passwords and uses SET password elsewhere', () => {
		expect(changePasswordQueries({ ...base, version: 120300, isMariaDB: true })).toEqual({
			shown: 'SET password = PASSWORD(\'***\')',
			real: String.raw`SET password = PASSWORD('p\'w')`,
			oldPasswords: 0,
		});
		expect(changePasswordQueries({ ...base, version: 50600, requestedPlugin: 'sha256_password' }).oldPasswords).toBe(2);
		expect(changePasswordQueries({ ...base, version: 50600, requestedPlugin: '0' }).oldPasswords).toBe(0);
		expect(changePasswordQueries({ ...base, version: 50100, requestedPlugin: 'mysql_old_password' }))
			.toEqual({ shown: 'SET password = OLD_PASSWORD(\'***\')', real: String.raw`SET password = OLD_PASSWORD('p\'w')`, oldPasswords: null });
		expect(changePasswordQueries({ ...base, version: 100100, isMariaDB: true, password: '' }).real).toBe('SET password = \'\'');
	});
});

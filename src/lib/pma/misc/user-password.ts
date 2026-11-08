// UserPassword's checks and queries: which statement changes the signed-in account's password on each server.
import { Message } from '../message.ts';

/** UserPassword::setChangePasswordMsg(). */
export function changePasswordMessage(noPassword: boolean, password: unknown, confirmation: unknown): { error: boolean; message: Message; } {
	if (!noPassword) {
		const first = typeof password === 'string' ? password : '';
		const second = typeof confirmation === 'string' ? confirmation : '';
		if (first === '' || second === '') {
			return { error: true, message: Message.error('The password is empty!') };
		}
		if (first !== second) {
			return { error: true, message: Message.error('The passwords aren\'t the same!') };
		}
		// strlen() counts bytes.
		if (new TextEncoder().encode(first).length > 256) {
			return { error: true, message: Message.error('Password is too long!') };
		}
	}
	return { error: false, message: Message.success('The profile has been updated.') };
}

export interface ChangePasswordInput {
	version: number;
	isMariaDB: boolean;
	username: string;
	hostname: string;
	/** Privileges::getCurrentAuthenticationPlugin('change', ...). */
	plugin: string;
	/** $_POST['authentication_plugin']. */
	requestedPlugin: string;
	password: string;
	escape: (value: string) => string;
}

export interface ChangePasswordQueries {
	/** The statement shown to the user, with the password masked. */
	shown: string;
	/** The statement that is run. */
	real: string;
	/** The `old_passwords` value to set first, or null. */
	oldPasswords: number | null;
}

/** UserPassword::getChangePasswordQueryAlterUserMySQL(). */
function alterUser(input: ChangePasswordInput, plugin: string, password: string, pluginChanged: boolean): string {
	const quoted = password === '' ? '\'\'' : `'${input.escape(password)}'`;
	const account = `'${input.escape(input.username)}'@'${input.escape(input.hostname)}'`;
	// MySQL 5.7.37 and later refuse IDENTIFIED WITH without CREATE USER, so the plugin is only named when it changes.
	if (input.version < 50737) {
		return `ALTER USER ${account} IDENTIFIED WITH ${plugin} BY ${quoted}`;
	}
	return `ALTER USER ${account} IDENTIFIED${pluginChanged ? ` WITH ${plugin}` : ''} BY ${quoted}`;
}

/** UserPassword::changePassword() and changePassUrlParamsAndSubmitQuery(), without MariaDB 5.2 to 10.0's mysql.user update. */
export function changePasswordQueries(input: ChangePasswordInput): ChangePasswordQueries {
	const hashing = input.requestedPlugin === 'mysql_old_password' ? 'OLD_PASSWORD' : 'PASSWORD';
	let plugin = input.plugin;
	let pluginChanged = false;
	if (input.requestedPlugin !== '' && input.requestedPlugin !== '0') {
		pluginChanged = plugin !== input.requestedPlugin;
		plugin = input.requestedPlugin;
	}
	const isMySql = !input.isMariaDB;
	if (isMySql && input.version >= 50706) {
		return {
			shown: alterUser(input, plugin, input.password === '' ? '' : '***', pluginChanged),
			real: alterUser(input, plugin, input.password, pluginChanged),
			oldPasswords: null,
		};
	}
	let oldPasswords: number | null = null;
	if ((isMySql && input.version >= 50507) || (input.isMariaDB && input.version >= 50200)) {
		oldPasswords = plugin === 'sha256_password' ? 2 : 0;
	}
	let shown = 'SET password = \'\'';
	let real = shown;
	if (input.password !== '') {
		shown = `SET password = ${hashing}('***')`;
		real = `SET password = ${hashing}('${input.escape(input.password)}')`;
	}
	return { shown, real, oldPasswords };
}

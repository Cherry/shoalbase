// Pure parts of PhpMyAdmin\Controllers\HomeController: server selection and the configuration warnings.
import { Message } from './message.ts';

import type { PmaConfig } from './config.ts';

export interface HomeError {
	message: string;
	severity: 'warning' | 'notice';
}

/** HomeController's $hasServerSelection. */
export function hasServerSelection(config: Pick<PmaConfig, 'ServerDefault' | 'NavigationDisplayServers'>, server: number, serverCount: number): boolean {
	if (config.ServerDefault === 0) {
		return true;
	}
	return config.NavigationDisplayServers && (serverCount > 1 || (server === 0 && serverCount === 1));
}

type RequirementConfig = Pick<PmaConfig, 'LoginCookieValidityDisableWarning' | 'LoginCookieValidity' | 'LoginCookieStore'> & {
	Server: Pick<PmaConfig['Server'], 'controluser' | 'controlpass'>;
};

/**
 * HomeController::checkRequirements() for the checks that depend on configuration. The PHP environment checks
 * (mbstring, curl, Suhosin, the config directory, TempDir, HTTP_HOST, translations) have no counterpart on Workers,
 * and cookie encryption uses PMA_COOKIE_SECRET instead of blowfish_secret, so those warnings never apply.
 */
export function requirementErrors(config: RequirementConfig, server: number, gcMaxlifetime: number): HomeError[] {
	const errors: HomeError[] = [];
	if (!config.LoginCookieValidityDisableWarning && gcMaxlifetime < config.LoginCookieValidity) {
		errors.push({
			message: 'Your PHP parameter [a@https://www.php.net/manual/en/session.configuration.php#ini.session.gc-maxlifetime@_blank]session.gc_maxlifetime[/a] is lower than cookie validity configured in phpMyAdmin, because of this, your login might expire sooner than configured in phpMyAdmin.',
			severity: 'warning',
		});
	}
	if (config.LoginCookieStore !== 0 && config.LoginCookieStore < config.LoginCookieValidity) {
		errors.push({
			message: 'Login cookie store is lower than cookie validity configured in phpMyAdmin, because of this, your login will expire sooner than configured in phpMyAdmin.',
			severity: 'warning',
		});
	}
	if (server !== 0 && config.Server.controluser === 'pma' && config.Server.controlpass === 'pmapass') {
		errors.push({
			message: 'Your server is running with default values for the controluser and password (controlpass) and is open to intrusion; you really should fix this security weakness by changing the password for controluser \'pma\'.',
			severity: 'warning',
		});
	}
	return errors;
}

/**
 * The notice HomeController shows when configuration storage is incomplete, which is always the case without a pmadb.
 * `checkRelationsLink` is Url::getFromRoute('/check-relations') and `commonQuery` is Url::getCommon().
 */
export function configStorageMessage(config: Pick<PmaConfig, 'PmaNoRelation_DisableWarning' | 'ZeroConf'> & { Server: { pmadb: string; }; }, checkRelationsLink: string, commonQuery: string): Message | null {
	if (config.PmaNoRelation_DisableWarning) {
		return null;
	}
	let text = 'The phpMyAdmin configuration storage is not completely configured, some extended features have been deactivated. %sFind out why%s. ';
	if (config.ZeroConf) {
		text += '<br>Or alternately go to \'Operations\' tab of any database to set it up there.';
	}
	const message = Message.notice(text);
	message.addParamHtml(`<a href="${checkRelationsLink}" data-post="${commonQuery}">`);
	message.addParamHtml('</a>');
	if (config.Server.pmadb !== '') {
		message.isError(true);
	}
	return message;
}

// UserPasswordController with UserPassword and the parts of Server\Privileges it uses: the "Change password" page.
import { Message } from '../../../../lib/pma/message.ts';
import { changePasswordMessage, changePasswordQueries } from '../../../../lib/pma/misc/user-password.ts';
import { isNumericString } from '../../../../lib/pma/php-compare.ts';
import { getFromRoute } from '../../../../lib/twig/url.ts';
import { storeChangedPassword } from '../../../auth-runtime.ts';
import { renderTemplate } from '../../../twig/render.ts';
import { getMessage } from '../../core/generator.ts';
import { internalErrorPage } from '../database/common.ts';
import { mysqlDieMessage } from '../server/mysql-die.ts';

import type { PmaContext } from '../../core/context.ts';
import type { ControllerContext } from '../../dispatcher.ts';

/** Privileges::getCurrentAuthenticationPlugin('change', ...): the account's plugin when mysql.user is readable. */
async function currentAuthenticationPlugin(context: PmaContext, username: string, hostname: string): Promise<string> {
	const { dbi } = context;
	const row = await dbi.fetchSingleRow(`SELECT \`plugin\` FROM \`mysql\`.\`user\` WHERE \`User\` = "${dbi.escapeString(username)}" AND \`Host\` = "${dbi.escapeString(hostname)}" LIMIT 1`);
	if (row !== null && row.plugin !== undefined && row.plugin !== null) {
		return String(row.plugin);
	}
	return 'mysql_native_password';
}

const hasMoreAuthPlugins = (context: PmaContext): boolean => context.dbi.isMySql() && context.dbi.getVersion() >= 50706;

/** Privileges::getFormForChangePassword($username, $hostname, false). */
async function changePasswordForm(context: PmaContext, username: string, hostname: string): Promise<string> {
	const { dbi } = context;
	const version = dbi.getVersion();
	const origAuthPlugin = await currentAuthenticationPlugin(context, username, hostname);
	const isNew = (dbi.isMySql() && version >= 50507) || (dbi.isMariaDB() && version >= 50200);
	let activeAuthPlugins: Record<string, string> = { mysql_native_password: 'Native MySQL authentication' };
	if (isNew && hasMoreAuthPlugins(context)) {
		// Plugins::getAuthentication(), without the old MySQL 4.0 hashing.
		const result = await dbi.query('SELECT `PLUGIN_NAME`, `PLUGIN_DESCRIPTION` FROM `information_schema`.`PLUGINS` WHERE `PLUGIN_TYPE` = \'AUTHENTICATION\';');
		activeAuthPlugins = {};
		for (const row of result.fetchAllAssoc()) {
			const name = String(row.PLUGIN_NAME);
			if (name !== 'mysql_old_password') {
				activeAuthPlugins[name] = String(row.PLUGIN_DESCRIPTION);
			}
		}
	}
	return renderTemplate('server/privileges/change_password', {
		username,
		hostname,
		is_privileges: false,
		is_new: isNew,
		has_more_auth_plugins: hasMoreAuthPlugins(context),
		active_auth_plugins: activeAuthPlugins,
		orig_auth_plugin: origAuthPlugin,
	}, await context.templateState());
}

/** UserPassword::changePassword(): runs the change and returns the masked query shown to the user, or the mysqlDie() error box. */
async function changePassword(context: ControllerContext, password: string): Promise<{ sqlQuery: string; error: string | null; }> {
	const { dbi, request } = context;
	const requested = typeof request.post.authentication_plugin === 'string' ? request.post.authentication_plugin : '';
	const [username = '', hostname = ''] = await dbi.getCurrentUserAndHost();
	const version = dbi.getVersion();
	const plugin = await currentAuthenticationPlugin(context, username, hostname);
	const queries = changePasswordQueries({
		version,
		isMariaDB: dbi.isMariaDB(),
		username,
		hostname,
		plugin,
		requestedPlugin: requested,
		password,
		escape: value => dbi.escapeString(value),
	});
	if (queries.oldPasswords !== null) {
		await dbi.tryQuery(`SET \`old_passwords\` = ${queries.oldPasswords};`);
	}
	if (await dbi.tryQuery(queries.real) === false) {
		return { sqlQuery: queries.shown, error: mysqlDieMessage(context, dbi.getError(), queries.shown, false) };
	}
	await dbi.tryQuery('FLUSH PRIVILEGES;');
	// AuthenticationCookie::handlePasswordChange(): the login cookie keeps working with the new password.
	const auth = context.astro.locals.auth;
	if (auth !== undefined) {
		await storeChangedPassword(context.astro.cookies, context.astro.url, auth, password);
	}
	return { sqlQuery: queries.shown, error: null };
}

export async function userPasswordController(context: ControllerContext): Promise<Response> {
	const { config, request, response } = context;
	response.addScriptFiles(['server/privileges.js', 'vendor/zxcvbn-ts.js']);
	let showChangePassword = config.ShowChgPassword;
	if (!showChangePassword) {
		showChangePassword = await context.dbi.selectDb('mysql');
	}
	if (config.Server.auth_type === 'config' || !showChangePassword) {
		response.addHTML(Message.error('You don\'t have sufficient privileges to be here right now!').getDisplay());
		return response.response();
	}
	let message: Message | null = null;
	const { nopass, pma_pw: newPassword, pma_pw2: confirmation } = request.post;
	if (nopass !== undefined) {
		let noPassword = false;
		if (typeof nopass === 'string') {
			noPassword = isNumericString(nopass) ? Number(nopass) === 1 : nopass === '1';
		}
		let password = '';
		if (!noPassword) {
			// setChangePasswordMsg() runs strlen() on both fields under strict types, stopping at an empty first one.
			if (typeof newPassword !== 'string' || (newPassword !== '' && typeof confirmation !== 'string')) {
				return internalErrorPage(context, 'TypeError');
			}
			password = newPassword;
		}
		const checked = changePasswordMessage(noPassword, newPassword, confirmation);
		message = checked.message;
		if (!checked.error) {
			await context.dbi.connect();
			const changed = await changePassword(context, password);
			if (changed.error !== null) {
				// Generator::mysqlDie() then exit: AJAX gets the bare error, a page also gets the link back to this form.
				if (response.isAjax) {
					response.setRequestStatus(false);
					response.addJSON('message', changed.error);
					return response.response();
				}
				const back = `${getFromRoute(context.urlState(), '/user-password')}&amp;no_history=true`;
				response.addHTML(`${changed.error}<fieldset class="pma-fieldset tblFooters">[ <a href="${back}">Back</a> ]</fieldset>\n\n`);
				return response.response();
			}
			const html = await getMessage(context, checked.message, { sqlQuery: changed.sqlQuery, type: 'success' });
			if (response.isAjax) {
				response.addJSON('message', html);
				return response.response();
			}
			response.addHTML('<h1>Change password</h1>\n\n');
			response.addHTML(html);
			response.addHTML(await renderTemplate('user_password', {}, await context.templateState()));
			return response.response();
		}
		if (response.isAjax) {
			response.addJSON('message', checked.message);
			response.setRequestStatus(false);
			return response.response();
		}
	}
	if (message !== null) {
		response.addHTML(message.getDisplay());
	}
	await context.dbi.connect();
	response.addHTML(await changePasswordForm(context, '', ''));
	return response.response();
}


export const controllers = {
	UserPasswordController: userPasswordController,
};

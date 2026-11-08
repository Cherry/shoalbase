// Preferences\TwoFactorController without pmadb: TwoFactor is not writable, so only the status and the "no 2FA" choice apply.
import { disableNaviSettings, nowSeconds, renderPreferencesHeader } from './preferences-forms.ts';
import { Message } from '../../../../lib/pma/message.ts';
import { persistOption } from '../../../../lib/pma/user-preferences.ts';
import { renderTemplate } from '../../../twig/render.ts';

import type { PmaContext } from '../../core/context.ts';

// TwoFactor::getAllBackends() with the 5.2.3 image's optional packages installed.
const BACKENDS = [
	{ id: '', name: 'No Two-Factor Authentication', description: 'Login using password only.' },
	{ id: 'application', name: 'Authentication Application (2FA)', description: 'Provides authentication using HOTP and TOTP applications such as FreeOTP, Google Authenticator or Authy.' },
	{ id: 'WebAuthn', name: 'Hardware Security Key (WebAuthn/FIDO2)', description: 'Provides authentication using hardware security tokens supporting the WebAuthn/FIDO2 protocol, such as a YubiKey.' },
	{ id: 'key', name: 'Hardware Security Key (FIDO U2F)', description: 'Provides authentication using hardware security tokens supporting FIDO U2F, such as a YubiKey.' },
];

/** TwoFactor::configure('') then save(): the stored setting loses its type key. */
function configureNone(context: PmaContext): void {
	persistOption(context.session, '2fa', { backend: '', settings: [] }, null, nowSeconds());
}

export async function twoFactorController(context: PmaContext): Promise<Response> {
	const { request, response } = context;
	const state = await context.templateState();
	response.addHTML(await renderPreferencesHeader(context));
	if (request.post['2fa_remove'] !== undefined) {
		// Without a configured backend, TwoFactor::check(true) always passes.
		configureNone(context);
		response.addHTML(Message.rawNotice('Two-factor authentication has been removed.').getDisplay());
	} else if (request.post['2fa_configure'] === '') {
		configureNone(context);
		response.addHTML(Message.rawNotice('Two-factor authentication has been configured.').getDisplay());
	}
	response.addHTML(await renderTemplate('preferences/two_factor/main', {
		enabled: false,
		num_backends: BACKENDS.length - 1,
		backend_id: '',
		backend_name: 'No Two-Factor Authentication',
		backend_description: 'Login using password only.',
		backends: BACKENDS,
		missing: [],
	}, state));
	disableNaviSettings(context);
	return response.response();
}

export const controllers = {
	'Preferences/TwoFactorController': twoFactorController,
};

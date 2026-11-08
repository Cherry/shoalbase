// Port of Controllers\NavigationController (route /navigation): the AJAX loader of the navigation tree.
import { renderNaviSettings } from './navigation-settings.ts';
import { getNavigationDisplay } from './navigation.ts';
import { Message } from '../../../lib/pma/message.ts';

import type { PmaContext } from '../core/context.ts';

/** Hiding items and the unhide dialog need pmadb, so those requests fall through to the tree like upstream does without it. */
export async function navigationController(context: PmaContext): Promise<Response> {
	const { response } = context;
	if (!response.isAjax) {
		response.addHTML(Message.error('Fatal error: The navigation can only be accessed via AJAX').getDisplay());
		return response.response();
	}
	const getNaviSettings = context.request.post.getNaviSettings;
	if (getNaviSettings !== undefined && getNaviSettings !== '' && getNaviSettings !== '0') {
		const pageSettings = await renderNaviSettings(context);
		if (!pageSettings.saved) {
			response.addHTML(pageSettings.errorHtml);
			response.addJSON('message', pageSettings.html);
		}
		return response.response();
	}
	response.addJSON('message', await getNavigationDisplay(context));
	return response.response();
}

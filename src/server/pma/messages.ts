// Port of js/messages.php (JavaScriptMessagesController): the translated Messages object the frontend reads.
import { type ShellConfig, defaultShellConfig } from '../../lib/pma/header.ts';
import { getJavaScriptMessages } from '../../lib/pma/js-messages.ts';
import { phpJsonEncode } from '../../lib/pma/json.ts';
import { themeImagePath } from '../../lib/twig/html.ts';
import { type TemplateStateInput, createTemplateState } from '../twig/state.ts';

export interface JavaScriptMessagesResponse {
	body: string;
	headers: [string, string][];
}

/**
 * Body and headers of js/messages.php?l=<lang>. Upstream only sends Content-Type and a one-hour Expires
 * (no Cache-Control), since the v= and l= query parameters already bust caches.
 */
export function renderJavaScriptMessages(state: TemplateStateInput, now: Date, config: ShellConfig = defaultShellConfig): JavaScriptMessagesResponse {
	const { catalog, themeImages, themeImgPath } = createTemplateState(state);
	const messages = getJavaScriptMessages({
		catalog,
		gridEditing: config.GridEditing,
		ajaxClockSmallGifPath: themeImagePath(themeImages, themeImgPath, 'ajax_clock_small.gif'),
	});
	return {
		body: `var Messages = ${phpJsonEncode(messages)};`,
		headers: [
			['Content-Type', 'text/javascript; charset=UTF-8'],
			['Expires', new Date(now.getTime() + 3_600_000).toUTCString()],
		],
	};
}

// Port of PhpMyAdmin\Console::getDisplay() for servers without phpMyAdmin configuration storage, as in prod.
import { getImage } from '../../../lib/twig/html.ts';
import { renderTemplate } from '../../twig/render.ts';

import type { PmaContext } from '../core/context.ts';

/**
 * Console::getDisplay(). Without pmadb there is no bookmark feature and Relation::getHistory() returns false,
 * so the console starts empty and console.js keeps the session's query history in the browser.
 */
export async function renderConsole(context: PmaContext): Promise<string> {
	if (context.response.isAjax) {
		return '';
	}
	const state = await context.templateState();
	return renderTemplate('console/display', {
		has_bookmark_feature: false,
		image: getImage('console', 'SQL Query Console'),
		sql_history: false,
		bookmark_content: '',
	}, state);
}

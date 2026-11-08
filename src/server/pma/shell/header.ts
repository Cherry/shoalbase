// Header::getDisplay() pieces outside the page shell: the browser-settings import offer, the recent-table hook and the message slot.
import { getGeneratorMessage } from './header-message.ts';
import { httpBuildQuery } from '../../../lib/twig/php.ts';
import { getHiddenInputs } from '../../../lib/twig/url.ts';
import { renderTemplate } from '../../twig/render.ts';
import { addTable, getHtmlUpdateRecentTables } from '../core/recent-favorite-table.ts';

import type { Message } from '../../../lib/pma/message.ts';
import type { RequestParams } from '../../../lib/pma-request.ts';
import type { PmaContext } from '../core/context.ts';

// PHP's empty() for a request value.
function isEmptyParam(value: RequestParams[string] | undefined): boolean {
	if (value === undefined || ['', '0'].includes(value as string)) {
		return true;
	}
	return Array.isArray(value) && value.length === 0;
}

/** $_GET as upstream sees it: Sanitize::removeRequestVars() also clears it when a POST has a bad token. */
function phpGet(context: PmaContext): RequestParams {
	const { request } = context;
	if (request.method === 'POST' && request.tokenMismatch) {
		const kept: RequestParams = {};
		if (typeof request.query.ajax_request === 'string') {
			kept.ajax_request = request.query.ajax_request;
		}
		return kept;
	}
	return request.query;
}

/**
 * Header::getDisplay()'s offer to import settings from localStorage, then UserPreferences::autoloadGetHeader().
 * Without pmadb user preferences live in the session, so every signed-in page offers it until the user answers.
 */
export async function renderLoadUserPreferences(context: PmaContext): Promise<string> {
	if (context.server <= 0 || context.session.data.userprefs_autoload !== undefined) {
		return '';
	}
	if (context.request.params.prefs_autoload === 'hide') {
		context.session.data.userprefs_autoload = true;
		return '';
	}
	return renderTemplate('preferences/autoload', {
		hidden_inputs: getHiddenInputs(context.urlState()),
		return_url: `index.php?${httpBuildQuery(phpGet(context))}`,
	}, await context.templateState());
}

/**
 * Header::addRecentTable(). Without pmadb the recent list lives only in the session, so RecentFavoriteTable::add() always
 * succeeds and the page just carries the link that asks /recent-table for the refreshed list.
 */
export async function renderRecentTable(context: PmaContext): Promise<string> {
	if (context.config.NumRecentTables <= 0 || !isEmptyParam(context.request.params.recent_table)) {
		return '';
	}
	await addTable(context, 'recent', context.db, context.table);
	return getHtmlUpdateRecentTables(context);
}

/**
 * Header::getMessage(): $GLOBALS['message'] from the controller, else the request's message parameter, shown through
 * Generator::getMessage() together with the executed query. Used for the #page_content slot and the AJAX displayMessage.
 */
export async function renderHeaderMessage(context: PmaContext, message?: Message | string): Promise<string> {
	let shown: Message | string = '';
	if (message !== undefined && message !== '' && message !== '0') {
		shown = message;
	} else {
		const requested = context.request.params.message;
		if (typeof requested === 'string' && !isEmptyParam(requested)) {
			shown = requested;
		}
	}
	if (shown === '') {
		return '';
	}
	return getGeneratorMessage(context, shown);
}

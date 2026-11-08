import type { APIRoute } from 'astro';

import { renderJavaScriptMessages } from '~/server/pma/messages';

// JavaScriptMessagesController: loaded by every page, including the login form, so it needs no session.
export const GET: APIRoute = async () => {
	const { body, headers } = renderJavaScriptMessages({}, new Date());
	return new Response(body, { headers });
};

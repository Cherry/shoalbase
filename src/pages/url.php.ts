// url.php: UrlRedirector::redirect(), the interstitial that keeps the token out of the Referer of external links.
import type { APIRoute } from 'astro';

import { createConfig, shellConfig } from '~/lib/pma/config';
import { pageHttpHeaders } from '~/lib/pma/header';
import { isRedirectAllowed } from '~/lib/pma/misc/url-redirector';
import { escapeJsString } from '~/lib/twig/sanitize';
import { renderTemplate } from '~/server/twig/render';

export const GET: APIRoute = async ({ url }) => {
	const headers = new Headers(pageHttpHeaders(shellConfig(createConfig({ host: '' })), new Date()));
	// PHP's $_GET keeps the last of repeated parameters.
	const target = url.searchParams.getAll('url').at(-1);
	if (!isRedirectAllowed(target, url.hostname)) {
		headers.set('Location', '/');
		return new Response(null, { status: 302, headers });
	}
	// A JavaScript redirect, because a Location header can leave the old URL with its token in the Referer.
	const script = await renderTemplate('javascript/redirect', { url: escapeJsString(target) });
	return new Response(`${script}Taking you to the target site.`, { headers });
};

export const ALL: APIRoute = GET;

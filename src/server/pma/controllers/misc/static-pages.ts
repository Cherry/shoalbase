// ChangeLogController, LicenseController and PhpInfoController: plain documents served without the phpMyAdmin shell.
import changelogText from './data/ChangeLog.txt?raw';
import licenseText from './data/LICENSE.txt?raw';
import { shellConfig } from '../../../../lib/pma/config.ts';
import { pageHttpHeaders } from '../../../../lib/pma/header.ts';
import { formatChangelog } from '../../../../lib/pma/misc/changelog.ts';
import { renderTemplate } from '../../../twig/render.ts';

import type { PmaContext } from '../../core/context.ts';

// session_cache_limiter('private') headers PHP sends when the controller sends no caching headers of its own.
const SESSION_CACHE_HEADERS: [string, string][] = [
	['Expires', 'Thu, 19 Nov 1981 08:52:00 GMT'],
	['Cache-Control', 'private, max-age=10800'],
	['Last-Modified', 'Tue, 07 Oct 2025 20:40:11 GMT'],
];

/** Header::sendHttpHeaders() on a disabled response. */
function sendHttpHeaders(context: PmaContext): void {
	for (const [name, value] of pageHttpHeaders(shellConfig(context.config), new Date())) {
		context.response.header(name, value);
	}
}

export async function changeLogController(context: PmaContext): Promise<Response> {
	context.response.disable();
	sendHttpHeaders(context);
	context.response.addHTML(await renderTemplate('changelog', { changelog: formatChangelog(changelogText) }, await context.templateState()));
	return context.response.response();
}

export async function licenseController(context: PmaContext): Promise<Response> {
	context.response.disable();
	for (const [name, value] of SESSION_CACHE_HEADERS) {
		context.response.header(name, value);
	}
	context.response.header('Content-Type', 'text/plain; charset=utf-8');
	context.response.addHTML(licenseText);
	return context.response.response();
}

/** ShowPhpInfo is off in production, so only the headers go out. */
export async function phpInfoController(context: PmaContext): Promise<Response> {
	context.response.disable();
	sendHttpHeaders(context);
	return context.response.response();
}

export const controllers = {
	ChangeLogController: changeLogController,
	LicenseController: licenseController,
	PhpInfoController: phpInfoController,
};

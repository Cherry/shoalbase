// Ports of PhpMyAdmin\Sanitize and Util string helpers exposed as Twig filters and functions.
import { type GeneratorState, getDocumentationLink, getImage } from './html.ts';
import { htmlspecialchars, phpString } from './php.ts';
import { linkUrl } from './url.ts';

const bbCodeTags: Record<string, string> = {
	'[em]': '<em>',
	'[/em]': '</em>',
	'[strong]': '<strong>',
	'[/strong]': '</strong>',
	'[code]': '<code>',
	'[/code]': '</code>',
	'[kbd]': '<kbd>',
	'[/kbd]': '</kbd>',
	'[br]': '<br>',
	'[/a]': '</a>',
	'[/doc]': '</a>',
	'[sup]': '<sup>',
	'[/sup]': '</sup>',
	'[conferr]': '<iframe src="show_config_errors.php"><a href="show_config_errors.php">show_config_errors.php</a></iframe>',
};

const allowedLinkStarts = ['https://', './url.php?url=https%3a%2f%2f', './doc/html/', './index.php?'];

function replaceBBLink(found: string, url: string, target: string | undefined): string {
	const lower = url.toLowerCase();
	if (!allowedLinkStarts.some(start => lower.startsWith(start))) {
		return found;
	}
	if (target && /[^a-z_]/i.test(target)) {
		return found;
	}
	let targetAttribute = '';
	if (target) {
		targetAttribute = ` target="${target}"`;
		if (target === '_blank') {
			targetAttribute += ' rel="noopener noreferrer"';
		}
	}
	const href = url.startsWith('http') ? linkUrl(url) : url;
	return `<a href="${href}"${targetAttribute}>`;
}

function replaceDocLink(state: GeneratorState, first: string, hasPage: boolean, anchorAfterPage: string): string {
	let page: string;
	let anchor: string;
	if (hasPage) {
		page = first;
		anchor = anchorAfterPage;
	} else {
		anchor = first;
		if (anchor.startsWith('faq')) {
			page = 'faq';
		} else if (anchor.startsWith('cfg')) {
			page = 'config';
		} else {
			page = 'setup';
		}
	}
	return `<a href="${getDocumentationLink(state, page, anchor)}" target="documentation">`;
}

/** Sanitize::sanitizeMessage(), the |sanitize filter: BBCode to HTML, escaping < and > first unless $safe. */
export function sanitizeMessage(state: GeneratorState, message: unknown, escape = false, safe = false): string {
	let result = phpString(message);
	if (!safe) {
		result = result.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
	}
	const tags: Record<string, string> = { ...bbCodeTags, '[dochelpicon]': getImage('b_help', state.gettext('Documentation')) };
	result = result.replaceAll(/\[\/?(?:em|strong|code|kbd|sup|a|doc)\]|\[br\]|\[conferr\]|\[dochelpicon\]/g, tag => tags[tag] ?? tag);
	result = result.replaceAll(/\[a@([^\]"@]*)(?:@([^\]"]*))?\]/g, (found, url: string, target: string | undefined) => replaceBBLink(found, url, target));
	result = result.replaceAll(
		/\[doc@([\w-]+)(@([\w-]*))?\]/g,
		(_found, first: string, pageMarker: string | undefined, anchor: string | undefined) => replaceDocLink(state, first, pageMarker !== undefined, anchor ?? ''),
	);
	if (escape) {
		result = htmlspecialchars(result);
	}
	return result;
}

const jsStringEscapes: Record<string, string> = {
	'\0': '',
	'\\': '\\\\',
	'\'': String.raw`\'`,
	'"': String.raw`\"`,
	'\n': String.raw`\n`,
	'\r': String.raw`\r`,
};

/** Sanitize::escapeJsString(), the |escape_js_string filter. */
export function escapeJsString(value: unknown): string {
	return phpString(value)
		.replaceAll(/[\0\\'"\n\r]/g, character => jsStringEscapes[character])
		.replaceAll(/<\/script/gi, '</\' + \'script');
}

/** Util::backquote(): "*" and empty names stay bare. */
export function backquote(value: unknown): string {
	const name = phpString(value);
	if (name === '' || name === '*') {
		return name;
	}
	return `\`${name.replaceAll('`', '``')}\``;
}

/** Sanitize::jsFormat(), the |js_format filter. */
export function jsFormat(value: unknown, addBackquotes = true): string {
	const escaped = escapeJsString(htmlspecialchars(value)).replaceAll('#', String.raw`\#`);
	if (addBackquotes) {
		return backquote(escaped);
	}
	return escaped;
}

function formatJsValue(value: unknown): string {
	if (typeof value === 'boolean') {
		return value ? 'true' : 'false';
	}
	if (Number.isSafeInteger(value)) {
		return String(value);
	}
	return `"${escapeJsString(value)}"`;
}

/** Sanitize::getJsValue(), the get_js_value() function. */
export function getJsValue(key: string, value: unknown, escape = true): string {
	if (!escape) {
		return `${key} = ${phpString(value)}`;
	}
	if (value !== null && typeof value === 'object') {
		const items = Object.values(value).map(item => `${formatJsValue(item)},`).join('');
		return `${key} = [${items}];\n`;
	}
	return `${key} = ${formatJsValue(value)};\n`;
}

/** Util::escapeMysqlWildcards(), the |escape_mysql_wildcards filter. */
export function escapeMysqlWildcards(value: unknown): string {
	return phpString(value).replaceAll(/[%_]/g, String.raw`\$&`);
}

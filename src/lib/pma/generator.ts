// Ports of PhpMyAdmin\Html\Generator helpers that need no database: linkOrButton() and Util::sortableTableHeader().
import { getImage } from '../twig/html.ts';
import { htmlspecialchars } from '../twig/php.ts';
import { escapeJsString } from '../twig/sanitize.ts';
import { getCommon } from '../twig/url.ts';

import type { RequestParams } from '../pma-request.ts';
import type { UrlState } from '../twig/url.ts';

export interface LinkState {
	url: UrlState;
	/** $cfg['LinkLengthLimit']. */
	linkLengthLimit: number;
}

/** Url::getCommon(), which is getCommonRaw() in 5.2.3: the URL goes into href unescaped, like upstream. */
function commonParams(state: UrlState, params: Record<string, unknown>, divider: string): string {
	return getCommon(state, params, divider);
}

/**
 * Generator::linkOrButton(): a link, or a data-post link that ajax.js sends as POST when the URL is too long or carries
 * an unsigned sql_query. A string as `tagParams` becomes a confirmation prompt.
 */
export function linkOrButton(
	state: LinkState,
	urlPath: string,
	urlParams: Record<string, unknown> | null,
	message: string,
	tagParams: Record<string, unknown> | string = {},
	target = '',
	respectUrlLengthLimit = true,
): string {
	const divider = urlPath.includes('?') ? '&' : '?';
	let url = urlPath;
	if (urlParams !== null) {
		url = urlPath + commonParams(state.url, urlParams, divider);
	}
	let params: Record<string, unknown> = {};
	if (typeof tagParams === 'string') {
		if (tagParams !== '' && tagParams !== '0') {
			params = { onclick: `return Functions.confirmLink(this, '${escapeJsString(tagParams)}')` };
		}
	} else {
		params = { ...tagParams };
	}
	if (target !== '' && target !== '0') {
		params.target = target;
		if (target === '_blank' && url.startsWith('url.php?')) {
			params.rel = 'noopener noreferrer';
		}
	}
	const attributes: string[] = [];
	const needsPost = url.length > state.linkLengthLimit
		|| (url.includes('sql_query=') && !url.includes('sql_signature='))
		|| url.includes('view[as]=');
	if (respectUrlLengthLimit && needsPost) {
		const separator = url.indexOf('?');
		const query = separator === -1 ? '' : url.slice(separator + 1);
		attributes.push(`data-post="${query}"`);
		url = separator === -1 ? url : url.slice(0, separator);
		if (typeof params.class === 'string' && params.class.includes('create_view')) {
			url += `?${query.split('&', 1)[0]}`;
		}
	}
	for (const [name, value] of Object.entries(params)) {
		attributes.push(`${name}="${htmlspecialchars(value)}"`);
	}
	return `<a href="${url}" ${attributes.join(' ')}>${message}</a>`;
}

const scalar = (value: RequestParams[string] | undefined): string | undefined => (typeof value === 'string' ? value : undefined);

/** Util::sortableTableHeader(): a column title of the database structure list that sorts by `sort`. */
export function sortableTableHeader(state: LinkState, request: RequestParams, title: string, sort: string, initialSortOrder = 'ASC'): string {
	let requestedSort = 'table';
	let requestedSortOrder = initialSortOrder;
	let futureSortOrder = initialSortOrder;
	if (request.sort !== undefined) {
		requestedSort = scalar(request.sort) ?? '';
		requestedSortOrder = scalar(request.sort_order) ?? requestedSortOrder;
	}
	let orderImg = '';
	let linkParams: Record<string, string> = { title: 'Sort' };
	if (requestedSort === sort) {
		const ascending = requestedSortOrder === 'ASC';
		futureSortOrder = ascending ? 'DESC' : 'ASC';
		orderImg = ` ${getImage('s_asc', 'Ascending', { class: ascending ? 'sort_arrow' : 'sort_arrow hide', title: '' })}`;
		orderImg += ` ${getImage('s_desc', 'Descending', { class: ascending ? 'sort_arrow hide' : 'sort_arrow', title: '' })}`;
		// Hovering shows the order a click would apply.
		linkParams = { ...linkParams, onmouseover: '$(\'.sort_arrow\').toggle();', onmouseout: '$(\'.sort_arrow\').toggle();' };
	}
	const urlParams: Record<string, unknown> = { db: request.db, pos: 0, sort, sort_order: futureSortOrder };
	const tableType = scalar(request.tbl_type);
	if (tableType === 'view' || tableType === 'table') {
		urlParams.tbl_type = tableType;
	}
	const group = request.tbl_group;
	if (group !== undefined && group !== '' && group !== '0') {
		urlParams.tbl_group = group;
	}
	const url = `index.php?route=/database/structure${commonParams(state.url, urlParams, '&')}`;
	return linkOrButton(state, url, null, title + orderImg, linkParams);
}

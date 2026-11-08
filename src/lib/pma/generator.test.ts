import { describe, expect, it } from 'vitest';

import { linkOrButton, sortableTableHeader } from './generator.ts';

const url = { server: 1, serverDefault: 1, lang: 'en', hasLangCookie: true, token: 't' };
const state = { url, linkLengthLimit: 1000 };

describe('linkOrButton', () => {
	it('builds an escaped link from a path and parameters', () => {
		expect(linkOrButton(state, 'index.php?route=/sql', { db: 'd', table: 't' }, 'Browse')).toBe('<a href="index.php?route=/sql&db=d&table=t" >Browse</a>');
		expect(linkOrButton(state, 'index.php', null, 'Home', { class: 'x"y' })).toBe('<a href="index.php" class="x&quot;y">Home</a>');
	});

	it('posts unsigned queries and over-long URLs through data-post', () => {
		expect(linkOrButton(state, 'index.php?route=/sql', { sql_query: 'DROP TABLE t' }, 'Drop', { class: 'ajax' }))
			.toBe('<a href="index.php" data-post="route=/sql&sql_query=DROP+TABLE+t" class="ajax">Drop</a>');
		expect(linkOrButton({ url, linkLengthLimit: 10 }, 'index.php?route=/table/structure', null, 'x')).toBe('<a href="index.php" data-post="route=/table/structure">x</a>');
		expect(linkOrButton({ url, linkLengthLimit: 10 }, 'nowhere-long-path', null, 'x')).toBe('<a href="nowhere-long-path" data-post="">x</a>');
		expect(linkOrButton(state, 'index.php?route=/sql', { sql_query: 'q' }, 'raw', {}, '', false)).toBe('<a href="index.php?route=/sql&sql_query=q" >raw</a>');
	});

	it('keeps the route of create_view links, turns a string into a confirmation and adds targets', () => {
		expect(linkOrButton(state, 'index.php?route=/view/create', { sql_query: 'q' }, 'v', { class: 'create_view ajax' }))
			.toBe('<a href="index.php?route=/view/create" data-post="route=/view/create&sql_query=q" class="create_view ajax">v</a>');
		expect(linkOrButton(state, 'x.php', null, 'go', 'Really?')).toBe('<a href="x.php" onclick="return Functions.confirmLink(this, &#039;Really?&#039;)">go</a>');
		expect(linkOrButton(state, 'x.php', null, 'go', '')).toBe('<a href="x.php" >go</a>');
		expect(linkOrButton(state, 'url.php?url=x', null, 'doc', {}, '_blank')).toBe('<a href="url.php?url=x" target="_blank" rel="noopener noreferrer">doc</a>');
		expect(linkOrButton(state, 'x.php', null, 'doc', {}, 'main')).toBe('<a href="x.php" target="main">doc</a>');
	});
});

describe('sortableTableHeader', () => {
	it('links to the database structure sorted by the column, flipping the current order', () => {
		const unsorted = sortableTableHeader(state, { db: 'd' }, 'Rows', 'records');
		expect(unsorted).toBe('<a href="index.php?route=/database/structure&db=d&pos=0&sort=records&sort_order=ASC" title="Sort">Rows</a>');

		const ascending = sortableTableHeader(state, { db: 'd', sort: 'records', sort_order: 'ASC', tbl_type: 'view', tbl_group: 'g' }, 'Rows', 'records');
		expect(ascending).toContain('sort_order=DESC&tbl_type=view&tbl_group=g"');
		expect(ascending).toContain('Rows <img src="themes/dot.gif" title="" alt="Ascending" class="icon ic_s_asc sort_arrow"> <img src="themes/dot.gif" title="" alt="Descending" class="icon ic_s_desc sort_arrow hide">');
		expect(ascending).toContain('onmouseover="$(&#039;.sort_arrow&#039;).toggle();"');

		const descending = sortableTableHeader(state, { db: 'd', sort: 'records', sort_order: 'DESC', tbl_type: 'other' }, 'Rows', 'records', 'DESC');
		expect(descending).toContain('sort_order=ASC"');
		expect(descending).toContain('class="icon ic_s_asc sort_arrow hide"');
		expect(sortableTableHeader(state, { db: 'd', sort: 'records' }, 'Rows', 'records', 'DESC')).toContain('sort_order=ASC"');
		expect(sortableTableHeader(state, { db: 'd', sort: ['records'] }, 'Rows', 'records')).not.toContain('sort_arrow');
	});
});

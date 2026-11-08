import { describe, expect, it } from 'vitest';

import {
	applyTransformation,
	formatSql,
	specialLinkPlugin,
	specialLinkUrl,
	specialSchemaLink,
	transformationFor,
} from './transformations.ts';

const common = (params: Record<string, unknown>, divider: string): string => divider + new URLSearchParams(params as Record<string, string>).toString();

const found = <T>(value: T | null): T => {
	if (value === null) {
		throw new Error('expected a match');
	}
	return value;
};

describe('transformationFor', () => {
	it('finds the default plugins of system schema columns case-insensitively', () => {
		expect(transformationFor('INFORMATION_SCHEMA', 'VIEWS', 'VIEW_DEFINITION')).toMatchObject({ kind: 'sql', mediaType: 'Text/Plain' });
		expect(transformationFor('mysql', 'proc', 'body')).toMatchObject({ kind: 'sql', mediaType: 'Text/Octetstream' });
		expect(transformationFor('mysql', 'help_topic', 'url')).toMatchObject({ kind: 'link' });
		expect(transformationFor('customer_db', 'views', 'view_definition')).toBeNull();
		expect(transformationFor('mysql', 'proc', 'nope')).toBeNull();
	});
});

describe('applyTransformation', () => {
	it('formats SQL as an escaped code block', () => {
		const sql = found(transformationFor('information_schema', 'views', 'view_definition'));
		expect(formatSql('a < "b" & c')).toBe('<code class="sql" dir="ltr"><pre>\na &lt; &quot;b&quot; &amp; c\n</pre></code>');
		expect(applyTransformation(sql, 'SELECT 1')).toBe('<code class="sql" dir="ltr"><pre>\nSELECT 1\n</pre></code>');
	});

	it('links only allowed URLs and escapes the rest', () => {
		const link = found(transformationFor('mysql', 'help_topic', 'url'));
		expect(applyTransformation(link, 'https://x.test/?a=1&b=2'))
			.toBe('<a href="https://x.test/?a=1&amp;b=2" title="" target="_blank" rel="noopener noreferrer">https://x.test/?a=1&amp;b=2</a>');
		expect(applyTransformation(link, 'javascript:alert(1)<')).toBe('javascript:alert(1)&lt;');
	});

	it('links a special schema column to its prepared URL with the value as text', () => {
		expect(applyTransformation(specialLinkPlugin('./index.php?route=/table&db=d'), 'd'))
			.toBe('<a href="./index.php?route=/table&amp;db=d" title="" target="_blank" rel="noopener noreferrer">d</a>');
		expect(applyTransformation({ ...specialLinkPlugin(''), url: undefined }, 'x')).toBe('');
	});
});

describe('specialLinkUrl', () => {
	const pages = { database: './index.php?route=/database/structure', table: './index.php?route=/sql' };

	it('resolves the default tab placeholders and adds dependent column values', () => {
		const link = found(specialSchemaLink('INFORMATION_SCHEMA', 'Tables', 'TABLE_NAME'));
		expect(specialLinkUrl(link, 'players', { table_schema: 'customer_db' }, pages, common))
			.toBe('./index.php?route=/sql&table=players&db=customer_db');
		expect(specialLinkUrl(link, 'players', { table_schema: null }, pages, common)).toBe('./index.php?route=/sql&table=players');
		expect(specialLinkUrl({ link_param: 'db', default_page: '@database@' }, 'd', {}, pages, common)).toBe('./index.php?route=/database/structure&db=d');
	});

	it('uses "?" for pages without a query string', () => {
		expect(specialLinkUrl({ link_param: 'x', default_page: 'page.php' }, 'v', {}, pages, common)).toBe('page.php?x=v');
		expect(specialSchemaLink('customer_db', 'tables', 'table_name')).toBeNull();
	});
});

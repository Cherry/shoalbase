import { describe, expect, it } from 'vitest';

import {
	type GeneratorState,
	getDocumentationLink,
	getIcon,
	getImage,
	getMySQLDocuUrl,
	renderMessage,
	showDocumentationLink,
	showHint,
	showIcons,
	showMySQLDocumentation,
	showPhpDocumentation,
	showText,
	themeImagePath,
} from './html';

const state: GeneratorState = {
	config: { ActionLinksMode: 'both', TabsMode: 'icons', NavigationTreeMode: 'text', ShowHint: true },
	hasLocalDocs: true,
	mysqlVersion: 80400,
	gettext: message => message,
};
const helpIcon = '<img src="themes/dot.gif" title="Documentation" alt="Documentation" class="icon ic_b_help">';

describe('icons and images', () => {
	it('matches the sprite images on the live home page', () => {
		expect(getImage('s_host')).toBe('<img src="themes/dot.gif" title="" alt="" class="icon ic_s_host">');
		expect(getImage('s_attention', 'Warning')).toBe('<img src="themes/dot.gif" title="Warning" alt="Warning" class="icon ic_s_attention">');
	});

	it('escapes the alternate text and honours attribute overrides', () => {
		expect(getImage('b_edit', 'Edit "x"', { class: 'big', title: 'T', alt: 'A', id: 'i' }))
			.toBe('<img src="themes/dot.gif" title="T" alt="A" class="icon ic_b_edit big" id="i">');
	});

	it('matches get_icon output from the live home page', () => {
		expect(getIcon(state, 'b_tblops', 'More settings', true))
			.toBe('<span class="text-nowrap"><img src="themes/dot.gif" title="More settings" alt="More settings" class="icon ic_b_tblops">&nbsp;More settings</span>');
	});

	it('follows the icon/text display modes', () => {
		expect(getIcon(state, 'b_x', 'X', false, false, 'TabsMode')).toBe('<span class="text-nowrap"><img src="themes/dot.gif" title="X" alt="X" class="icon ic_b_x"></span>');
		expect(getIcon(state, 'b_x', 'X', false, true, 'NavigationTreeMode')).toBe('X');
		expect(getIcon(state, 'b_x', 'X', false, true, 'Missing')).toBe('');
		expect(showIcons(state, 'ActionLinksMode')).toBe(true);
		expect(showText(state, 'TabsMode')).toBe(false);
	});
});

describe('documentation links', () => {
	it('matches show_docu() output on the live login and home pages', () => {
		expect(showDocumentationLink(state, getDocumentationLink(state, 'index'))).toBe(`<a href="./doc/html/index.html" target="documentation">${helpIcon}</a>`);
		expect(getDocumentationLink(state, 'faq', 'faq7-2')).toBe('./doc/html/faq.html#faq7-2');
	});

	it('links to docs.phpmyadmin.net without local docs and supports BBCode output', () => {
		const remote = { ...state, hasLocalDocs: false };
		expect(getDocumentationLink(remote, 'setup', '', '../')).toBe('./url.php?url=https%3A%2F%2Fdocs.phpmyadmin.net%2Fen%2Flatest%2Fsetup.html');
		expect(showDocumentationLink(state, 'x', 'documentation', true)).toBe('[a@x@documentation][dochelpicon][/a]');
	});

	it('matches show_mysql_docu() output on the live home page', () => {
		expect(showMySQLDocumentation(state, 'charset-connection'))
			.toBe(`<a href="./url.php?url=https%3A%2F%2Fdev.mysql.com%2Fdoc%2Frefman%2F8.0%2Fen%2Fcharset-connection.html" target="mysql_doc">${helpIcon}</a>`);
	});

	it('supports the big icon and text variants of show_mysql_docu()', () => {
		expect(showMySQLDocumentation(state, '', true, 'a&b')).toBe('<a href="a&amp;b" target="mysql_doc"><img src="themes/dot.gif" title="Documentation" alt="Documentation" class="icon ic_b_sqlhelp"></a>');
		expect(showMySQLDocumentation(state, '', false, 'u', '<i>Text</i>')).toBe('<a href="u" target="mysql_doc"><i>Text</i></a>');
	});

	it('picks the MySQL manual version from the server version', () => {
		const url = (mysqlVersion: number): string => getMySQLDocuUrl({ ...state, mysqlVersion }, 'SHOW_TABLES', 'x');
		expect(url(80400)).toContain('refman%2F8.0%2Fen%2Fshow-tables.html%23x');
		expect(url(50744)).toContain('refman%2F5.7%2F');
		expect(url(50600)).toContain('refman%2F5.6%2F');
		expect(url(50100)).toContain('refman%2F5.5%2F');
		expect(getMySQLDocuUrl(state, '')).toContain('%2Findex.html');
	});

	it('links PHP docs in the translated manual when one exists', () => {
		expect(showPhpDocumentation(state, 'book.mysqli.php', 'en')).toBe(`<a href="./url.php?url=https%3A%2F%2Fwww.php.net%2Fmanual%2Fen%2Fbook.mysqli.php" target="documentation">${helpIcon}</a>`);
		expect(showPhpDocumentation(state, 'x', 'de')).toContain('manual%2Fde%2Fx');
		expect(showPhpDocumentation(state, 'x', 'zh_CN')).toContain('manual%2Fzh%2Fx');
	});
});

describe('hints and messages', () => {
	it('renders hints with the message as HTML', () => {
		expect(showHint(state, 'Use <b>%</b>')).toBe('<span class="pma_hint"><img src="themes/dot.gif" title="" alt="" class="icon ic_b_help"><span class="hide">Use <b>%</b></span></span>');
		expect(showHint({ ...state, config: {} }, 'x')).toBe('<span><img src="themes/dot.gif" title="" alt="" class="icon ic_b_help"><span class="hide">x</span></span>');
	});

	it('matches the |error message box on the live login page', () => {
		expect(renderMessage('error', 'Javascript must be enabled past this point!'))
			.toBe('<div class="alert alert-danger" role="alert">\n  <img src="themes/dot.gif" title="" alt="" class="icon ic_s_error"> Javascript must be enabled past this point!\n</div>\n');
	});

	it('uses the notice and success styles', () => {
		expect(renderMessage('notice', 'n')).toContain('alert-primary" role="alert">\n  <img src="themes/dot.gif" title="" alt="" class="icon ic_s_notice"> n');
		expect(renderMessage('success', 's')).toContain('alert-success" role="alert">\n  <img src="themes/dot.gif" title="" alt="" class="icon ic_s_success"> s');
	});
});

describe('themeImagePath', () => {
	const images = new Set(['logo_right.png']);

	it('resolves theme images with fallbacks like Theme::getImgPath()', () => {
		expect(themeImagePath(images, './themes/pmahomme/img/', 'logo_right.png', 'pma_logo.png')).toBe('./themes/pmahomme/img/logo_right.png');
		expect(themeImagePath(images, './themes/metro/img/', 'missing.png', 'logo_right.png')).toBe('./themes/metro/img/logo_right.png');
		expect(themeImagePath(images, './themes/metro/img/', 'missing.png')).toBe('./themes/pmahomme/img/missing.png');
		expect(themeImagePath(images, './themes/metro/img/', 'missing.png', 'other.png')).toBe('./themes/pmahomme/img/other.png');
		expect(themeImagePath(images, './themes/metro/img/')).toBe('./themes/metro/img/');
	});
});

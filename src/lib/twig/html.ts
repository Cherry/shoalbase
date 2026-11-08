// Ports of the Html\Generator, MySQLDocumentation, Theme and Message display helpers that Twig functions call.
import { htmlspecialchars, phpString } from './php.ts';
import { linkUrl } from './url.ts';

export interface GeneratorState {
	/** The $cfg keys the helpers read, e.g. ActionLinksMode, TabsMode and ShowHint. */
	config: Record<string, unknown>;
	/** Whether doc/html/ is served locally, as in the official Docker image. */
	hasLocalDocs: boolean;
	/** DatabaseInterface::getVersion(), e.g. 80400; 0 when not connected. */
	mysqlVersion: number;
	gettext(message: string): string;
}

/** Util::showIcons(). */
export function showIcons(state: GeneratorState, key: string): boolean {
	return state.config[key] === 'icons' || state.config[key] === 'both';
}

/** Util::showText(). */
export function showText(state: GeneratorState, key: string): boolean {
	return state.config[key] === 'text' || state.config[key] === 'both';
}

/** Generator::getImage(): icons are CSS sprites on themes/dot.gif. */
export function getImage(image: string, alternate: unknown = '', attributes: Record<string, unknown> = {}): string {
	const alt = htmlspecialchars(alternate);
	const attrs = { ...attributes };
	if (attrs.class === undefined) {
		attrs.class = `icon ic_${image}`;
	} else {
		attrs.class = `icon ic_${image} ${phpString(attrs.class)}`;
	}
	let attributeString = '';
	for (const [key, value] of Object.entries(attrs)) {
		if (key !== 'alt' && key !== 'title') {
			attributeString += ` ${key}="${phpString(value)}"`;
		}
	}
	const title = attrs.title === undefined ? alt : phpString(attrs.title);
	const altText = attrs.alt === undefined ? alt : phpString(attrs.alt);
	return `<img src="themes/dot.gif" title="${title}" alt="${altText}"${attributeString}>`;
}

/** Generator::getIcon(). */
export function getIcon(
	state: GeneratorState,
	icon: string,
	alternate: unknown = '',
	forceText = false,
	menuIcon = false,
	controlParam = 'ActionLinksMode',
): string {
	const includeIcon = showIcons(state, controlParam);
	const includeText = forceText || showText(state, controlParam);
	let button = menuIcon ? '' : '<span class="text-nowrap">';
	if (includeIcon) {
		button += getImage(icon, alternate);
	}
	if (includeIcon && includeText) {
		button += '&nbsp;';
	}
	if (includeText) {
		button += phpString(alternate);
	}
	return button + (menuIcon ? '' : '</span>');
}

/** Generator::showDocumentationLink(). */
export function showDocumentationLink(state: GeneratorState, link: string, target = 'documentation', bbcode = false): string {
	if (bbcode) {
		return `[a@${link}@${target}][dochelpicon][/a]`;
	}
	return `<a href="${link}" target="${target}">${getImage('b_help', state.gettext('Documentation'))}</a>`;
}

/** MySQLDocumentation::getDocumentationLink(). */
export function getDocumentationLink(state: GeneratorState, page: string, anchor = '', pathPrefix = './'): string {
	let url = `${page}.html`;
	if (anchor) {
		url += `#${anchor}`;
	}
	if (state.hasLocalDocs) {
		return `${pathPrefix}doc/html/${url}`;
	}
	return linkUrl(`https://docs.phpmyadmin.net/en/latest/${url}`);
}

/** Util::getMySQLDocuURL(). */
export function getMySQLDocuUrl(state: GeneratorState, link: string, anchor = ''): string {
	const page = link.toLowerCase().replaceAll('_', '-') || 'index';
	let mysql = '5.5';
	if (state.mysqlVersion >= 80000) {
		mysql = '8.0';
	} else if (state.mysqlVersion >= 50700) {
		mysql = '5.7';
	} else if (state.mysqlVersion >= 50600) {
		mysql = '5.6';
	}
	let url = `https://dev.mysql.com/doc/refman/${mysql}/en/${page}.html`;
	if (anchor) {
		url += `#${anchor}`;
	}
	return linkUrl(url);
}

/** MySQLDocumentation::show(), the Twig show_mysql_docu() function. */
export function showMySQLDocumentation(
	state: GeneratorState,
	link: string,
	bigIcon = false,
	url: string | null = null,
	text: string | null = null,
	anchor = '',
): string {
	const href = url ?? getMySQLDocuUrl(state, link, anchor);
	const openLink = `<a href="${htmlspecialchars(href)}" target="mysql_doc">`;
	if (bigIcon) {
		return `${openLink}${getImage('b_sqlhelp', state.gettext('Documentation'))}</a>`;
	}
	if (text !== null) {
		return `${openLink}${text}</a>`;
	}
	return showDocumentationLink(state, href, 'mysql_doc');
}

/** Generator::showPHPDocumentation() via Core::getPHPDocLink(). */
export function showPhpDocumentation(state: GeneratorState, target: string, lang: string): string {
	const translated = ['pt_BR', 'zh_CN', 'fr', 'de', 'ja', 'ru', 'es', 'tr'];
	let docLang = 'en';
	if (lang === 'zh_CN') {
		docLang = 'zh';
	} else if (translated.includes(lang)) {
		docLang = lang;
	}
	return showDocumentationLink(state, linkUrl(`https://www.php.net/manual/${docLang}/${target}`));
}

/** Generator::showHint(): the message is inserted as HTML. */
export function showHint(state: GeneratorState, message: unknown): string {
	const classClause = state.config.ShowHint ? ' class="pma_hint"' : '';
	return `<span${classClause}>${getImage('b_help')}<span class="hide">${phpString(message)}</span></span>`;
}

export type MessageLevel = 'error' | 'notice' | 'success';

/** Message::getDisplay() for a message whose text is already final HTML, rendered like templates/message.twig. */
export function renderMessage(level: MessageLevel, html: string): string {
	let context = 'primary';
	let icon = 's_notice';
	if (level === 'error') {
		context = 'danger';
		icon = 's_error';
	} else if (level === 'success') {
		context = 'success';
		icon = 's_success';
	}
	return `<div class="alert alert-${context}" role="alert">\n  ${getImage(icon)} ${html}\n</div>\n`;
}

/** Theme::getImgPath(): falls back to pmahomme when the active theme lacks the file. */
export function themeImagePath(themeImages: ReadonlySet<string>, imgPath: string, file: string | null = null, fallback: string | null = null): string {
	if (file === null) {
		return imgPath;
	}
	if (themeImages.has(file)) {
		return imgPath + file;
	}
	if (fallback !== null && themeImages.has(fallback)) {
		return imgPath + fallback;
	}
	return `./themes/pmahomme/img/${fallback ?? file}`;
}

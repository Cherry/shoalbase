// Request-scoped values that phpMyAdmin's Twig helpers read from $GLOBALS, $cfg and the session.
import { type TranslationCatalog, englishCatalog } from '../../lib/twig/i18n.ts';

import type { RequestParams } from '../../lib/pma-request.ts';
import type { GeneratorState } from '../../lib/twig/html.ts';
import type { UrlState } from '../../lib/twig/url.ts';

export interface TemplateState {
	url: UrlState;
	/** The $cfg keys helpers read (ActionLinksMode, TabsMode, ShowHint, ...). */
	config: Record<string, unknown>;
	hasLocalDocs: boolean;
	mysqlVersion: number;
	catalog: TranslationCatalog;
	themeImgPath: string;
	/** Files under the active theme's img/ directory, for Theme::getImgPath()'s is_readable() check. */
	themeImages: ReadonlySet<string>;
	/** $_REQUEST, for helpers such as Util::sortableTableHeader() that read it. */
	request?: RequestParams;
	/** FlashMessages::getMessages() of the controller's FlashMessages, for the flash() function. */
	flashMessages?: Record<string, string[]>;
	/** Request-bound implementations of database-backed Twig functions that are otherwise unported, such as get_foreign_data. */
	functionOverrides?: Record<string, (...args: unknown[]) => unknown>;
	/** Util::getServerType(), for the column type helpers. */
	serverType?: 'MySQL' | 'MariaDB' | 'Percona Server';
}

export interface TemplateStateInput extends Partial<Omit<TemplateState, 'url'>> {
	url?: Partial<UrlState>;
}

export function createTemplateState(input: TemplateStateInput = {}): TemplateState {
	return {
		hasLocalDocs: true,
		mysqlVersion: 0,
		catalog: englishCatalog,
		themeImgPath: './themes/pmahomme/img/',
		themeImages: new Set(),
		...input,
		config: {
			ActionLinksMode: 'both',
			TabsMode: 'both',
			ShowHint: true,
			...input.config,
		},
		url: {
			server: 1,
			serverDefault: 1,
			lang: 'en',
			hasLangCookie: true,
			token: '',
			...input.url,
		},
	};
}

export function toGeneratorState(state: TemplateState): GeneratorState {
	return {
		config: state.config,
		hasLocalDocs: state.hasLocalDocs,
		mysqlVersion: state.mysqlVersion,
		gettext: message => state.catalog.gettext(message, null),
	};
}

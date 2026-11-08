// Port of PhpMyAdmin\SqlParser\Translator: gettext over the sqlparser.mo catalogs, which phpMyAdmin loads in the UI language.
import { MESSAGES, TRANSLATIONS } from './locale/translations.ts';

const messageIndex = new Map(MESSAGES.map((message, index) => [message, index]));

/** Loader::listLocales(): the catalog names tried for a locale, most specific first. */
export function listLocales(locale: string): string[] {
	const names: string[] = [];
	if (locale === '') {
		return names;
	}
	const match = /^(?<lang>[a-z]{2,3})(?:_(?<country>[A-Z]{2}))?(?:\.(?<charset>[-\w]+))?(?:@(?<modifier>[-\w]+))?$/.exec(locale);
	if (match?.groups) {
		const { lang, country, charset, modifier } = match.groups;
		if (modifier) {
			if (country) {
				if (charset) {
					names.push(`${lang}_${country}.${charset}@${modifier}`);
				}
				names.push(`${lang}_${country}@${modifier}`);
			} else if (charset) {
				names.push(`${lang}.${charset}@${modifier}`);
			}
			names.push(`${lang}@${modifier}`);
		}
		if (country) {
			if (charset) {
				names.push(`${lang}_${country}.${charset}`);
			}
			names.push(`${lang}_${country}`);
		} else if (charset) {
			names.push(`${lang}.${charset}`);
		}
		names.push(lang);
	}
	// Locales that are not POSIX style are tried as they are.
	if (!names.includes(locale)) {
		names.push(locale);
	}
	return names;
}

export class Translator {
	private static locale = '';
	private static catalog: string[] | null | undefined;

	/** Picks the catalog for the current locale; phpMyAdmin sets the locale from $GLOBALS['lang'] (default "en"). */
	static load(): void {
		if (this.catalog !== undefined) {
			return;
		}
		if (this.locale === '') {
			this.locale = 'en';
		}
		this.catalog = null;
		for (const name of listLocales(this.locale)) {
			if (Object.hasOwn(TRANSLATIONS, name)) {
				this.catalog = TRANSLATIONS[name];
				break;
			}
		}
	}

	static gettext(msgid: string): string {
		this.load();
		const index = messageIndex.get(msgid);
		if (this.catalog === null || this.catalog === undefined || index === undefined) {
			return msgid;
		}
		const translated = this.catalog[index];
		return translated === '' ? msgid : translated;
	}

	/** Unlike upstream, a new locale takes effect immediately because a Worker isolate serves many requests. */
	static setLocale(locale: string): void {
		this.locale = locale;
		this.catalog = undefined;
	}

	static getLocale(): string {
		return this.locale;
	}
}

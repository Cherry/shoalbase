// LanguageManager::$languageData entries for the locales vendored under vendor/phpmyadmin-5.2.3/locale, plus English.
// Native names are kept as upstream stores them, including HTML entities, because templates print them with |raw.

export interface Language {
	/** Upstream casing, e.g. "zh_CN"; templates lowercase it for option values. */
	code: string;
	/** English name, which LanguageManager::sortedLanguages() sorts by. */
	name: string;
	native: string;
}

export const availableLanguages: readonly Language[] = [
	{ code: 'ar', name: 'Arabic', native: '&#1575;&#1604;&#1593;&#1585;&#1576;&#1610;&#1577;' },
	{ code: 'az', name: 'Azerbaijani', native: 'Az&#601;rbaycanca' },
	{ code: 'be', name: 'Belarusian', native: '&#1041;&#1077;&#1083;&#1072;&#1088;&#1091;&#1089;&#1082;&#1072;&#1103;' },
	{ code: 'bg', name: 'Bulgarian', native: '&#1041;&#1098;&#1083;&#1075;&#1072;&#1088;&#1089;&#1082;&#1080;' },
	{ code: 'bn', name: 'Bangla', native: 'বাংলা' },
	{ code: 'ca', name: 'Catalan', native: 'Catal&agrave;' },
	{ code: 'cs', name: 'Czech', native: 'Čeština' },
	{ code: 'da', name: 'Danish', native: 'Dansk' },
	{ code: 'de', name: 'German', native: 'Deutsch' },
	{ code: 'el', name: 'Greek', native: '&Epsilon;&lambda;&lambda;&eta;&nu;&iota;&kappa;&#940;' },
	{ code: 'en', name: 'English', native: '' },
	{ code: 'en_GB', name: 'English (United Kingdom)', native: '' },
	{ code: 'es', name: 'Spanish', native: 'Espa&ntilde;ol' },
	{ code: 'et', name: 'Estonian', native: 'Eesti' },
	{ code: 'fi', name: 'Finnish', native: 'Suomi' },
	{ code: 'fr', name: 'French', native: 'Fran&ccedil;ais' },
	{ code: 'gl', name: 'Galician', native: 'Galego' },
	{ code: 'he', name: 'Hebrew', native: '&#1506;&#1489;&#1512;&#1497;&#1514;' },
	{ code: 'hu', name: 'Hungarian', native: 'Magyar' },
	{ code: 'hy', name: 'Armenian', native: 'Հայերէն' },
	{ code: 'ia', name: 'Interlingua', native: '' },
	{ code: 'id', name: 'Indonesian', native: 'Bahasa Indonesia' },
	{ code: 'it', name: 'Italian', native: 'Italiano' },
	{ code: 'ja', name: 'Japanese', native: '&#26085;&#26412;&#35486;' },
	{ code: 'ka', name: 'Georgian', native: '&#4325;&#4304;&#4320;&#4311;&#4323;&#4314;&#4312;' },
	{ code: 'kk', name: 'Kazakh', native: 'Қазақ' },
	{ code: 'ko', name: 'Korean', native: '&#54620;&#44397;&#50612;' },
	{ code: 'nb', name: 'Norwegian', native: 'Norsk' },
	{ code: 'nl', name: 'Dutch', native: 'Nederlands' },
	{ code: 'pl', name: 'Polish', native: 'Polski' },
	{ code: 'pt', name: 'Portuguese', native: 'Portugu&ecirc;s' },
	{ code: 'pt_BR', name: 'Portuguese (Brazil)', native: 'Portugu&ecirc;s (Brasil)' },
	{ code: 'ro', name: 'Romanian', native: 'Rom&acirc;n&#259;' },
	{ code: 'ru', name: 'Russian', native: '&#1056;&#1091;&#1089;&#1089;&#1082;&#1080;&#1081;' },
	{ code: 'si', name: 'Sinhala', native: '&#3523;&#3538;&#3458;&#3524;&#3517;' },
	{ code: 'sk', name: 'Slovak', native: 'Sloven&#269;ina' },
	{ code: 'sl', name: 'Slovenian', native: 'Sloven&scaron;&#269;ina' },
	{ code: 'sq', name: 'Albanian', native: 'Shqip' },
	{ code: 'sv', name: 'Swedish', native: 'Svenska' },
	{ code: 'ta', name: 'Tamil', native: 'தமிழ்' },
	{ code: 'tr', name: 'Turkish', native: 'T&uuml;rk&ccedil;e' },
	{ code: 'ug', name: 'Uyghur', native: 'ئۇيغۇرچە' },
	{ code: 'uk', name: 'Ukrainian', native: '&#1059;&#1082;&#1088;&#1072;&#1111;&#1085;&#1089;&#1100;&#1082;&#1072;' },
	{ code: 'vi', name: 'Vietnamese', native: 'Tiếng Việt' },
	{ code: 'zh_CN', name: 'Chinese simplified', native: '&#20013;&#25991;' },
	{ code: 'zh_TW', name: 'Chinese traditional', native: '&#20013;&#25991;' },
];

/** Language::getName(). */
export function languageDisplayName(language: Language): string {
	if (language.native) {
		return `${language.native} - ${language.name}`;
	}
	return language.name;
}

// strcmp() order rather than localeCompare(); English names are unique, so they never compare equal.
function compareNames(left: Language, right: Language): number {
	if (left.name < right.name) {
		return -1;
	}
	return 1;
}

/** LanguageManager::sortedLanguages(): sorted by English name. */
export function sortedLanguages(): Language[] {
	return availableLanguages.toSorted((left, right) => compareNames(left, right));
}

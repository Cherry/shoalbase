// Port of PhpMyAdmin\Charsets and Charsets\Collation: the server's character sets and collations with their descriptions.
import { strcmp } from './php-compare.ts';

export interface CollationEntry {
	name: string;
	description: string;
	is_selected: boolean;
}

export interface CharsetEntry {
	name: string;
	description: string;
	collations: CollationEntry[];
}

/** Charsets::loadCharsets() with DisableIS off, as in production. */
export const CHARSETS_QUERY = 'SELECT `CHARACTER_SET_NAME` AS `Charset`,'
	+ ' `DEFAULT_COLLATE_NAME` AS `Default collation`,'
	+ ' `DESCRIPTION` AS `Description`,'
	+ ' `MAXLEN` AS `Maxlen`'
	+ ' FROM `information_schema`.`CHARACTER_SETS`';

/** Charsets::loadCollations(); MariaDB 10.10+ lists collations per character set in a separate table. */
export function collationsQuery(isMariaDb: boolean, version: number): string {
	if (isMariaDb && version >= 101000) {
		return 'SELECT `collapp`.`FULL_COLLATION_NAME` AS `Collation`,'
			+ ' `collapp`.`CHARACTER_SET_NAME` AS `Charset`,'
			+ ' `collapp`.`ID` AS `Id`,'
			+ ' `collapp`.`IS_DEFAULT` AS `Default`,'
			+ ' `coll`.`IS_COMPILED` AS `Compiled`,'
			+ ' `coll`.`SORTLEN` AS `Sortlen`'
			+ ' FROM `information_schema`.`COLLATION_CHARACTER_SET_APPLICABILITY` `collapp`'
			+ ' LEFT JOIN `information_schema`.`COLLATIONS` `coll`'
			+ ' ON `collapp`.`COLLATION_NAME`=`coll`.`COLLATION_NAME`';
	}
	return 'SELECT `COLLATION_NAME` AS `Collation`,'
		+ ' `CHARACTER_SET_NAME` AS `Charset`,'
		+ ' `ID` AS `Id`,'
		+ ' `IS_DEFAULT` AS `Default`,'
		+ ' `IS_COMPILED` AS `Compiled`,'
		+ ' `SORTLEN` AS `Sortlen`'
		+ ' FROM `information_schema`.`COLLATIONS`';
}

const UNICODE_CHARSETS = new Set(['ucs2', 'utf8', 'utf8mb3', 'utf16', 'utf16le', 'utf16be', 'utf32']);

const CHARSET_NAMES: Record<string, string> = {
	binary: 'Binary',
	ascii: 'West European',
	cp850: 'West European',
	dec8: 'West European',
	hp8: 'West European',
	latin1: 'West European',
	macroman: 'West European',
	cp1250: 'Central European',
	cp852: 'Central European',
	latin2: 'Central European',
	macce: 'Central European',
	cp866: 'Russian',
	koi8r: 'Russian',
	gb2312: 'Simplified Chinese',
	gbk: 'Simplified Chinese',
	big5: 'Traditional Chinese',
	sjis: 'Japanese',
	ujis: 'Japanese',
	cp932: 'Japanese',
	eucjpms: 'Japanese',
	cp1257: 'Baltic',
	latin7: 'Baltic',
	armscii8: 'Armenian',
	armscii: 'Armenian',
	cp1251: 'Cyrillic',
	cp1256: 'Arabic',
	euckr: 'Korean',
	hebrew: 'Hebrew',
	geostd8: 'Georgian',
	greek: 'Greek',
	keybcs2: 'Czech-Slovak',
	koi8u: 'Ukrainian',
	latin5: 'Turkish',
	swe7: 'Swedish',
	tis620: 'Thai',
};

// Collation::getNameForLevel1() tokens that name the language outright.
const LANGUAGE_NAMES: Record<string, string> = {
	bulgarian: 'Bulgarian',
	bg: 'Bulgarian',
	croatian: 'Croatian',
	hr: 'Croatian',
	czech: 'Czech',
	cs: 'Czech',
	danish: 'Danish',
	da: 'Danish',
	english: 'English',
	en: 'English',
	esperanto: 'Esperanto',
	eo: 'Esperanto',
	estonian: 'Estonian',
	et: 'Estonian',
	german1: 'German (dictionary order)',
	german2: 'German (phone book order)',
	hungarian: 'Hungarian',
	hu: 'Hungarian',
	icelandic: 'Icelandic',
	is: 'Icelandic',
	japanese: 'Japanese',
	ja: 'Japanese',
	la: 'Classical Latin',
	latvian: 'Latvian',
	lv: 'Latvian',
	lithuanian: 'Lithuanian',
	lt: 'Lithuanian',
	korean: 'Korean',
	ko: 'Korean',
	myanmar: 'Burmese',
	my: 'Burmese',
	persian: 'Persian',
	polish: 'Polish',
	pl: 'Polish',
	roman: 'West European',
	romanian: 'Romanian',
	ro: 'Romanian',
	ru: 'Russian',
	si: 'Sinhalese',
	sinhala: 'Sinhalese',
	slovak: 'Slovak',
	sk: 'Slovak',
	slovenian: 'Slovenian',
	sl: 'Slovenian',
	spanish: 'Spanish (modern)',
	spanish2: 'Spanish (traditional)',
	swedish: 'Swedish',
	sv: 'Swedish',
	thai: 'Thai',
	th: 'Thai',
	turkish: 'Turkish',
	tr: 'Turkish',
	ukrainian: 'Ukrainian',
	uk: 'Ukrainian',
	vietnamese: 'Vietnamese',
	vi: 'Vietnamese',
};

const VARIANTS: Record<string, string> = {
	'0900': 'UCA 9.0.0',
	'520': 'UCA 5.2.0',
	'mysql561': 'MySQL 5.6.1',
	'mysql500': 'MySQL 5.0.0',
};

const SUFFIXES: Record<string, string> = {
	ci: 'case-insensitive',
	cs: 'case-sensitive',
	ai: 'accent-insensitive',
	as: 'accent-sensitive',
	ks: 'kana-sensitive',
	w2: 'multi-level',
	l2: 'multi-level',
	bin: 'binary',
	nopad: 'no-pad',
};

/** Collation::buildDescription(): parses the collation name token by token (charset, language, variant, suffixes). */
export function collationDescription(collation: string): string {
	let name = 'Unknown';
	let variant: string | null = null;
	const suffixes: string[] = [];
	let unicode = false;
	let unknown = false;
	let level = 0;
	for (const part of collation.split('_')) {
		if (level === 0) {
			level = 1;
			if (part === 'utf8mb4') {
				variant = 'UCA 4.0.0';
			}
			if (UNICODE_CHARSETS.has(part) || part === 'utf8mb4') {
				name = 'Unicode';
				unicode = true;
			} else if (part === 'gb18030') {
				name = 'Chinese';
				unicode = true;
			} else if (Object.hasOwn(CHARSET_NAMES, part)) {
				name = CHARSET_NAMES[part];
			} else {
				name = 'Unknown';
				unknown = true;
			}
			continue;
		}
		if (level === 1) {
			level = 4;
			let found = true;
			if (Object.hasOwn(LANGUAGE_NAMES, part)) {
				name = LANGUAGE_NAMES[part];
			} else if (part === 'german' || part === 'de') {
				level = 2;
			} else if (part === 'es') {
				level = 3;
			} else if (['chinese', 'cn', 'zh'].includes(part)) {
				if (unicode) {
					name = 'Chinese';
				}
			} else if (part === 'unicode') {
				if (unknown) {
					name = 'Unicode';
				}
			} else if (part !== 'general') {
				found = false;
			}
			if (found) {
				continue;
			}
		}
		// Each level below falls through to the next one when the token is not its own.
		if (level === 2) {
			level = 4;
			if (part === 'pb') {
				name = 'German (phone book order)';
				continue;
			}
			name = 'German (dictionary order)';
		}
		if (level === 3) {
			level = 4;
			if (part === 'trad') {
				name = 'Spanish (traditional)';
				continue;
			}
			name = 'Spanish (modern)';
		}
		if (level === 4) {
			level = 5;
			if (Object.hasOwn(VARIANTS, part)) {
				variant = VARIANTS[part];
				continue;
			}
		}
		if (Object.hasOwn(SUFFIXES, part)) {
			suffixes.push(SUFFIXES[part]);
		}
	}
	let result = name;
	if (variant !== null) {
		result += ` (${variant})`;
	}
	if (suffixes.length > 0) {
		result += `, ${suffixes.join(', ')}`;
	}
	return result;
}

type Row = Record<string, string | null>;

const compareKeys = (left: string, right: string): number => strcmp(left, right);

/**
 * HomeController's charset list: Charsets::getCharsets() and getCollations(), both ksort()ed by name,
 * with the collation matching $collation_connection marked as selected.
 */
export function buildCharsetList(charsetRows: Row[], collationRows: Row[], selected: string): CharsetEntry[] {
	const charsets = new Map<string, string>();
	for (const row of charsetRows) {
		charsets.set(row.Charset ?? '', row.Description ?? '');
	}
	const collations = new Map<string, Set<string>>();
	for (const row of collationRows) {
		const charset = row.Charset ?? '';
		const names = collations.get(charset) ?? new Set<string>();
		names.add(row.Collation ?? '');
		collations.set(charset, names);
	}
	return charsets.keys().toArray().toSorted(compareKeys)
		.map((charset) => {
			const names = (collations.get(charset) ?? new Set<string>()).values().toArray().toSorted(compareKeys);
			return {
				name: charset,
				description: charsets.get(charset) as string,
				collations: names.map((name) => { return { name, description: collationDescription(name), is_selected: name === selected }; }),
			};
		});
}

const isYes = (value: string | null | undefined): boolean => value === 'Yes' || value === '1';

/** Charsets\Charset, for templates that call its getters. */
export class Charset {
	/** Charset::fromServer() for a CHARSETS_QUERY row. */
	static fromServer(row: Row): Charset {
		return new Charset(row.Charset ?? '', row.Description ?? '', row['Default collation'] ?? '', Number.parseInt(row.Maxlen ?? '0', 10) || 0);
	}

	private constructor(private readonly name: string, private readonly description: string, private readonly defaultCollation: string, private readonly maxLength: number) {}

	getName(): string {
		return this.name;
	}

	getDescription(): string {
		return this.description;
	}

	getDefaultCollation(): string {
		return this.defaultCollation;
	}

	getMaxLength(): number {
		return this.maxLength;
	}
}

/** Charsets\Collation, for templates that call its getters. */
export class Collation {
	/** Collation::fromServer() for a collationsQuery() row. */
	static fromServer(row: Row): Collation {
		const toInt = (value: string | null | undefined): number => Number.parseInt(value ?? '0', 10) || 0;
		return new Collation(row.Collation ?? '', row.Charset ?? '', toInt(row.Id), isYes(row.Default), isYes(row.Compiled), toInt(row.Sortlen), row.Pad_attribute ?? '');
	}

	private readonly description: string;

	private constructor(
		private readonly name: string,
		private readonly charset: string,
		private readonly id: number,
		private readonly defaultFlag: boolean,
		private readonly compiled: boolean,
		private readonly sortLength: number,
		private readonly padAttribute: string,
	) {
		this.description = collationDescription(name);
	}

	getName(): string {
		return this.name;
	}

	getDescription(): string {
		return this.description;
	}

	getCharset(): string {
		return this.charset;
	}

	getId(): number {
		return this.id;
	}

	isDefault(): boolean {
		return this.defaultFlag;
	}

	isCompiled(): boolean {
		return this.compiled;
	}

	getSortLength(): number {
		return this.sortLength;
	}

	getPadAttribute(): string {
		return this.padAttribute;
	}
}

/** Charsets::getCharsets(): keyed by name and ksort()ed. */
export function charsetsFromRows(rows: Row[]): Map<string, Charset> {
	const entries = rows.map((row): [string, Charset] => [row.Charset ?? '', Charset.fromServer(row)]);
	return new Map(entries.toSorted(([left], [right]) => compareKeys(left, right)));
}

/** Charsets::getCollations(): [charset][collation], each level ksort()ed by name. */
export function collationsFromRows(rows: Row[]): Map<string, Map<string, Collation>> {
	const byCharset = new Map<string, Map<string, Collation>>();
	for (const row of rows) {
		const charset = row.Charset ?? '';
		const collations = byCharset.get(charset) ?? new Map<string, Collation>();
		collations.set(row.Collation ?? '', Collation.fromServer(row));
		byCharset.set(charset, collations);
	}
	for (const [charset, collations] of byCharset) {
		byCharset.set(charset, new Map([...collations].toSorted(([left], [right]) => compareKeys(left, right))));
	}
	return byCharset;
}

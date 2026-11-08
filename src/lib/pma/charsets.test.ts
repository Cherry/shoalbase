import { describe, expect, it } from 'vitest';

import {
	CHARSETS_QUERY,
	Charset,
	Collation,
	buildCharsetList,
	charsetsFromRows,
	collationDescription,
	collationsFromRows,
	collationsQuery,
} from './charsets.ts';

describe('collationDescription', () => {
	// Expected values come from PhpMyAdmin\Charsets\Collation::getDescription() in phpMyAdmin 5.2.3; all 1320 collations
	// of MySQL 8.4 and MariaDB 12.3 were checked the same way.
	it.each([
		['utf8mb4_0900_ai_ci', 'Unicode (UCA 9.0.0), accent-insensitive, case-insensitive'],
		['utf8mb4_unicode_ci', 'Unicode (UCA 4.0.0), case-insensitive'],
		['utf8mb4_unicode_520_ci', 'Unicode (UCA 5.2.0), case-insensitive'],
		['utf8mb4_bin', 'Unicode (UCA 4.0.0), binary'],
		['utf8mb3_unicode_nopad_ci', 'Unicode, no-pad, case-insensitive'],
		['utf8mb4_uca1400_ai_ci', 'Unicode (UCA 4.0.0), accent-insensitive, case-insensitive'],
		['ucs2_general_mysql500_ci', 'Unicode (MySQL 5.0.0), case-insensitive'],
		['utf8mb4_croatian_mysql561_ci', 'Croatian (MySQL 5.6.1), case-insensitive'],
		['binary', 'Binary'],
		['utf8mb4_german2_ci', 'German (phone book order) (UCA 4.0.0), case-insensitive'],
		['latin1_german1_ci', 'German (dictionary order), case-insensitive'],
		['utf8mb4_de_pb_0900_ai_ci', 'German (phone book order) (UCA 9.0.0), accent-insensitive, case-insensitive'],
		['utf8_german_x', 'German (dictionary order)'],
		['utf8mb4_es_trad_0900_ai_ci', 'Spanish (traditional) (UCA 9.0.0), accent-insensitive, case-insensitive'],
		['utf8mb4_es_0900_ai_ci', 'Spanish (modern) (UCA 9.0.0), accent-insensitive, case-insensitive'],
		['utf8mb4_es_x', 'Spanish (modern) (UCA 4.0.0)'],
		['utf8mb4_spanish2_ci', 'Spanish (traditional) (UCA 4.0.0), case-insensitive'],
		['latin1_spanish_ci', 'Spanish (modern), case-insensitive'],
		['gb18030_chinese_ci', 'Chinese, case-insensitive'],
		['big5_chinese_ci', 'Traditional Chinese, case-insensitive'],
		['latin1_chinese_ci', 'West European, case-insensitive'],
		['utf8_chinese_ci', 'Chinese, case-insensitive'],
		['xyz_unicode_ci', 'Unicode, case-insensitive'],
		['utf8mb4_unicode_xx', 'Unicode (UCA 4.0.0)'],
		['xyz_general', 'Unknown'],
		['foo', 'Unknown'],
		['utf8mb4_ja_0900_as_cs_ks', 'Japanese (UCA 9.0.0), accent-sensitive, case-sensitive, kana-sensitive'],
		['utf8mb4_ru_0900_as_cs', 'Russian (UCA 9.0.0), accent-sensitive, case-sensitive'],
		['utf8mb4_my_0900_ai_ci', 'Burmese (UCA 9.0.0), accent-insensitive, case-insensitive'],
		['utf8mb4_la_0900_ai_ci', 'Classical Latin (UCA 9.0.0), accent-insensitive, case-insensitive'],
		['latin7_estonian_cs', 'Estonian, case-sensitive'],
		['cp1251_general_cs', 'Cyrillic, case-sensitive'],
		['latin1_general_w2', 'West European, multi-level'],
		['koi8u_general_l2_ci', 'Ukrainian, multi-level, case-insensitive'],
	])('describes %s', (name, description) => {
		expect(collationDescription(name)).toBe(description);
	});
});

describe('collationsQuery', () => {
	it('reads MariaDB 10.10+ collations from the applicability table, which lists one row per character set', () => {
		expect(collationsQuery(true, 101000)).toContain('FROM `information_schema`.`COLLATION_CHARACTER_SET_APPLICABILITY` `collapp`');
		expect(collationsQuery(true, 100906)).toBe(collationsQuery(false, 101000));
		expect(collationsQuery(false, 80413)).toBe('SELECT `COLLATION_NAME` AS `Collation`, `CHARACTER_SET_NAME` AS `Charset`, `ID` AS `Id`, `IS_DEFAULT` AS `Default`, `IS_COMPILED` AS `Compiled`, `SORTLEN` AS `Sortlen` FROM `information_schema`.`COLLATIONS`');
		expect(CHARSETS_QUERY).toBe('SELECT `CHARACTER_SET_NAME` AS `Charset`, `DEFAULT_COLLATE_NAME` AS `Default collation`, `DESCRIPTION` AS `Description`, `MAXLEN` AS `Maxlen` FROM `information_schema`.`CHARACTER_SETS`');
	});
});

describe('buildCharsetList', () => {
	it('sorts charsets and collations by byte order and marks the connection collation', () => {
		const charsets = [
			{ Charset: 'utf8mb4', Description: 'UTF-8 Unicode' },
			{ Charset: 'ascii', Description: 'US ASCII' },
			{ Charset: 'utf8mb3', Description: 'UTF-8 Unicode' },
		];
		const collations = [
			{ Collation: 'utf8mb4_unicode_ci', Charset: 'utf8mb4' },
			{ Collation: 'utf8mb4_0900_ai_ci', Charset: 'utf8mb4' },
			{ Collation: 'ascii_bin', Charset: 'ascii' },
			{ Collation: 'utf8mb4_Z', Charset: 'utf8mb4' },
		];
		expect(buildCharsetList(charsets, collations, 'utf8mb4_unicode_ci')).toEqual([
			{ name: 'ascii', description: 'US ASCII', collations: [{ name: 'ascii_bin', description: 'West European, binary', is_selected: false }] },
			// A character set without collations still gets its (empty) group, as the home page shows.
			{ name: 'utf8mb3', description: 'UTF-8 Unicode', collations: [] },
			{
				name: 'utf8mb4',
				description: 'UTF-8 Unicode',
				collations: [
					{ name: 'utf8mb4_0900_ai_ci', description: 'Unicode (UCA 9.0.0), accent-insensitive, case-insensitive', is_selected: false },
					{ name: 'utf8mb4_Z', description: 'Unicode (UCA 4.0.0)', is_selected: false },
					{ name: 'utf8mb4_unicode_ci', description: 'Unicode (UCA 4.0.0), case-insensitive', is_selected: true },
				],
			},
		]);
	});

	it('treats missing columns as empty strings like Charset::fromServer()', () => {
		expect(buildCharsetList([{ Charset: null, Description: null }], [{ Collation: null, Charset: null }], '')).toEqual([
			{ name: '', description: '', collations: [{ name: '', description: 'Unknown', is_selected: true }] },
		]);
	});
});

describe('Charset and Collation objects', () => {
	it('read server rows like Charset::fromServer() and Collation::fromServer()', () => {
		const charset = Charset.fromServer({ 'Charset': 'utf8mb4', 'Description': 'UTF-8 Unicode', 'Default collation': 'utf8mb4_0900_ai_ci', 'Maxlen': '4' });
		expect([charset.getName(), charset.getDescription(), charset.getDefaultCollation(), charset.getMaxLength()]).toEqual(['utf8mb4', 'UTF-8 Unicode', 'utf8mb4_0900_ai_ci', 4]);
		expect(Charset.fromServer({}).getMaxLength()).toBe(0);
		const collation = Collation.fromServer({ Collation: 'utf8mb4_bin', Charset: 'utf8mb4', Id: '46', Default: '', Compiled: 'Yes', Sortlen: '1', Pad_attribute: 'PAD SPACE' });
		expect([collation.getName(), collation.getCharset(), collation.getId(), collation.isDefault(), collation.isCompiled(), collation.getSortLength(), collation.getPadAttribute()])
			.toEqual(['utf8mb4_bin', 'utf8mb4', 46, false, true, 1, 'PAD SPACE']);
		expect(collation.getDescription()).toBe('Unicode (UCA 4.0.0), binary');
		const empty = Collation.fromServer({ Default: '1' });
		expect([empty.getName(), empty.getId(), empty.isDefault(), empty.getPadAttribute()]).toEqual(['', 0, true, '']);
	});

	it('sorts character sets by name and collations by name within each set, keeping the set order of the rows', () => {
		const charsets = charsetsFromRows([{ Charset: 'utf8mb4' }, { Charset: 'latin1' }, {}]);
		expect(charsets.keys().toArray()).toEqual(['', 'latin1', 'utf8mb4']);
		const collations = collationsFromRows([
			{ Charset: 'utf8mb4', Collation: 'utf8mb4_general_ci' },
			{ Charset: 'latin1', Collation: 'latin1_swedish_ci' },
			{ Charset: 'utf8mb4', Collation: 'utf8mb4_bin' },
			{},
		]);
		expect(collations.keys().toArray()).toEqual(['utf8mb4', 'latin1', '']);
		expect(collations.get('utf8mb4')?.keys().toArray()).toEqual(['utf8mb4_bin', 'utf8mb4_general_ci']);
	});
});

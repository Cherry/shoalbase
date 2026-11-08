import { describe, expect, it } from 'vitest';

import {
	type TranslationCatalog,
	buildTransMessage,
	englishCatalog,
	strtr,
	translate,
} from './i18n';

describe('buildTransMessage', () => {
	it('turns printed variables into %name% placeholders and trims like PHP', () => {
		expect(buildTransMessage([
			{ text: '\n          You are using ' },
			{ variable: 'server' },
			{ text: ' as %s.\n        ' },
		])).toEqual({ message: 'You are using %server% as %s.', variables: ['server'] });
	});
});

describe('englishCatalog', () => {
	it('returns msgids and picks English plural forms', () => {
		expect(englishCatalog.gettext('Log in', null)).toBe('Log in');
		expect(englishCatalog.ngettext('%count% table', '%count% tables', 1, null)).toBe('%count% table');
		expect(englishCatalog.ngettext('%count% table', '%count% tables', 0, null)).toBe('%count% tables');
	});
});

describe('translate', () => {
	it('substitutes variables without escaping, as TransNode echoes raw', () => {
		expect(translate({ message: 'Hello %name%', plural: null, count: null, context: null, variables: { '%name%': '<b>Bob</b>' } }, englishCatalog))
			.toBe('Hello <b>Bob</b>');
	});

	it('uses abs() of the plural expression for %count%', () => {
		const call = { message: '%count% row', plural: '%count% rows', count: -1, context: null, variables: { '%count%': 'ignored' } };
		expect(translate(call, englishCatalog)).toBe('1 row');
		expect(translate({ ...call, count: '5' }, englishCatalog)).toBe('5 rows');
	});

	it('keeps a %count% variable as-is when there is no plural form', () => {
		expect(translate({ message: '%count% left', plural: null, count: null, context: null, variables: { '%count%': -2 } }, englishCatalog))
			.toBe('-2 left');
	});

	it('passes the context to the catalog', () => {
		const calls: unknown[][] = [];
		const catalog: TranslationCatalog = {
			gettext: (...args) => {
				calls.push(args);
				return 'Alle anzeigen';
			},
			ngettext: (...args) => {
				calls.push(args);
				return '%count% Zeilen';
			},
		};
		expect(translate({ message: 'View all', plural: null, count: null, context: 'View all themes', variables: {} }, catalog)).toBe('Alle anzeigen');
		expect(translate({ message: '%count% row', plural: '%count% rows', count: 3, context: 'Rows', variables: { '%count%': 3 } }, catalog)).toBe('3 Zeilen');
		expect(calls).toEqual([['View all', 'View all themes'], ['%count% row', '%count% rows', 3, 'Rows']]);
	});
});

describe('strtr', () => {
	it('prefers the longest key and never rescans replacements', () => {
		const pairs = new Map([['%a%', '%ab%'], ['%ab%', 'X'], ['', 'never']]);
		expect(strtr('%ab% %a% $1 (.)', pairs)).toBe('X %ab% $1 (.)');
	});

	it('returns the subject untouched without keys', () => {
		expect(strtr('100%', new Map())).toBe('100%');
	});
});

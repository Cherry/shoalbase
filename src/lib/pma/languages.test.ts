// @vitest-environment node
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { languageDisplayName, sortedLanguages } from './languages';

describe('languages', () => {
	it('lists the same languages, order and names as the live 5.2.3 login page', () => {
		const live = readFileSync(new URL('../../../tests/fixtures/pma-5.2.3/login.page.html', import.meta.url), 'utf8');
		const select = live.slice(live.indexOf('id="languageSelect"'), live.indexOf('</select>', live.indexOf('id="languageSelect"')));
		const options = select.matchAll(/<option value="([^"]+)"(?: selected)?>([^<]*)<\/option>/g).map(([, code, name]) => [code, name]).toArray();
		expect(sortedLanguages().map(language => [language.code.toLowerCase(), languageDisplayName(language)])).toEqual(options);
	});

	it('shows only the English name when there is no native one', () => {
		expect(languageDisplayName({ code: 'ia', name: 'Interlingua', native: '' })).toBe('Interlingua');
	});
});

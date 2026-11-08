// @vitest-environment node
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { getJavaScriptMessages } from './js-messages';
import { phpJsonEncode } from './json';
import { englishCatalog } from '../twig/i18n';

const options = {
	catalog: englishCatalog,
	gridEditing: 'double-click',
	ajaxClockSmallGifPath: './themes/pmahomme/img/ajax_clock_small.gif',
};

describe('getJavaScriptMessages', () => {
	it('reproduces js/messages.php from phpMyAdmin 5.2.3 byte-for-byte', () => {
		const live = readFileSync(new URL('../../../tests/fixtures/pma-5.2.3/messages.js', import.meta.url), 'utf8');
		expect(`var Messages = ${phpJsonEncode(getJavaScriptMessages(options))};`).toBe(live);
	});

	it('follows GridEditing for the grid edit hint', () => {
		expect(getJavaScriptMessages({ ...options, gridEditing: 'click' }).strGridEditFeatureHint)
			.toBe('You can also edit most values<br>by clicking directly on them.');
		expect(getJavaScriptMessages({ ...options, gridEditing: 'disabled' }).strGridEditFeatureHint).toBe('');
	});

	it('translates through the catalog, passing msgctxt for _pgettext() entries', () => {
		const catalog = {
			gettext: (message: string, context: string | null) => `${context ?? ''}|${message}`,
			ngettext: (singular: string) => singular,
		};
		const messages = getJavaScriptMessages({ ...options, catalog });
		expect(messages.strConfirm).toBe('|Confirm');
		expect(messages.strLock).toBe('Lock the account.|Lock');
	});
});

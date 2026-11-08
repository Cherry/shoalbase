import { describe, expect, it } from 'vitest';

import {
	logoSettings,
	pageFromPosition,
	pageSelector,
	pageSelectorPages,
	recentFavoriteHtml,
	resultsFound,
	serverOptions,
	treeControls,
} from './navigation-html.ts';

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, index) => from + index);

describe('pageSelector', () => {
	// Expected values come from Util::pageselector() in phpMyAdmin 5.2.3.
	it('renders every page of a short list, marking the current one', () => {
		expect(pageSelector('pos2_value', 50, 2, 3)).toBe(' <select class="pageselector ajax" name="pos2_value" >'
			+ '                <option  value="0">1</option>\n'
			+ '                <option selected="selected" style="font-weight: bold" value="50">2</option>\n'
			+ '                <option  value="100">3</option>\n'
			+ ' </select>');
	});

	it('samples long lists around the current page', () => {
		expect(pageSelectorPages(500, 1000)).toEqual([
			...range(1, 5),
			55,
			105,
			155,
			205,
			244,
			255,
			305,
			355,
			372,
			405,
			436,
			455,
			468,
			484,
			490,
			...range(491, 511),
			516,
			532,
			561,
			564,
			611,
			628,
			661,
			711,
			756,
			761,
			811,
			861,
			911,
			961,
			...range(995, 1000),
		]);
		expect(pageSelectorPages(9, 250)).toEqual([
			...range(1, 20), 25, 32, 41, 44, 56, 68, 73, 80, 92, 104, 116, 128, 137, 140, 152, 164, 176, 188, 200, 212, 224, 236, ...range(245, 250),
		]);
	});

	it('adds a current page beyond the end', () => {
		expect(pageSelectorPages(5, 3)).toEqual([1, 2, 3, 5]);
	});

	it('turns positions into page numbers', () => {
		expect(pageFromPosition(0, 50)).toBe(1);
		expect(pageFromPosition(99, 50)).toBe(2);
	});
});

describe('panel pieces', () => {
	it('builds the collapse and link controls for the sync setting', () => {
		expect(treeControls(true)).toEqual({
			collapseAll: '<a href="#" id="pma_navigation_collapse" title="Collapse all"><img src="themes/dot.gif" title="Collapse all" alt="Collapse all" class="icon ic_s_collapseall"></a>',
			unlink: '<a href="#" id="pma_navigation_sync" title="Unlink from main panel"><img src="themes/dot.gif" title="Unlink from main panel" alt="Unlink from main panel" class="icon ic_s_link"></a>',
		});
		expect(treeControls(false).unlink).toContain('title="Link with main panel"><img src="themes/dot.gif" title="Link with main panel" alt="Link with main panel" class="icon ic_s_unlink">');
	});

	it('wraps recent and favorite lists in their drop-downs', () => {
		expect(recentFavoriteHtml('recent', '<li>x</li>')).toBe('<div class="drop_list"><button title="Recent tables" class="drop_button btn">Recent</button><ul id="pma_recent_list"><li>x</li></ul></div>');
		expect(recentFavoriteHtml('favorite', '')).toBe('<div class="drop_list"><button title="Favorite tables" class="drop_button btn">Favorites</button><ul id="pma_favorite_list"></ul></div>');
	});

	it('pluralises the filter result count', () => {
		expect(resultsFound(1)).toBe('1 result found');
		expect(resultsFound(0)).toBe('0 results found');
		expect(resultsFound(2)).toBe('2 results found');
	});

	it('numbers servers from 1 and selects the current one', () => {
		expect(serverOptions(['a', 'b'], 2)).toEqual([{ value: 1, selected: 0, label: 'a' }, { value: 2, selected: 1, label: 'b' }]);
	});

	it('links the logo inside the main panel with the common URL parameters', () => {
		const common = (divider: string) => `${divider}lang=en`;
		expect(logoSettings(true, ' index.php ', 'main', 'logo.png', common)).toEqual({ is_displayed: true, has_link: true, link: 'index.php?lang=en', attributes: '', source: 'logo.png' });
		expect(logoSettings(true, 'index.php?route=/', 'main', '', common).link).toBe('index.php?route=/&lang=en');
		expect(logoSettings(false, '', 'new', '', common)).toEqual({ is_displayed: false, has_link: false, link: '', attributes: ' target="_blank" rel="noopener noreferrer"', source: '' });
	});
});

// Small HTML builders the navigation panel needs: Util::pageselector(), Generator::getNavigationLink() and friends.
import { getImage } from '../twig/html.ts';

/** The pages Util::pageselector() offers: all of them below $showAll, otherwise a sample around the current one. */
export function pageSelectorPages(pageNow: number, nbTotalPage: number, showAll = 200, sliceStart = 5, sliceEnd = 5, percent = 20, range = 10): number[] {
	let pages: number[] = [];
	if (nbTotalPage < showAll) {
		pages = Array.from({ length: nbTotalPage }, (_, index) => index + 1);
	} else {
		const increment = Math.floor(nbTotalPage / percent);
		const pageNowMinusRange = pageNow - range;
		const pageNowPlusRange = pageNow + range;
		for (let page = 1; page <= sliceStart; page++) {
			pages.push(page);
		}
		for (let page = nbTotalPage - sliceEnd; page <= nbTotalPage; page++) {
			pages.push(page);
		}
		let page = sliceStart;
		const last = nbTotalPage - sliceEnd;
		let metBoundary = false;
		while (page <= last) {
			if (page >= pageNowMinusRange && page <= pageNowPlusRange) {
				page++;
				metBoundary = true;
			} else {
				page += increment;
				if (page > pageNowMinusRange && !metBoundary) {
					page = pageNowMinusRange;
				}
			}
			if (page > 0 && page <= last) {
				pages.push(page);
			}
		}
		// Pages at doubling distances from the current one help on huge lists.
		let candidate = pageNow;
		let distance = 1;
		while (candidate < last) {
			distance *= 2;
			candidate = pageNow + distance;
			if (candidate > 0 && candidate <= last) {
				pages.push(candidate);
			}
		}
		candidate = pageNow;
		distance = 1;
		while (candidate > 0) {
			distance *= 2;
			candidate = pageNow - distance;
			if (candidate > 0 && candidate <= last) {
				pages.push(candidate);
			}
		}
		pages = [...new Set(pages.toSorted((left, right) => left - right))];
	}
	if (pageNow > nbTotalPage) {
		pages.push(pageNow);
	}
	return pages;
}

/** Util::pageselector(): a select of page start positions. */
export function pageSelector(name: string, rows: number, pageNow: number, nbTotalPage: number): string {
	let html = ` <select class="pageselector ajax" name="${name}" >`;
	for (const page of pageSelectorPages(pageNow, nbTotalPage)) {
		const selected = page === pageNow ? 'selected="selected" style="font-weight: bold"' : '';
		html += `                <option ${selected} value="${(page - 1) * rows}">${page}</option>\n`;
	}
	return `${html} </select>`;
}

/** Util::getPageFromPosition(). */
export function pageFromPosition(pos: number, maxCount: number): number {
	return Math.floor(pos / maxCount) + 1;
}

/** Generator::getNavigationLink() as the tree controls call it: icon only. */
export function navigationIconLink(text: string, icon: string, linkId: string): string {
	return `<a href="#" id="${linkId}" title="${text}">${getImage(icon, text)}</a>`;
}

/** NavigationTree::controls(). */
export function treeControls(linkWithMainPanel: boolean): { collapseAll: string; unlink: string; } {
	let syncImage = 's_unlink';
	let title = 'Link with main panel';
	if (linkWithMainPanel) {
		syncImage = 's_link';
		title = 'Unlink from main panel';
	}
	return {
		collapseAll: navigationIconLink('Collapse all', 's_collapseall', 'pma_navigation_collapse'),
		unlink: navigationIconLink(title, syncImage, 'pma_navigation_sync'),
	};
}

/** RecentFavoriteTable::getHtml() around the list items getHtmlList() renders. */
export function recentFavoriteHtml(type: 'recent' | 'favorite', listHtml: string): string {
	if (type === 'recent') {
		return `<div class="drop_list"><button title="Recent tables" class="drop_button btn">Recent</button><ul id="pma_recent_list">${listHtml}</ul></div>`;
	}
	return `<div class="drop_list"><button title="Favorite tables" class="drop_button btn">Favorites</button><ul id="pma_favorite_list">${listHtml}</ul></div>`;
}

/** The fast filter's "%s result(s) found", with English plural rules. */
export function resultsFound(count: number): string {
	if (count === 1) {
		return `${count} result found`;
	}
	return `${count} results found`;
}

export interface ServerOption {
	value: number;
	selected: number;
	label: string;
}

/** Server\Select::render() options for a drop-down; production servers have no verbose name, port or only_db. */
export function serverOptions(hosts: string[], currentServer: number): ServerOption[] {
	return hosts.map((host, index) => {
		return { value: index + 1, selected: Number(currentServer === index + 1), label: host };
	});
}

export interface LogoSettings {
	is_displayed: boolean;
	has_link: boolean;
	link: string;
	attributes: string;
	source: string;
}

/**
 * Navigation::getDisplay()'s logo for a full page; `common` is Url::getCommon() for the given divider.
 * Sanitize::checkLink() and the external-host case are left out because production keeps NavigationLogoLink at 'index.php'.
 */
export function logoSettings(displayLogo: boolean, logoLink: string, linkWindow: string, source: string, common: (divider: string) => string): LogoSettings {
	const logo: LogoSettings = { is_displayed: displayLogo, has_link: logoLink !== '', link: logoLink.trim(), attributes: ' target="_blank" rel="noopener noreferrer"', source };
	if (linkWindow === 'main') {
		logo.link += common(logo.link.includes('?') ? '&' : '?');
		logo.attributes = '';
	}
	return logo;
}

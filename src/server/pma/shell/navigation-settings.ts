// The navigation panel's Config\PageSettings('Navi', 'pma_navigation_settings').
import { type PageSettings, getPageSettings } from '../core/page-settings.ts';

import type { PmaContext } from '../core/context.ts';

/** PageSettings for the navigation panel; a saved form has already set the Location header back to the page. */
export async function renderNaviSettings(context: PmaContext): Promise<PageSettings> {
	return getPageSettings(context, 'Navi', 'pma_navigation_settings');
}

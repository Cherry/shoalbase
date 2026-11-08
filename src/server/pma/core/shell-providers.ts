// Page pieces of the logged-in shell (navigation tree, top menu, console, header extras) that ResponseRenderer places around controller output.
import { renderConsole } from '../shell/console.ts';
import { renderLoadUserPreferences, renderRecentTable } from '../shell/header.ts';
import { renderMenu } from '../shell/menu.ts';
import { renderNavigation } from '../shell/navigation.ts';

import type { PmaContext } from './context.ts';

export type ShellRenderer = (context: PmaContext) => Promise<string>;

export interface ShellProviders {
	renderNavigation: ShellRenderer;
	renderMenu: ShellRenderer;
	renderConsole: ShellRenderer;
	renderRecentTable: ShellRenderer;
	renderLoadUserPreferences: ShellRenderer;
}

// Wrapped in functions because the shell modules import core modules: the circular imports are only safe to touch at call time.
export const shellProviders: ShellProviders = {
	renderNavigation: context => renderNavigation(context),
	renderMenu: context => renderMenu(context),
	renderConsole: context => renderConsole(context),
	renderRecentTable: context => renderRecentTable(context),
	renderLoadUserPreferences: context => renderLoadUserPreferences(context),
};

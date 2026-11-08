// Html\Generator and Html\MySQLDocumentation entry points bound to the request context; the pure parts live in src/lib.
import { linkOrButton as linkOrButtonFor } from '../../../lib/pma/generator.ts';
import { type GeneratorState, getIcon as getIconFor } from '../../../lib/twig/html.ts';
import { createTemplateState, toGeneratorState } from '../../twig/state.ts';

import type { PmaContext } from './context.ts';

export { getGeneratorMessage as getMessage } from '../shell/header-message.ts';
export { getImage, getDocumentationLink, getMySQLDocuUrl, showDocumentationLink, showHint, showMySQLDocumentation } from '../../../lib/twig/html.ts';

/** The $cfg and server version the Generator helpers read. */
export function generatorState(context: PmaContext): GeneratorState {
	const version = context.dbi.isConnected() ? context.dbi.getVersion() : 0;
	return toGeneratorState(createTemplateState({ config: context.config as unknown as Record<string, unknown>, mysqlVersion: version }));
}

/** Generator::getIcon(). */
export function getIcon(context: PmaContext, icon: string, alternate = '', forceText = false, menuIcon = false, controlParam = 'ActionLinksMode'): string {
	return getIconFor(generatorState(context), icon, alternate, forceText, menuIcon, controlParam);
}

/** Generator::linkOrButton(). */
export function linkOrButton(
	context: PmaContext,
	urlPath: string,
	urlParams: Record<string, unknown> | null,
	message: string,
	tagParams: Record<string, unknown> | string = {},
	target = '',
	respectUrlLengthLimit = true,
): string {
	const state = { url: context.urlState(), linkLengthLimit: context.config.LinkLengthLimit };
	return linkOrButtonFor(state, urlPath, urlParams, message, tagParams, target, respectUrlLengthLimit);
}

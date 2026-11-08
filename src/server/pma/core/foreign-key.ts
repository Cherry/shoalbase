// Port of PhpMyAdmin\Utils\ForeignKey: the "Enable foreign key checks" checkbox of confirmation forms.
import type { PmaContext } from './context.ts';

/** DatabaseInterface::setVariable(): skips the SET when the session already has the value. */
export async function setVariable(context: PmaContext, name: string, value: string): Promise<boolean> {
	const current = await context.dbi.getVariable(name);
	if (current === value) {
		return true;
	}
	await context.dbi.query(`SET ${name} = ${value};`);
	return true;
}

/** ForeignKey::isCheckEnabled(). */
export async function isCheckEnabled(context: PmaContext): Promise<boolean> {
	const setting = context.config.DefaultForeignKeyChecks;
	if (setting === 'enable') {
		return true;
	}
	if (setting === 'disable') {
		return false;
	}
	return await context.dbi.getVariable('FOREIGN_KEY_CHECKS') === 'ON';
}

/** ForeignKey::handleDisableCheckInit(): applies the request's fk_checks and returns the previous setting. */
export async function handleDisableCheckInit(context: PmaContext): Promise<boolean> {
	const defaultCheckValue = await context.dbi.getVariable('FOREIGN_KEY_CHECKS') === 'ON';
	const requested = context.request.params.fk_checks;
	if (requested !== undefined) {
		const enable = !(requested === '' || requested === '0' || (Array.isArray(requested) && requested.length === 0));
		await setVariable(context, 'FOREIGN_KEY_CHECKS', enable ? 'ON' : 'OFF');
	}
	return defaultCheckValue;
}

/** ForeignKey::handleDisableCheckCleanup(). */
export async function handleDisableCheckCleanup(context: PmaContext, defaultCheckValue: boolean): Promise<void> {
	await setVariable(context, 'FOREIGN_KEY_CHECKS', defaultCheckValue ? 'ON' : 'OFF');
}

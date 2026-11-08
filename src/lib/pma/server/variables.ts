// Pure parts of Server\VariablesController and its get/set AJAX siblings.
import { getVariableType } from './kbs.ts';
import { phpString } from '../../twig/php.ts';
import { isNumericString } from '../php-compare.ts';
import { formatByteDown, formatNumber } from '../util.ts';

/** PHP's is_numeric() for a value read from the server. */
export function isNumeric(value: unknown): boolean {
	if (typeof value === 'number') {
		return Number.isFinite(value);
	}
	return typeof value === 'string' && isNumericString(value);
}

/** formatByteDown() joined with a space, as implode(' ', ...) shows it. */
export function bytesText(value: string | number, limes: number, comma: number): string {
	return (formatByteDown(value, limes, comma) as string[]).join(' ');
}

function htmlEscape(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('\'', '&#039;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;');
}

/**
 * VariablesController::formatVariable(): [formatted value, whether it is HTML]. Byte sizes become an abbr with the exact
 * number, other numbers get thousands separators, and anything else stays as it is.
 */
export function formatVariable(name: string, value: string): [string, boolean] {
	if (!isNumeric(value)) {
		return [value, false];
	}
	if (getVariableType(name) === 'byte') {
		const title = htmlEscape(formatNumber(value, 0));
		return [`<abbr title="${title}">${htmlEscape(bytesText(value, 3, 3))}</abbr>`, true];
	}
	return [formatNumber(value, 0), false];
}


const SIZE_EXPONENTS: Record<string, number> = { kb: 1, kib: 1, mb: 2, mib: 2, gb: 3, gib: 3 };

/**
 * SetVariableController's value for SET GLOBAL: "10 MB" style sizes of byte variables become numbers, anything else is
 * escaped and quoted unless numeric. `escape` is DatabaseInterface::escapeString().
 */
export function setVariableValue(name: string, posted: string, escape: (value: string) => string): string {
	const match = /^\s*(\d+(\.\d+)?)\s*(mb|kb|mib|kib|gb|gib)\s*$/i.exec(posted);
	let value: string;
	if (getVariableType(name) === 'byte' && match !== null) {
		const size = Number.parseFloat(match[1] as string) * 1024 ** (SIZE_EXPONENTS[(match[3] as string).toLowerCase()] as number);
		value = phpString(size);
	} else {
		value = escape(posted);
	}
	if (!isNumericString(value)) {
		return `'${value}'`;
	}
	return value;
}

/** SetVariableController only accepts plain identifiers as variable names. */
export function isValidVariableName(name: string): boolean {
	return !/\W/.test(name);
}

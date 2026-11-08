// Template data for the server pages: Maps keep PHP's key order, and their values must become Twig arrays too.
import { toTwigValue } from '../../twig/values.ts';

/** toTwigValue() that also descends into Maps, so nested rows behave like PHP arrays. */
export function deepTwigValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(item => deepTwigValue(item));
	}
	let converted = value;
	if (!(value instanceof Map)) {
		converted = toTwigValue(value);
	}
	if (converted instanceof Map) {
		return new Map([...converted].map(([key, item]) => [key, deepTwigValue(item)]));
	}
	return converted;
}

/** The variables of one template render, converted with deepTwigValue(). */
export function twigVariables(variables: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(variables).map(([key, value]) => [key, deepTwigValue(value)]));
}

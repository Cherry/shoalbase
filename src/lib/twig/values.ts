// Twing models PHP arrays as Maps, while plain JS objects behave like PHP objects (|length, |merge and |keys break on them).

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function hasMethods(value: Record<string, unknown>): boolean {
	return Object.values(value).some(item => typeof item === 'function');
}

/** Converts PHP-array-shaped data to Maps, keeping objects with methods (stand-ins for PHP objects) intact. */
export function toTwigValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(item => toTwigValue(item));
	}
	if (isPlainObject(value) && !hasMethods(value)) {
		return new Map(Object.entries(value).map(([key, item]) => [key, toTwigValue(item)]));
	}
	return value;
}

/** The top level stays a plain object because Twing's render() reads it with Object.entries(). */
export function toTwigContext(context: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(context).map(([key, value]) => [key, toTwigValue(value)]));
}

/** Converts Twig hashes (Maps) back to plain objects so helpers can treat them like PHP arrays. */
export function fromTwigValue(value: unknown): unknown {
	if (value instanceof Map) {
		return Object.fromEntries([...value].map(([key, item]) => [String(key), fromTwigValue(item)]));
	}
	if (Array.isArray(value)) {
		return value.map(item => fromTwigValue(item));
	}
	return value;
}

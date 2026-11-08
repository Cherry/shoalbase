// PHP value semantics that phpMyAdmin's Twig templates and helpers depend on.

function phpFloatString(value: number): string {
	if (Number.isNaN(value)) {
		return 'NAN';
	}
	if (!Number.isFinite(value)) {
		return value > 0 ? 'INF' : '-INF';
	}
	if (Number.isSafeInteger(value)) {
		return String(value);
	}
	const [mantissa, exponentText] = value.toExponential(13).split('e', 2);
	const exponent = Number(exponentText);
	// PHP's %.14G switches to scientific notation outside this exponent range.
	if (exponent < -4 || exponent >= 14) {
		let digits = mantissa.replace(/0+$/, '');
		if (digits.endsWith('.')) {
			digits += '0';
		}
		const sign = exponent < 0 ? '-' : '+';
		return `${digits}E${sign}${Math.abs(exponent)}`;
	}
	return String(Number(value.toPrecision(14)));
}

const emptyStringValues: Set<unknown> = new Set([null, undefined, false]);

/** Mirrors PHP's (string) cast, including float formatting with the default precision of 14. */
export function phpString(value: unknown): string {
	if (emptyStringValues.has(value)) {
		return '';
	}
	if (value === true) {
		return '1';
	}
	if (typeof value === 'number') {
		return phpFloatString(value);
	}
	return String(value);
}

/** PHP's trim() strips only these characters, unlike String.prototype.trim(). */
export function phpTrim(value: string): string {
	return value.replaceAll(/^[\t\n\v\r\0 ]+|[\t\n\v\r\0 ]+$/g, '');
}

const htmlEntities: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	'\'': '&#039;',
};

/** htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE), which is also Twig's "html" escaping strategy. */
export function htmlspecialchars(value: unknown): string {
	return phpString(value).replaceAll(/[&<>"']/g, character => htmlEntities[character]);
}

/** PHP's urlencode(): spaces become "+" and only alphanumerics plus "-_." stay literal. */
export function urlencode(value: unknown): string {
	return encodeURIComponent(phpString(value))
		.replaceAll(/[!'()*~]/g, character => `%${(character.codePointAt(0) as number).toString(16).toUpperCase()}`)
		.replaceAll('%20', '+');
}

/** PHP's http_build_query() with nested arrays, skipping null values like PHP does. */
export function httpBuildQuery(params: Record<string, unknown>, separator = '&', prefix = ''): string {
	const parts: string[] = [];
	for (const [name, value] of Object.entries(params)) {
		if (value === null || value === undefined) {
			continue;
		}
		const key = prefix ? `${prefix}[${name}]` : name;
		if (typeof value === 'object') {
			const nested = httpBuildQuery(value as Record<string, unknown>, separator, key);
			if (nested) {
				parts.push(nested);
			}
		} else if (typeof value === 'boolean') {
			parts.push(`${urlencode(key)}=${value ? 1 : 0}`);
		} else {
			parts.push(`${urlencode(key)}=${urlencode(value)}`);
		}
	}
	return parts.join(separator);
}

/** Concatenation with PHP string casts, so `true ~ ''` gives "1" rather than "true". */
export function phpConcat(left: unknown, right: unknown): string {
	return phpString(left) + phpString(right);
}

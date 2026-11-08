// PHP's sprintf(), which Message::format() and many controllers use to fill translated strings.
import { phpString } from '../twig/php.ts';

const LEADING_NUMBER = /^[\t\n\v\f\r ]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i;

/** (float) $value. */
export function phpToFloat(value: unknown): number {
	if (typeof value === 'number') {
		return value;
	}
	if (typeof value === 'boolean') {
		return Number(value);
	}
	const match = LEADING_NUMBER.exec(phpString(value));
	return match ? Number(match[0]) : 0;
}

/** (int) $value: leading-numeric strings keep their number and anything else becomes 0. */
export function phpToInt(value: unknown): number {
	const number = Math.trunc(phpToFloat(value));
	return Number.isFinite(number) ? number : 0;
}

interface Spec {
	leftAlign: boolean;
	alwaysSign: boolean;
	padding: string;
	width: number;
	precision: number | null;
	conversion: string;
}

function pad(text: string, spec: Spec, isNegative = false): string {
	const missing = spec.width - text.length;
	if (missing <= 0) {
		return text;
	}
	const padding = spec.padding.repeat(missing);
	if (spec.leftAlign) {
		return text + padding;
	}
	// Zero padding goes between the sign and the digits, as php_sprintf_appendstring() does.
	if (spec.padding === '0' && (isNegative || text.startsWith('+'))) {
		return text[0] + padding + text.slice(1);
	}
	return padding + text;
}

function withSign(text: string, value: number, spec: Spec): string {
	if (spec.alwaysSign && value >= 0) {
		return `+${text}`;
	}
	return text;
}

// %u, %b, %o and %x print a negative integer as its 64-bit two's complement.
function unsignedBigInt(value: number): bigint {
	return BigInt.asUintN(64, BigInt(value));
}

// PHP rounds exact binary ties to even (zend_dtoa) where toFixed() rounds them away from zero.
function toFixedHalfEven(value: number, precision: number): string {
	const fixed = value.toFixed(precision);
	const exact = Math.abs(value).toFixed(100);
	const cut = exact.indexOf('.') + 1 + precision;
	if (!/^50*$/.test(exact.slice(cut))) {
		return fixed;
	}
	const truncated = exact.slice(0, precision === 0 ? cut - 1 : cut);
	if (Number(truncated.at(-1)) % 2 === 1) {
		return fixed;
	}
	return value < 0 ? `-${truncated}` : truncated;
}

function formatFloat(value: number, spec: Spec): string {
	const precision = spec.precision ?? 6;
	if (spec.conversion === 'e' || spec.conversion === 'E') {
		const text = value.toExponential(precision);
		return spec.conversion === 'E' ? text.toUpperCase() : text;
	}
	return toFixedHalfEven(value, precision);
}

function convert(value: unknown, spec: Spec): string {
	switch (spec.conversion) {
		case 's': {
			let text = phpString(value);
			if (spec.precision !== null) {
				text = text.slice(0, spec.precision);
			}
			return pad(text, spec);
		}
		case 'd': {
			const number = phpToInt(value);
			// php_sprintf_appendint() never pads a left-aligned integer with zeros.
			const intSpec = spec.leftAlign && spec.padding === '0' ? { ...spec, padding: ' ' } : spec;
			return pad(withSign(String(number), number, spec), intSpec, number < 0);
		}
		case 'u': {
			return pad(unsignedBigInt(phpToInt(value)).toString(), spec);
		}
		case 'c': {
			return String.fromCodePoint(phpToInt(value) & 0xFF);
		}
		case 'b': {
			return pad(unsignedBigInt(phpToInt(value)).toString(2), spec);
		}
		case 'o': {
			return pad(unsignedBigInt(phpToInt(value)).toString(8), spec);
		}
		case 'x': {
			return pad(unsignedBigInt(phpToInt(value)).toString(16), spec);
		}
		case 'X': {
			return pad(unsignedBigInt(phpToInt(value)).toString(16).toUpperCase(), spec);
		}
		default: {
			// e, E, f and F: phpMyAdmin always formats with the C locale.
			const number = phpToFloat(value);
			return pad(withSign(formatFloat(number, spec), number, spec), spec, number < 0);
		}
	}
}

const SPEC = /%(?:(\d+)\$)?((?:[-+ 0]|'[\s\S])*)([1-9]\d*)?(?:\.(\d+))?([b-fEFosuxX%])?/g;

function parseFlags(flags: string): Pick<Spec, 'leftAlign' | 'alwaysSign' | 'padding'> {
	const result = { leftAlign: false, alwaysSign: false, padding: ' ' };
	for (let index = 0; index < flags.length; index++) {
		const flag = flags[index];
		if (flag === '-') {
			result.leftAlign = true;
		} else if (flag === '+') {
			result.alwaysSign = true;
		} else if (flag === '\'') {
			index++;
			result.padding = flags[index];
		} else {
			result.padding = flag;
		}
	}
	return result;
}

/** sprintf($format, ...$args); like PHP 8, missing arguments throw. */
export function sprintf(format: string, ...args: unknown[]): string {
	let next = 0;
	return format.replaceAll(SPEC, (match: string, argnum: string | undefined, flags: string, width: string | undefined, precision: string | undefined, conversion: string | undefined) => {
		if (match === '%%') {
			return '%';
		}
		if (conversion === undefined || conversion === '%') {
			throw new Error(`Unknown format specifier in "${match}"`);
		}
		let index = next;
		if (argnum === undefined) {
			next++;
		} else {
			index = Number(argnum) - 1;
		}
		if (index < 0 || index >= args.length) {
			throw new Error(`Too few arguments for "${match}"`);
		}
		const spec: Spec = {
			...parseFlags(flags),
			width: Number(width ?? 0),
			precision: precision === undefined ? null : Number(precision),
			conversion,
		};
		return convert(args[index], spec);
	});
}

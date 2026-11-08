// Ports of PhpMyAdmin\Util formatting helpers with English strings; option routes and titles live in menu.ts and navigation-node.ts.
import { getUrlForOption } from './menu.ts';
import { sprintf } from './sprintf.ts';
import { getFromRoute } from '../twig/url.ts';

import type { UrlState } from '../twig/url.ts';

export { getUrlForOption } from './menu.ts';
export { getTitleForTarget } from './navigation-node.ts';

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];
const SI_UNITS: Record<number, string> = {
	[-8]: 'y',
	[-7]: 'z',
	[-6]: 'a',
	[-5]: 'f',
	[-4]: 'p',
	[-3]: 'n',
	[-2]: 'µ',
	[-1]: 'm',
	0: ' ',
	1: 'k',
	2: 'M',
	3: 'G',
	4: 'T',
	5: 'P',
	6: 'E',
	7: 'Z',
	8: 'Y',
};

/** PHP's round(): halves go away from zero, with the pre-rounding PHP applies to hide binary noise. */
export function phpRound(value: number, precision = 0): number {
	const factor = 10 ** precision;
	// PHP returns values beyond double precision unchanged, such as 18446744073709551615 as a float.
	if (Math.abs(value * factor) >= 1e15) {
		return value;
	}
	const scaled = Number((Math.abs(value) * factor).toPrecision(15));
	return Math.sign(value) * Math.round(scaled) / factor;
}

/** number_format(). */
export function numberFormat(value: number, decimals = 0, decimalSeparator = '.', thousandsSeparator = ','): string {
	const rounded = phpRound(value, decimals);
	const [whole, fraction = ''] = Math.abs(rounded).toFixed(decimals).split('.', 2);
	const grouped = whole.replaceAll(/\B(?=(?:\d{3})+(?!\d))/g, () => thousandsSeparator);
	const sign = rounded < 0 ? '-' : '';
	if (decimals > 0) {
		return `${sign}${grouped}${decimalSeparator}${fraction}`;
	}
	return sign + grouped;
}

// PHP's (float) of a numeric string; anything else is 0.
const toFloat = (value: number | string): number => {
	if (typeof value === 'number') {
		return value;
	}
	const match = /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.exec(value);
	return match ? Number(match[0]) : 0;
};

/** Util::formatNumber(): a number with an SI prefix so that about `digitsLeft` digits remain. */
export function formatNumber(input: number | string, digitsLeft = 3, digitsRight = 0, onlyDown = false, noTrailingZero = true): string {
	let value = toFloat(input);
	if (value === 0) {
		return '0';
	}
	if (digitsLeft === 0) {
		const formatted = numberFormat(value, digitsRight);
		if (toFloat(formatted) === 0) {
			return ` <${1 / 10 ** digitsRight}`;
		}
		return formatted;
	}
	const originalValue = value;
	let sign = '';
	if (value < 0) {
		sign = '-';
		value = Math.abs(value);
	}
	const dh = 10 ** digitsRight;
	let exponent = Math.floor(Math.log10(value) / 3);
	const currentDigits = Math.floor(Math.log10(value / 1000 ** exponent) + 1);
	if (digitsLeft > currentDigits) {
		exponent -= Math.floor((digitsLeft - currentDigits) / 3);
	}
	if (exponent < 0 && onlyDown) {
		exponent = 0;
	}
	value = phpRound(value / (1000 ** exponent / dh)) / dh;
	const unit = SI_UNITS[exponent];
	let formatted = numberFormat(value, digitsRight);
	if (noTrailingZero && formatted.includes('.')) {
		formatted = formatted.replace(/\.?0+$/, '');
	}
	if (originalValue !== 0 && value === 0) {
		return ` <${numberFormat(1 / 10 ** digitsRight, digitsRight)} ${unit}`;
	}
	return `${sign}${formatted} ${unit}`;
}

/** Util::formatByteDown(): the value and its binary unit, or null for a null value. */
export function formatByteDown(input: number | string | null, limes = 6, comma = 0): [string, string] | null {
	if (input === null) {
		return null;
	}
	let value = toFloat(input);
	const dh = 10 ** comma;
	const li = 10 ** limes;
	let unit = BYTE_UNITS[0];
	for (let power = 6, exponent = 15; power >= 1; power--, exponent -= 3) {
		if (value >= li * 10 ** exponent) {
			value = phpRound(value / (1024 ** power / dh)) / dh;
			unit = BYTE_UNITS[power];
			break;
		}
	}
	let formatted: string;
	if (unit === BYTE_UNITS[0]) {
		formatted = formatNumber(value, 0);
	} else {
		formatted = formatNumber(value, 5, comma, true, false);
	}
	return [formatted.trim(), unit];
}

/** Util::getFormattedMaximumUploadSize(). */
export function getFormattedMaximumUploadSize(maxUploadSize: number): string {
	const [size, unit] = formatByteDown(maxUploadSize, 4) as [string, string];
	return `(${sprintf('Max: %s%s', size, unit)})`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const pad = (value: number, length = 2): string => String(value).padStart(length, '0');

// strftime() for the numeric conversions; localisedDate() fills in names and AM/PM itself. UTC like the official image.
function strftime(format: string, date: Date): string {
	const hours = date.getUTCHours();
	const conversions: Record<string, () => string> = {
		'd': () => pad(date.getUTCDate()),
		'e': () => String(date.getUTCDate()).padStart(2, ' '),
		'H': () => pad(hours),
		'I': () => pad(hours % 12 === 0 ? 12 : hours % 12),
		'm': () => pad(date.getUTCMonth() + 1),
		'M': () => pad(date.getUTCMinutes()),
		'S': () => pad(date.getUTCSeconds()),
		'y': () => pad(date.getUTCFullYear() % 100),
		'Y': () => String(date.getUTCFullYear()),
		'w': () => String(date.getUTCDay()),
		'%': () => '%',
	};
	return format.replaceAll(/%(.)/g, (match, conversion: string) => conversions[conversion]?.() ?? match);
}

/** Util::localisedDate() for English: "%B %d, %Y at %I:%M %p" unless a format is given; timestamps are in seconds. */
export function localisedDate(timestamp = -1, format = ''): string {
	const seconds = timestamp === -1 ? Math.floor(Date.now() / 1000) : Math.trunc(timestamp);
	const date = new Date(seconds * 1000);
	let pattern = format === '' ? '%B %d, %Y at %I:%M %p' : format;
	// Upstream substitutes the short names itself, so %A and %B come out short too.
	pattern = pattern.replaceAll(/%a/gi, () => DAYS[date.getUTCDay()]).replaceAll(/%b/gi, () => MONTHS[date.getUTCMonth()])
		.replaceAll(/%p/gi, () => (date.getUTCHours() >= 12 ? 'PM' : 'AM'));
	return strftime(pattern, date);
}

/** Util::timespanFormat(). */
export function timespanFormat(totalSeconds: number): string {
	let seconds = totalSeconds;
	const days = Math.floor(seconds / 86400);
	if (days > 0) {
		seconds -= days * 86400;
	}
	const hours = Math.floor(seconds / 3600);
	if (days > 0 || hours > 0) {
		seconds -= hours * 3600;
	}
	const minutes = Math.floor(seconds / 60);
	if (days > 0 || hours > 0 || minutes > 0) {
		seconds -= minutes * 60;
	}
	return sprintf('%s days, %s hours, %s minutes and %s seconds', days, hours, minutes, seconds);
}

/** Util::getScriptNameForOption(): Url::getFromRoute() for a DefaultTab* setting, unescaped like upstream. */
export function getScriptNameForOption(state: UrlState, target: string, location: 'server' | 'database' | 'table'): string {
	return getFromRoute(state, getUrlForOption(target, location));
}

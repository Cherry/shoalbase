// PHP value semantics the sql-parser port depends on (empty(), casts, ASCII-only case mapping, stripcslashes()).

import { phpString, phpTrim } from '../lib/twig/php.ts';

export { phpTrim };

/** (string) $value, including PHP's float formatting. */
export function phpStr(value: unknown): string {
	if (value === undefined) {
		return '';
	}
	return phpString(value);
}

/** PHP 8 strtoupper() is locale-insensitive and only maps ASCII letters. */
export function strtoupper(value: string): string {
	return value.replaceAll(/[a-z]+/g, match => match.toUpperCase());
}

export function strtolower(value: string): string {
	return value.replaceAll(/[A-Z]+/g, match => match.toLowerCase());
}

/** strcasecmp() === 0 with ASCII-only folding. */
export function equalsIgnoreCase(left: string, right: string): boolean {
	return left.length === right.length && strtoupper(left) === strtoupper(right);
}

const EMPTY_SCALARS = new Set<unknown>([null, undefined, false, 0, '', '0']);

/** PHP's empty(): plain objects and Maps count as arrays, class instances are never empty. */
export function phpEmpty(value: unknown): boolean {
	if (EMPTY_SCALARS.has(value)) {
		return true;
	}
	if (Array.isArray(value)) {
		return value.length === 0;
	}
	if (value instanceof Map) {
		return value.size === 0;
	}
	if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
		return Object.keys(value).length === 0;
	}
	return Number.isNaN(value);
}

/** PHP truthiness. */
export function phpBool(value: unknown): boolean {
	return !phpEmpty(value);
}

/** isset($array[$key]) for the keyword tables, which are plain objects. */
export function isset<T>(table: Record<string, T>, key: unknown): boolean {
	if (typeof key !== 'string' && typeof key !== 'number') {
		return false;
	}
	return Object.hasOwn(table, key) && table[key] !== null && table[key] !== undefined;
}

/** $table[$key] ?? undefined, without reaching Object.prototype. */
export function lookup<T>(table: Record<string, T>, key: unknown): T | undefined {
	if ((typeof key !== 'string' && typeof key !== 'number') || !Object.hasOwn(table, key)) {
		return undefined;
	}
	return table[key];
}

const NUMERIC = /^[\t\n\v\f\r ]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?[\t\n\v\f\r ]*$/i;

/** is_numeric() for strings and numbers. */
export function isNumeric(value: unknown): boolean {
	if (typeof value === 'number') {
		return Number.isFinite(value);
	}
	return typeof value === 'string' && NUMERIC.test(value);
}

function looseNumberString(number: number, text: string): boolean {
	if (isNumeric(text)) {
		return number === Number(text.trim());
	}
	return phpStr(number) === text;
}

/** PHP 8 loose comparison (==) for the scalar values tokens carry. */
export function looseEquals(left: unknown, right: unknown): boolean {
	if (left === right) {
		return true;
	}
	if (left === null || left === undefined) {
		return phpEmpty(right) && !Array.isArray(right);
	}
	if (right === null || right === undefined) {
		return phpEmpty(left) && !Array.isArray(left);
	}
	if (typeof left === 'boolean' || typeof right === 'boolean') {
		return phpBool(left) === phpBool(right);
	}
	if (Array.isArray(left) && Array.isArray(right)) {
		return left.length === right.length && left.every((item, index) => looseEquals(item, right[index]));
	}
	if (typeof left === 'number' && typeof right === 'string') {
		return looseNumberString(left, right);
	}
	if (typeof left === 'string' && typeof right === 'number') {
		return looseNumberString(right, left);
	}
	if (typeof left === 'string' && typeof right === 'string' && isNumeric(left) && isNumeric(right)) {
		return Number(left.trim()) === Number(right.trim());
	}
	return false;
}

/** in_array($needle, $haystack) with loose comparison. */
export function inArrayLoose(needle: unknown, haystack: readonly unknown[]): boolean {
	return haystack.some(item => looseEquals(item, needle));
}

/** hexdec() ignores every character that is not a hexadecimal digit. */
export function hexdec(value: string): number {
	const digits = value.replaceAll(/[^0-9a-f]/gi, '');
	if (digits === '') {
		return 0;
	}
	return Number.parseInt(digits, 16);
}

/** PHP's trim() with a custom character list (only used with plain characters). */
export function phpRtrim(value: string, characters: string): string {
	let end = value.length;
	while (end > 0 && characters.includes(value[end - 1])) {
		end--;
	}
	return value.slice(0, end);
}

function sliceLikePhp<T extends string | string[]>(value: T, start: number, length?: number): T {
	const size = value.length;
	let from = start < 0 ? Math.max(size + start, 0) : Math.min(start, size);
	let to = size;
	if (length !== undefined) {
		to = (length < 0 ? size : from) + length;
	}
	if (to < from) {
		to = from;
	}
	from = Math.min(from, size);
	return value.slice(from, to) as T;
}

/** mb_substr($value, $start, $length) on code points; a negative length stops that many code points from the end. */
export function mbSubstr(value: string, start: number, length?: number): string {
	// Astral characters are rare in SQL, so plain strings take the fast path.
	if (!/[\uD800-\uDFFF]/.test(value)) {
		return sliceLikePhp(value, start, length);
	}
	return sliceLikePhp([...value], start, length).join('');
}

/** mb_strlen($value). */
export function mbStrlen(value: string): number {
	if (!/[\uD800-\uDFFF]/.test(value)) {
		return value.length;
	}
	return [...value].length;
}

const SIMPLE_ESCAPES: Record<string, string> = {
	'n': '\n',
	'r': '\r',
	'a': '\u{7}',
	't': '\t',
	'v': '\v',
	'b': '\b',
	'f': '\f',
	'\\': '\\',
};

const isHexDigit = (character: string | undefined): boolean => character !== undefined && /^[0-9a-f]$/i.test(character);
const isOctalDigit = (character: string | undefined): boolean => character !== undefined && character >= '0' && character <= '7';

/** stripcslashes(): C-style escapes, \xHH and up to three octal digits; other escaped characters lose the backslash. */
export function stripcslashes(value: string): string {
	if (!value.includes('\\')) {
		return value;
	}
	let result = '';
	for (let index = 0; index < value.length; index++) {
		const character = value[index];
		if (character !== '\\' || index + 1 >= value.length) {
			result += character;
			continue;
		}
		index++;
		const escaped = value[index];
		if (Object.hasOwn(SIMPLE_ESCAPES, escaped)) {
			result += SIMPLE_ESCAPES[escaped];
			continue;
		}
		if (escaped === 'x' && isHexDigit(value[index + 1])) {
			let hex = value[++index];
			if (isHexDigit(value[index + 1])) {
				hex += value[++index];
			}
			result += String.fromCodePoint(Number.parseInt(hex, 16));
			continue;
		}
		let octal = '';
		while (index < value.length && isOctalDigit(value[index]) && octal.length < 3) {
			octal += value[index++];
		}
		if (octal === '') {
			result += escaped;
		} else {
			// PHP stores the value in a single byte.
			result += String.fromCodePoint(Number.parseInt(octal, 8) % 256);
			index--;
		}
	}
	return result;
}

/** htmlspecialchars($value, ENT_NOQUOTES). */
export function htmlspecialcharsNoQuotes(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** htmlspecialchars($value) with PHP 8.1 defaults (ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML401). */
export function htmlspecialcharsDefault(value: string): string {
	return htmlspecialcharsNoQuotes(value).replaceAll('"', '&quot;').replaceAll('\'', '&#039;');
}

/** stripos($haystack, $needle) with ASCII folding; returns false when missing, like PHP. */
export function stripos(haystack: string, needle: string): number | false {
	const index = strtoupper(haystack).indexOf(strtoupper(needle));
	return index === -1 ? false : index;
}

export { phpToFloat, phpToInt } from '../lib/pma/sprintf.ts';

/** `$object->method()` on null is a fatal error in PHP, not a warning; this keeps that failure. */
export function member<T>(value: T | null | undefined): T {
	if (value === null || value === undefined) {
		throw new TypeError('Call to a member function on null');
	}
	return value;
}

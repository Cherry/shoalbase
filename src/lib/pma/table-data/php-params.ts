// PHP's request variable parsing for bracketed names such as fields[multi_edit][0][<md5>], which paramsFrom() keeps flat.
import type { RequestParams } from '../../pma-request.ts';

export type PhpValue = string | PhpArray;

// PHP arrays keep insertion order even for integer keys, which plain objects sort first; the order rides along under a symbol.
const ORDER = Symbol('php key order');

export interface PhpArray {
	[key: string]: PhpValue;
	[ORDER]?: string[];
}

const NAME_PATTERN = /^([^[]+)((?:\[[^\]]*\])+)$/;

function splitName(name: string): string[] {
	const match = NAME_PATTERN.exec(name);
	if (!match) {
		return [name];
	}
	const segments = Array.from(match[2].matchAll(/\[([^\]]*)\]/g), segment => segment[1]);
	return [match[1], ...segments];
}

// PHP numbers an empty [] segment after the highest integer key already in the array.
function nextIndex(array: PhpArray): string {
	let next = 0;
	for (const key of Object.keys(array)) {
		if (/^(?:0|-?[1-9]\d*)$/.test(key) && Number(key) >= next) {
			next = Number(key) + 1;
		}
	}
	return String(next);
}

/** The key a name segment writes to, remembered in posted order. */
function useKey(node: PhpArray, segment: string): string {
	const key = segment === '' ? nextIndex(node) : segment;
	if (!Object.hasOwn(node, key)) {
		node[ORDER] = [...(node[ORDER] ?? []), key];
	}
	return key;
}

function assign(root: PhpArray, path: string[], value: string): void {
	let node = root;
	for (const segment of path.slice(0, -1)) {
		const key = useKey(node, segment);
		const child = node[key];
		if (typeof child === 'object') {
			node = child;
		} else {
			const created: PhpArray = {};
			node[key] = created;
			node = created;
		}
	}
	node[useKey(node, path.at(-1) as string)] = value;
}

/** Rebuilds $_POST / $_GET / $_REQUEST with nested arrays from the flat request parameters. */
export function nestedParams(params: RequestParams): PhpArray {
	const result: PhpArray = {};
	for (const [name, value] of Object.entries(params)) {
		const path = splitName(name);
		if (Array.isArray(value)) {
			// paramsFrom() already stripped the trailing [] of these names.
			for (const item of value) {
				assign(result, [...path, ''], item);
			}
		} else {
			assign(result, path, value);
		}
	}
	return result;
}

/** Reads $array[$a][$b]... and returns undefined when a step is missing or not an array. */
export function phpGet(value: PhpValue | undefined, ...path: (string | number)[]): PhpValue | undefined {
	let node = value;
	for (const key of path) {
		if (node === undefined || typeof node === 'string') {
			return undefined;
		}
		node = node[String(key)];
	}
	return node;
}

/** The value as an array, or undefined for a scalar or a missing value. */
export function phpArray(value: PhpValue | undefined): PhpArray | undefined {
	if (value !== undefined && typeof value === 'object') {
		return value;
	}
	return undefined;
}

/** The value as a string, or undefined for an array or a missing value. */
export function phpScalar(value: PhpValue | undefined): string | undefined {
	if (typeof value === 'string') {
		return value;
	}
	return undefined;
}

/** PHP's empty() for request values. */
export function phpEmpty(value: PhpValue | undefined | null): boolean {
	if (value === undefined || value === null) {
		return true;
	}
	if (typeof value === 'string') {
		return value === '' || value === '0';
	}
	return Object.keys(value).length === 0;
}

/** The keys of a request array in PHP order: posted order first, then keys added in code. */
export function phpKeys(array: PhpArray): string[] {
	const ordered = (array[ORDER] ?? []).filter(key => Object.hasOwn(array, key));
	const seen = new Set(ordered);
	return [...ordered, ...Object.keys(array).filter(key => !seen.has(key))];
}

/** foreach ($array as $key => $value) over a request array. */
export function phpEntries(array: PhpArray): [string, PhpValue][] {
	return phpKeys(array).map(key => [key, array[key]]);
}

/** array_values() of a request array. */
export function phpValues(array: PhpArray): PhpValue[] {
	return phpKeys(array).map(key => array[key]);
}

/** PHP's urldecode() byte by byte: bad % sequences stay as they are, and decoded bytes become one char each. */
function urldecodeBytes(value: string): string {
	return value.replaceAll('+', ' ').replaceAll(/%([\da-f]{2})/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)));
}

function beforeQuery(value: string): string {
	const index = value.indexOf('?');
	if (index === -1) {
		return value;
	}
	return value.slice(0, index);
}

/** Core::checkPageValidity() with the default allow list, as Common::run() applies it to goto. */
export function isValidGoto(page: unknown): page is string {
	if (typeof page !== 'string' || page === '' || page === '0') {
		return false;
	}
	return beforeQuery(page) === 'index.php' || beforeQuery(urldecodeBytes(page)) === 'index.php';
}

/** How json_encode() prints a PHP array of [key, value] pairs: a list when its keys are 0..n-1, else an object. */
export function phpJsonValue<T>(entries: [string, T][]): T[] | Record<string, T> {
	if (entries.every(([key], index) => key === String(index))) {
		return entries.map(([, item]) => item);
	}
	return Object.fromEntries(entries);
}

/** A request array for templates: a list when its keys are 0..n-1, else a Map with integer-like keys as numbers, as Twig compares them. */
export function phpToTwig(value: PhpValue): unknown {
	if (typeof value === 'string') {
		return value;
	}
	const entries = phpEntries(value);
	if (entries.every(([key], index) => key === String(index))) {
		return entries.map(([, item]) => phpToTwig(item));
	}
	return new Map(entries.map(([key, item]) => [/^(?:0|-?[1-9]\d*)$/.test(key) ? Number(key) : key, phpToTwig(item)]));
}

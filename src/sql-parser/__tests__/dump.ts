// A canonical JSON form of parser objects, shared with scripts/sql-parser/dump.php so PHP and TypeScript results compare directly.
//  - class instances become {"@c": ShortClassName, ...public properties}
//  - PHP associative arrays (Map / plain objects here) become {"@a": [[key, value], ...]} unless they are lists
import { LexerException, ParserException } from '../exceptions.ts';
import { Lexer } from '../Lexer.ts';

export type Dumped = null | boolean | number | string | Dumped[] | { [key: string]: Dumped; };

// Properties upstream's CustomJsonSerializer skips, plus private TypeScript helpers.
const SKIPPED = new Set(['KEYWORD_NAME_INDICATORS', 'OPERATOR_NAME_INDICATORS', 'delimiterUnits']);

/** A PHP array: a list when its keys are 0..n-1 in order, like json_encode() decides. */
function normalizePairs(entries: [string, Dumped][]): Dumped {
	if (entries.every(([key], index) => key === String(index))) {
		return entries.map(([, value]) => value);
	}
	return { '@a': entries };
}

/** JSON.parse() that keeps the order of integer keys by prefixing them with "#". */
export function parseOrderedJson(text: string): unknown {
	return JSON.parse(text.replaceAll(/([,{]\s*)"(\d+)":/g, (_match, prefix: string, key: string) => `${prefix}"#${key}":`));
}

export function dump(value: unknown): Dumped {
	if (value === null || value === undefined) {
		return null;
	}
	if (typeof value === 'boolean' || typeof value === 'string') {
		return value;
	}
	if (typeof value === 'number') {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(item => dump(item));
	}
	if (value instanceof Map) {
		return normalizePairs([...value].map(([key, item]) => [String(key), dump(item)]));
	}
	if (value instanceof LexerException) {
		return {
			'@c': 'LexerException',
			'message': value.message,
			'code': value.code,
			'ch': value.ch,
			'pos': value.pos,
		};
	}
	if (value instanceof ParserException) {
		return {
			'@c': 'ParserException',
			'message': value.message,
			'code': value.code,
			'token': dump(value.token),
		};
	}
	if (typeof value === 'object') {
		const proto = Object.getPrototypeOf(value);
		if (proto === Object.prototype || proto === null) {
			return normalizePairs(Object.entries(value).map(([key, item]) => [key, dump(item)]));
		}
		const result: Record<string, Dumped> = { '@c': value.constructor.name };
		for (const [key, item] of Object.entries(value)) {
			if (SKIPPED.has(key) || typeof item === 'function') {
				continue;
			}
			if (value instanceof Lexer && key === 'str') {
				result[key] = Array.isArray(item) ? item.join('') : dump(item);
				continue;
			}
			result[key] = dump(item);
		}
		return result;
	}
	return String(value);
}

/** Converts upstream's Zumba JSON (with "@type" and "@N" object references) to the canonical form. */
export function fromZumba(root: unknown): Dumped {
	const objects: unknown[] = [];

	// Objects are numbered in pre-order, which is the document order of the JSON.
	const collect = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const item of node) {
				collect(item);
			}
			return;
		}
		if (node === null || typeof node !== 'object') {
			return;
		}
		const record = node as Record<string, unknown>;
		const type = record['@type'];
		if (typeof type === 'string' && !type.startsWith('@')) {
			objects.push(record);
		}
		for (const [key, item] of Object.entries(record)) {
			if (key !== '@type') {
				collect(item);
			}
		}
	};
	collect(root);

	const convert = (node: unknown): Dumped => {
		if (Array.isArray(node)) {
			return node.map(item => convert(item));
		}
		if (node === null || typeof node !== 'object') {
			return node as Dumped;
		}
		let record = node as Record<string, unknown>;
		let type = record['@type'];
		if (typeof type === 'string' && type.startsWith('@')) {
			record = objects[Number(type.slice(1))] as Record<string, unknown>;
			type = record['@type'];
		}
		if (typeof type !== 'string') {
			// An associative array; integer keys were prefixed with "#" to keep their order through JSON.parse().
			return normalizePairs(Object.entries(record).map(([key, item]) => [key.startsWith('#') ? key.slice(1) : key, convert(item)]));
		}
		const shortName = type.slice(type.lastIndexOf('\\') + 1);
		if (shortName === 'UtfString') {
			return record.str as string;
		}
		const result: Record<string, Dumped> = { '@c': shortName };
		for (const [key, item] of Object.entries(record)) {
			// ROUTINE_OPTIONS is a static property missing from upstream's CustomJsonSerializer::SKIP_PROPERTIES.
			if (key === '@type' || key === 'ROUTINE_OPTIONS' || ((shortName === 'ParserException' || shortName === 'LexerException') && (key === 'file' || key === 'line'))) {
				continue;
			}
			result[key.startsWith('#') ? key.slice(1) : key] = convert(item);
		}
		return result;
	};

	return convert(root);
}

/** The fixture root: {query, lexer, parser, errors: {lexer, parser}} as plain objects. */
export interface UpstreamFixture {
	query: string;
	lexer: Dumped;
	parser: Dumped;
	errors: { lexer: Dumped; parser: Dumped; };
}

export function readUpstreamFixture(serialized: string): UpstreamFixture {
	const pairs = (value: Dumped): Record<string, Dumped> => Object.fromEntries((value as { '@a': [string, Dumped][]; })['@a']);
	const root = pairs(fromZumba(parseOrderedJson(serialized)));
	const errors = pairs(root.errors);
	return {
		query: root.query as string,
		lexer: root.lexer,
		parser: root.parser,
		errors: { lexer: errors.lexer, parser: errors.parser },
	};
}

/** Describes the first difference between two canonical values, or returns null when they are equal. */
export function firstDifference(expected: Dumped, actual: Dumped, path = '$'): string | null {
	if (typeof expected === 'number' && typeof actual === 'number') {
		return Object.is(expected, actual) || expected === actual ? null : `${path}: expected ${expected}, got ${actual}`;
	}
	if (expected === null || actual === null || typeof expected !== 'object' || typeof actual !== 'object') {
		return expected === actual ? null : `${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
	}
	if (Array.isArray(expected) || Array.isArray(actual)) {
		if (!Array.isArray(expected) || !Array.isArray(actual)) {
			return `${path}: expected ${JSON.stringify(expected).slice(0, 200)}, got ${JSON.stringify(actual).slice(0, 200)}`;
		}
		if (expected.length !== actual.length) {
			return `${path}: expected ${expected.length} items, got ${actual.length}: ${JSON.stringify(actual).slice(0, 300)}`;
		}
		for (const [index, item] of expected.entries()) {
			const difference = firstDifference(item, actual[index], `${path}[${index}]`);
			if (difference !== null) {
				return difference;
			}
		}
		return null;
	}
	const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
	for (const key of keys) {
		if (!(key in expected)) {
			return `${path}.${key}: unexpected ${JSON.stringify(actual[key]).slice(0, 200)}`;
		}
		if (!(key in actual)) {
			return `${path}.${key}: missing ${JSON.stringify(expected[key]).slice(0, 200)}`;
		}
		const difference = firstDifference(expected[key], actual[key], `${path}.${key}`);
		if (difference !== null) {
			return difference;
		}
	}
	return null;
}

// Port of PhpMyAdmin\SqlParser\Context: the loaded keyword set, SQL mode and character classification helpers.
import { CONTEXT_KEYWORDS } from './contexts/index.ts';
import { LoaderException } from './exceptions.ts';
import {
	isNumeric,
	phpEmpty,
	phpToInt,
	strtoupper,
} from './php.ts';
import { Token } from './Token.ts';

const CONTEXT_PREFIX = String.raw`\PhpMyAdmin\SqlParser\Contexts\Context`;

// Decoded keyword tables, shared by every load of the same context.
const decoded = new Map<string, Record<string, number>>();

function keywordsOf(name: string): Record<string, number> {
	const cached = decoded.get(name);
	if (cached) {
		return cached;
	}
	const keywords: Record<string, number> = Object.create(null);
	for (const [flags, list] of Object.entries(CONTEXT_KEYWORDS[name])) {
		for (const keyword of list.split(',')) {
			keywords[keyword] = Number(flags);
		}
	}
	decoded.set(name, keywords);
	return keywords;
}

/** The short context name (e.g. "MySql80400") for a class name as PHP would resolve it, or null when it does not exist. */
function resolveContext(className: string): string | null {
	if (!className.startsWith(CONTEXT_PREFIX)) {
		return null;
	}
	// The autoloader maps class names to files on a case-sensitive filesystem, so the case must match.
	const short = className.slice(CONTEXT_PREFIX.length);
	return Object.hasOwn(CONTEXT_KEYWORDS, short) ? short : null;
}

/** substr() with PHP's handling of out of range offsets. */
function substrLikePhp(value: string, start: number, length?: number): string {
	const from = start < 0 ? Math.max(value.length + start, 0) : start;
	if (from > value.length) {
		return '';
	}
	if (length === undefined) {
		return value.slice(from);
	}
	const to = (length < 0 ? value.length : from) + length;
	return to <= from ? '' : value.slice(from, to);
}

const WHITESPACE = new Set([' ', '\r', '\n', '\t']);

const MODES: Record<string, number> = {
	ALLOW_INVALID_DATES: 1,
	ANSI_QUOTES: 2,
	COMPAT_MYSQL: 2,
	ERROR_FOR_DIVISION_BY_ZERO: 4,
	HIGH_NOT_PRECEDENCE: 8,
	IGNORE_SPACE: 16,
	NO_AUTO_CREATE_USER: 32,
	NO_AUTO_VALUE_ON_ZERO: 64,
	NO_BACKSLASH_ESCAPES: 128,
	NO_DIR_IN_CREATE: 256,
	NO_ENGINE_SUBSTITUTION: 512,
	NO_FIELD_OPTIONS: 1024,
	NO_KEY_OPTIONS: 2048,
	NO_TABLE_OPTIONS: 4096,
	NO_UNSIGNED_SUBTRACTION: 8192,
	NO_ZERO_DATE: 16384,
	NO_ZERO_IN_DATE: 32768,
	ONLY_FULL_GROUP_BY: 65536,
	PIPES_AS_CONCAT: 131072,
	REAL_AS_FLOAT: 262144,
	STRICT_ALL_TABLES: 524288,
	STRICT_TRANS_TABLES: 1_048_576,
	NO_ENCLOSING_QUOTES: 1_073_741_824,
	ANSI: 393234,
	DB2: 138258,
	MAXDB: 138290,
	MSSQL: 138258,
	ORACLE: 138290,
	POSTGRESQL: 138258,
	TRADITIONAL: 1_622_052,
};

// The static state mirrors PHP's static properties; Workers handle a request synchronously so it never interleaves.
export class Context {
	static readonly KEYWORD_MAX_LENGTH = 30;
	static readonly LABEL_MAX_LENGTH = 16;
	static readonly OPERATOR_MAX_LENGTH = 4;

	static defaultContext = String.raw`\PhpMyAdmin\SqlParser\Contexts\ContextMySql50700`;
	static loadedContext = String.raw`\PhpMyAdmin\SqlParser\Contexts\ContextMySql50700`;
	static contextPrefix = CONTEXT_PREFIX;

	static KEYWORDS: Record<string, number> = keywordsOf('MySql50700');

	static readonly OPERATORS: Record<string, number> = Object.assign(Object.create(null) as Record<string, number>, {
		'%': 1,
		'*': 1,
		'+': 1,
		'-': 1,
		'/': 1,
		'!': 2,
		'!=': 2,
		'&&': 2,
		'<': 2,
		'<=': 2,
		'<=>': 2,
		'<>': 2,
		'=': 2,
		'>': 2,
		'>=': 2,
		'||': 2,
		'&': 4,
		'<<': 4,
		'>>': 4,
		'^': 4,
		'|': 4,
		'~': 4,
		':=': 8,
		'(': 16,
		')': 16,
		'.': 16,
		',': 16,
		';': 16,
	});

	static MODE = 0;

	static readonly SQL_MODE_NONE = 0;
	static readonly SQL_MODE_ALLOW_INVALID_DATES = 1;
	static readonly SQL_MODE_ANSI_QUOTES = 2;
	static readonly SQL_MODE_COMPAT_MYSQL = 2;
	static readonly SQL_MODE_ERROR_FOR_DIVISION_BY_ZERO = 4;
	static readonly SQL_MODE_HIGH_NOT_PRECEDENCE = 8;
	static readonly SQL_MODE_IGNORE_SPACE = 16;
	static readonly SQL_MODE_NO_AUTO_CREATE_USER = 32;
	static readonly SQL_MODE_NO_AUTO_VALUE_ON_ZERO = 64;
	static readonly SQL_MODE_NO_BACKSLASH_ESCAPES = 128;
	static readonly SQL_MODE_NO_DIR_IN_CREATE = 256;
	static readonly SQL_MODE_NO_ENGINE_SUBSTITUTION = 512;
	static readonly SQL_MODE_NO_FIELD_OPTIONS = 1024;
	static readonly SQL_MODE_NO_KEY_OPTIONS = 2048;
	static readonly SQL_MODE_NO_TABLE_OPTIONS = 4096;
	static readonly SQL_MODE_NO_UNSIGNED_SUBTRACTION = 8192;
	static readonly SQL_MODE_NO_ZERO_DATE = 16384;
	static readonly SQL_MODE_NO_ZERO_IN_DATE = 32768;
	static readonly SQL_MODE_ONLY_FULL_GROUP_BY = 65536;
	static readonly SQL_MODE_PIPES_AS_CONCAT = 131072;
	static readonly SQL_MODE_REAL_AS_FLOAT = 262144;
	static readonly SQL_MODE_STRICT_ALL_TABLES = 524288;
	static readonly SQL_MODE_STRICT_TRANS_TABLES = 1_048_576;
	static readonly SQL_MODE_NO_ENCLOSING_QUOTES = 1_073_741_824;
	static readonly SQL_MODE_ANSI = 393234;
	static readonly SQL_MODE_DB2 = 138258;
	static readonly SQL_MODE_MAXDB = 138290;
	static readonly SQL_MODE_MSSQL = 138258;
	static readonly SQL_MODE_ORACLE = 138290;
	static readonly SQL_MODE_POSTGRESQL = 138258;
	static readonly SQL_MODE_TRADITIONAL = 1_622_052;

	/** The keyword flags, or null; with $isReserved only reserved keywords count. */
	static isKeyword(str: string, isReserved = false): number | null {
		const upper = strtoupper(str);
		const flags = this.KEYWORDS[upper];
		if (flags === undefined || !Object.hasOwn(this.KEYWORDS, upper)) {
			return null;
		}
		if (isReserved && !(flags & Token.FLAG_KEYWORD_RESERVED)) {
			return null;
		}
		return flags;
	}

	static isOperator(str: string): number | null {
		return Object.hasOwn(this.OPERATORS, str) ? this.OPERATORS[str] : null;
	}

	static isWhitespace(str: string | undefined): boolean {
		return str !== undefined && WHITESPACE.has(str);
	}

	static isComment(str: string, end = false): number | null {
		const len = str.length;
		if (len === 0) {
			return null;
		}
		if (str[0] === '#') {
			return Token.FLAG_COMMENT_BASH;
		}
		// An opening C comment could also be a MySQL command (/*!).
		if (len > 1 && str[0] === '/' && str[1] === '*') {
			return len > 2 && str[2] === '!' ? Token.FLAG_COMMENT_MYSQL_CMD : Token.FLAG_COMMENT_C;
		}
		if (len > 1 && str[0] === '*' && str[1] === '/') {
			return Token.FLAG_COMMENT_C;
		}
		if (len > 2 && str[0] === '-' && str[1] === '-' && this.isWhitespace(str[2])) {
			return Token.FLAG_COMMENT_SQL;
		}
		if (len === 2 && end && str[0] === '-' && str[1] === '-') {
			return Token.FLAG_COMMENT_SQL;
		}
		return null;
	}

	static isBool(str: string): boolean {
		const upper = strtoupper(str);
		return upper === 'TRUE' || upper === 'FALSE';
	}

	static isNumber(str: string): boolean {
		return (str >= '0' && str <= '9') || str === '.' || str === '-' || str === '+' || str === 'e' || str === 'E';
	}

	static isSymbol(str: string): number | null {
		if (str.length === 0) {
			return null;
		}
		if (str[0] === '@') {
			return Token.FLAG_SYMBOL_VARIABLE;
		}
		if (str[0] === '`') {
			return Token.FLAG_SYMBOL_BACKTICK;
		}
		if (str[0] === ':' || str[0] === '?') {
			return Token.FLAG_SYMBOL_PARAMETER;
		}
		return null;
	}

	static isString(str: string): number | null {
		if (str.length === 0) {
			return null;
		}
		if (str[0] === '\'') {
			return Token.FLAG_STRING_SINGLE_QUOTES;
		}
		if (str[0] === '"') {
			return Token.FLAG_STRING_DOUBLE_QUOTES;
		}
		return null;
	}

	/** Only non alphanumeric ASCII characters may be separators; `~` is the last printable one. */
	static isSeparator(str: string): boolean {
		return str <= '~'
			&& str !== '_'
			&& str !== '$'
			&& (str < '0' || str > '9')
			&& (str < 'a' || str > 'z')
			&& (str < 'A' || str > 'Z');
	}

	/** Loads a context by short name ("MySql80400"), class name or the default when empty. */
	static load(context = ''): void {
		let className = context;
		if (phpEmpty(className)) {
			className = this.defaultContext;
		}
		if (!className.startsWith('\\')) {
			// A fully qualified class name may be given without its leading backslash.
			className = resolveContext(`\\${className}`) === null ? this.contextPrefix + className : `\\${className}`;
		}
		const name = resolveContext(className);
		if (name === null) {
			throw new LoaderException(`Specified context ("${className}") does not exist.`, className);
		}
		this.loadedContext = className;
		this.KEYWORDS = keywordsOf(name);
	}

	/** Loads the context, or the closest older one of the same engine; returns the loaded name or null. */
	static loadClosest(context = ''): string | null {
		let current = context;
		const length = current.length;
		for (let index = length; index > 0;) {
			try {
				this.load(current);
				return current;
			} catch (error) {
				if (!(error instanceof LoaderException)) {
					throw error;
				}
				// Replace the last two non zero digits by zeroes.
				let part: string;
				let exhausted = false;
				do {
					index -= 2;
					part = substrLikePhp(current, index, 2);
					if (!isNumeric(part)) {
						exhausted = true;
						break;
					}
				} while (phpToInt(part) === 0 && index > 0);
				if (exhausted) {
					break;
				}
				current = substrLikePhp(current, 0, index) + '00' + substrLikePhp(current, index + 2);
			}
		}
		if (current.startsWith('MariaDb')) {
			return this.loadClosest('MariaDb100300');
		}
		if (current.startsWith('MySql')) {
			return this.loadClosest('MySql50700');
		}
		return null;
	}

	static getMode(): number {
		return this.MODE;
	}

	/** Sets the SQL mode from flags or from a comma separated @@sql_mode value. */
	static setMode(mode: number | string = this.SQL_MODE_NONE): void {
		if (typeof mode === 'number') {
			this.MODE = mode;
			return;
		}
		this.MODE = this.SQL_MODE_NONE;
		if (mode === '') {
			return;
		}
		for (const sqlMode of mode.split(',')) {
			this.MODE |= Object.hasOwn(MODES, sqlMode) ? MODES[sqlMode] : 0;
		}
	}

	/** Quotes an identifier (or each identifier of an array) for the current SQL mode. */
	static escape(str: string, quote?: string): string;
	static escape(str: unknown[], quote?: string): string[];
	static escape(str: unknown, quote?: string): string;
	static escape(str: unknown, quote = '`'): string | string[] {
		if (Array.isArray(str)) {
			// PHP does not pass the quote down to the elements.
			return str.map(value => this.escape(value));
		}
		if (typeof str !== 'string') {
			// With strict_types, str_replace() and strtoupper() reject anything but strings.
			throw new TypeError('Context::escape() expects a string');
		}
		const text = str;
		if ((this.MODE & this.SQL_MODE_NO_ENCLOSING_QUOTES) && !this.isKeyword(text, true)) {
			return text;
		}
		let enclosing = quote;
		if (this.MODE & this.SQL_MODE_ANSI_QUOTES) {
			enclosing = '"';
		}
		return enclosing + text.replaceAll(enclosing, () => enclosing + enclosing) + enclosing;
	}

	static getIdentifierQuote(): string {
		return this.hasMode(this.SQL_MODE_ANSI_QUOTES) ? '"' : '`';
	}

	static hasMode(flag: number | null = null): boolean {
		if (!flag) {
			return false;
		}
		return (this.MODE & flag) === flag;
	}
}

// Port of PhpMyAdmin\SqlParser\Token: the lexer's unit, carrying the raw text and the value it represents.
import {
	hexdec,
	mbStrlen,
	mbSubstr,
	phpToFloat,
	phpToInt,
	stripcslashes,
	strtoupper,
} from './php.ts';

export type TokenValue = string | number | boolean | null;

// PHP_INT_MAX as the nearest double, which is what a PHP integer that large becomes in JavaScript.
const PHP_INT_MAX = 2 ** 63;

export class Token {
	static readonly TYPE_NONE = 0;

	static readonly TYPE_KEYWORD = 1;

	static readonly TYPE_OPERATOR = 2;

	static readonly TYPE_WHITESPACE = 3;

	static readonly TYPE_COMMENT = 4;

	static readonly TYPE_BOOL = 5;

	static readonly TYPE_NUMBER = 6;

	static readonly TYPE_STRING = 7;

	static readonly TYPE_SYMBOL = 8;

	static readonly TYPE_DELIMITER = 9;

	static readonly TYPE_LABEL = 10;

	static readonly TYPE_ALL = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

	static readonly FLAG_KEYWORD = 1;

	static readonly FLAG_KEYWORD_RESERVED = 2;

	static readonly FLAG_KEYWORD_COMPOSED = 4;

	static readonly FLAG_KEYWORD_DATA_TYPE = 8;

	static readonly FLAG_KEYWORD_KEY = 16;

	static readonly FLAG_KEYWORD_FUNCTION = 32;

	static readonly FLAG_NUMBER_HEX = 1;

	static readonly FLAG_NUMBER_FLOAT = 2;

	static readonly FLAG_NUMBER_APPROXIMATE = 4;

	static readonly FLAG_NUMBER_NEGATIVE = 8;

	static readonly FLAG_NUMBER_BINARY = 16;

	static readonly FLAG_STRING_SINGLE_QUOTES = 1;

	static readonly FLAG_STRING_DOUBLE_QUOTES = 2;

	static readonly FLAG_COMMENT_BASH = 1;

	static readonly FLAG_COMMENT_C = 2;

	static readonly FLAG_COMMENT_SQL = 4;

	static readonly FLAG_COMMENT_MYSQL_CMD = 8;

	static readonly FLAG_OPERATOR_ARITHMETIC = 1;

	static readonly FLAG_OPERATOR_LOGICAL = 2;

	static readonly FLAG_OPERATOR_BITWISE = 4;

	static readonly FLAG_OPERATOR_ASSIGNMENT = 8;

	static readonly FLAG_OPERATOR_SQL = 16;

	static readonly FLAG_SYMBOL_VARIABLE = 1;

	static readonly FLAG_SYMBOL_BACKTICK = 2;

	static readonly FLAG_SYMBOL_USER = 4;

	static readonly FLAG_SYMBOL_SYSTEM = 8;

	static readonly FLAG_SYMBOL_PARAMETER = 16;

	/** is_int($token->value): PHP keeps integers and floats apart, JavaScript does not. */
	static isIntValue(token: Token): boolean {
		if (typeof token.value !== 'number' || token.type !== this.TYPE_NUMBER) {
			return false;
		}
		if (token.flags & (this.FLAG_NUMBER_FLOAT | this.FLAG_NUMBER_APPROXIMATE)) {
			return false;
		}
		// hexdec() switches to a float once the value does not fit an integer.
		return !(token.flags & this.FLAG_NUMBER_HEX) || Math.abs(token.value) < PHP_INT_MAX;
	}

	private static extractNumber(token: string, flags: number): string | number {
		if (flags & this.FLAG_NUMBER_HEX) {
			const digits = token.replaceAll(/[-+]/g, '');
			if (flags & this.FLAG_NUMBER_NEGATIVE) {
				return -hexdec(digits);
			}
			return hexdec(digits);
		}
		// "---42" is -42.
		const value = token.replaceAll('--', '');
		if (flags & (this.FLAG_NUMBER_APPROXIMATE | this.FLAG_NUMBER_FLOAT)) {
			return phpToFloat(value);
		}
		if (!(flags & this.FLAG_NUMBER_BINARY)) {
			// (int) saturates numeric strings that do not fit 64 bits.
			return Math.min(Math.max(phpToInt(value), -PHP_INT_MAX), PHP_INT_MAX);
		}
		return value;
	}

	/** The raw text; null only for the delimiter the lexer appends at the end. */
	token: string | null;

	value: TokenValue;

	keyword: string | null;

	type: number;

	flags: number;

	position: number | null = null;

	constructor(token: string | null, type = 0, flags = 0) {
		this.token = token;
		this.type = type;
		this.flags = flags;
		this.keyword = null;
		this.value = this.extract();
	}

	/** Computes the value the token represents (unquoted strings, numbers, uppercase reserved keywords...). */
	extract(): TokenValue {
		const token = this.token ?? '';
		switch (this.type) {
			case Token.TYPE_KEYWORD: {
				this.keyword = strtoupper(token);
				// Unreserved keywords keep their case because they might be field names.
				if (!(this.flags & Token.FLAG_KEYWORD_RESERVED)) {
					return this.token;
				}
				return this.keyword;
			}
			case Token.TYPE_WHITESPACE: {
				return ' ';
			}
			case Token.TYPE_BOOL: {
				return strtoupper(token) === 'TRUE';
			}
			case Token.TYPE_NUMBER: {
				return Token.extractNumber(token, this.flags);
			}
			case Token.TYPE_STRING: {
				const quote = token[0] ?? '';
				let value = mbSubstr(token, 1, -1);
				value = value.replaceAll(quote + quote, () => quote);
				// MySQL has no representation for \f and \v, so they stay plain letters.
				value = value.replaceAll(String.raw`\f`, 'f').replaceAll(String.raw`\v`, 'v');
				return stripcslashes(value);
			}
			case Token.TYPE_SYMBOL: {
				let value = token;
				if (value[0] === '@') {
					value = mbSubstr(value, value[1] === '@' ? 2 : 1, mbStrlen(value));
				}
				if (value[0] === ':') {
					value = mbSubstr(value, 1, mbStrlen(value));
				}
				const quote = value[0] ?? '';
				if (['`', '"', '\''].includes(quote)) {
					value = mbSubstr(value, 1, -1).replaceAll(quote + quote, () => quote);
				}
				return value;
			}
			default: {
				return this.token;
			}
		}
	}

	/** The token text with new lines and tabs escaped, for single line output. */
	getInlineToken(): string {
		return (this.token ?? '').replaceAll('\r', String.raw`\r`).replaceAll('\n', String.raw`\n`).replaceAll('\t', String.raw`\t`);
	}
}

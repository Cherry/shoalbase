// Port of PhpMyAdmin\SqlParser\Lexer: splits a query into tokens, character by character.
import { Context } from './Context.ts';
import { Core } from './Core.ts';
import { LexerException } from './exceptions.ts';
import { Token } from './Token.ts';
import { TokensList } from './TokensList.ts';
import { Translator } from './Translator.ts';
import { sprintf } from '../lib/pma/sprintf.ts';

/** The query as PHP indexes it: by code point (UtfString) when it has multibyte characters. */
type LexerInput = string | string[];

const DEFAULT_DELIMITER = ';';

const isDigit = (character: string): boolean => character >= '0' && character <= '9';

const isLetter = (character: string): boolean => (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z');

// Not a single character, so it never equals a character of the query.
const BYTE_MARKER = 'byte';

/** The delimiter split in bytes like PHP indexes strings; bytes of multibyte characters get a marker no character equals. */
function byteUnits(value: string): string[] {
	const units: string[] = [];
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x80) {
			units.push(character);
			continue;
		}
		let bytes = 4;
		if (code < 0x8_00) {
			bytes = 2;
		} else if (code < 0x1_00_00) {
			bytes = 3;
		}
		for (let index = 0; index < bytes; index++) {
			units.push(BYTE_MARKER);
		}
	}
	return units;
}

function valueString(value: Token['value']): string {
	if (value === true) {
		return '1';
	}
	if (value === null || value === false) {
		return '';
	}
	return String(value);
}

export class Lexer extends Core<LexerException> {
	static readonly PARSER_METHODS = [
		'parseDelimiter',
		'parseWhitespace',
		'parseNumber',
		'parseComment',
		'parseOperator',
		'parseBool',
		'parseString',
		'parseSymbol',
		'parseKeyword',
		'parseLabel',
		'parseUnknown',
	] as const;

	static DEFAULT_DELIMITER = DEFAULT_DELIMITER;

	static getTokens(str: string, strict = false, delimiter: string | null = null): TokensList {
		return new Lexer(str, strict, delimiter).list;
	}

	// The delimiter as PHP indexes it: one entry per byte, where a byte of a multibyte character never equals a character.
	private delimiterUnits: string[] = [];

	KEYWORD_NAME_INDICATORS = ['FROM', 'SET', 'WHERE'];

	OPERATOR_NAME_INDICATORS = [',', '.'];

	str: LexerInput = '';

	len = 0;

	last = 0;

	list: TokensList = new TokensList();

	delimiter: string | null = null;

	delimiterLen = 0;

	constructor(str: string, strict = false, delimiter: string | null = null) {
		super();
		// Astral characters take two UTF-16 units, so such queries are indexed by code point like UtfString does.
		this.str = /[\uD800-\uDFFF]/.test(str) ? [...str] : str;
		this.len = this.str.length;
		this.strict = strict;
		this.setDelimiter(delimiter !== null && delimiter !== '' && delimiter !== '0' ? delimiter : Lexer.DEFAULT_DELIMITER);
		this.lex();
	}

	/** The character at $index, or '' past the end like PHP's string offsets. */
	private at(index: number): string {
		return this.str[index] ?? '';
	}

	/** A `*` followed by FROM, USING, `,` or `)` is a wildcard, not a multiplication. */
	private solveAmbiguityOnStarOperator(): void {
		const iBak = this.list.idx;
		let starToken: Token | null;
		while ((starToken = this.list.getNextOfTypeAndValue(Token.TYPE_OPERATOR, '*')) !== null) {
			const next = this.list.getNext();
			if (next === null) {
				continue;
			}
			if (
				(next.type !== Token.TYPE_KEYWORD || !['FROM', 'USING'].includes(next.value as string))
				&& (next.type !== Token.TYPE_OPERATOR || ![',', ')'].includes(next.value as string))
			) {
				continue;
			}
			starToken.flags = Token.FLAG_OPERATOR_SQL;
		}
		this.list.idx = iBak;
	}

	/** Function keywords used as names (followed by FROM, SET, WHERE, `,` or `.`) are plain identifiers. */
	private solveAmbiguityOnFunctionKeywords(): void {
		const iBak = this.list.idx;
		const keywordFunction = Token.TYPE_KEYWORD | Token.FLAG_KEYWORD_FUNCTION;
		let keywordToken: Token | null;
		while ((keywordToken = this.list.getNextOfTypeAndFlag(Token.TYPE_KEYWORD, keywordFunction)) !== null) {
			const next = this.list.getNext();
			if (
				(next?.type !== Token.TYPE_KEYWORD || !this.KEYWORD_NAME_INDICATORS.includes(next.value as string))
				&& (next?.type !== Token.TYPE_OPERATOR || !this.OPERATOR_NAME_INDICATORS.includes(next.value as string))
				&& (next?.value ?? null) !== null
			) {
				continue;
			}
			keywordToken.type = Token.TYPE_NONE;
			keywordToken.flags = Token.TYPE_NONE;
			keywordToken.keyword = keywordToken.value as string | null;
		}
		this.list.idx = iBak;
	}

	setDelimiter(delimiter: string): void {
		this.delimiter = delimiter;
		this.delimiterUnits = byteUnits(delimiter);
		this.delimiterLen = this.delimiterUnits.length;
	}

	lex(): void {
		const list = new TokensList();
		let lastToken: Token | null = null;
		let lastIdx: number;
		for (this.last = 0, lastIdx = 0; this.last < this.len; lastIdx = ++this.last) {
			let token = this.parseDelimiter()
				?? this.parseWhitespace()
				?? this.parseNumber()
				?? this.parseComment()
				?? this.parseOperator()
				?? this.parseBool()
				?? this.parseString()
				?? this.parseSymbol()
				?? this.parseKeyword()
				?? this.parseLabel()
				?? this.parseUnknown();

			if (token === null) {
				token = new Token(this.at(this.last));
				this.error('Unexpected character.', this.at(this.last), this.last);
			} else if (
				lastToken !== null
				&& token.type === Token.TYPE_SYMBOL
				&& (token.flags & Token.FLAG_SYMBOL_VARIABLE)
				&& (lastToken.type === Token.TYPE_STRING
					|| (lastToken.type === Token.TYPE_SYMBOL && (lastToken.flags & Token.FLAG_SYMBOL_BACKTICK)))
			) {
				// Handles ```... FROM 'user'@'%' ...```.
				lastToken.token = (lastToken.token ?? '') + (token.token ?? '');
				lastToken.type = Token.TYPE_SYMBOL;
				lastToken.flags = Token.FLAG_SYMBOL_USER;
				lastToken.value = `${valueString(lastToken.value)}@${valueString(token.value)}`;
				continue;
			} else if (
				lastToken !== null
				&& token.type === Token.TYPE_KEYWORD
				&& lastToken.type === Token.TYPE_OPERATOR
				&& lastToken.value === '.'
			) {
				// Handles ```... tbl.FROM ...```, where FROM is not a reserved word.
				token.type = Token.TYPE_NONE;
				token.flags = 0;
				token.value = token.token;
			}

			token.position = lastIdx;
			list.tokens[list.count++] = token;

			if (token.type === Token.TYPE_NONE && token.value === 'DELIMITER') {
				if (this.last + 1 >= this.len) {
					this.error('Expected whitespace(s) before delimiter.', '', this.last + 1);
					continue;
				}

				// Skipping the last R (from `delimiteR`) and the whitespaces before the actual delimiter.
				let pos = ++this.last;
				const whitespace = this.parseWhitespace();
				if (whitespace !== null) {
					whitespace.position = pos;
					list.tokens[list.count++] = whitespace;
				}

				if (this.last + 1 >= this.len) {
					this.error('Expected delimiter.', '', this.last + 1);
					continue;
				}

				pos = this.last + 1;

				let delimiter = '';
				let delimiterLen = 0;
				while (++this.last < this.len && !Context.isWhitespace(this.at(this.last)) && delimiterLen < 15) {
					delimiter += this.at(this.last);
					++delimiterLen;
				}
				this.delimiter = delimiter;

				if (delimiter === '' || delimiter === '0') {
					this.error('Expected delimiter.', '', this.last);
					this.delimiter = ';';
				}

				--this.last;

				this.delimiterUnits = byteUnits(this.delimiter);
				this.delimiterLen = this.delimiterUnits.length;
				token = new Token(this.delimiter, Token.TYPE_DELIMITER);
				token.position = pos;
				list.tokens[list.count++] = token;
			}

			lastToken = token;
		}

		// A final delimiter marks the end.
		list.tokens[list.count++] = new Token(null, Token.TYPE_DELIMITER);

		this.list = list;

		this.solveAmbiguityOnStarOperator();
		this.solveAmbiguityOnFunctionKeywords();
	}

	error(msg: string, str = '', pos = 0, code = 0): void {
		this.addError(new LexerException(Translator.gettext(msg), str, pos, code));
	}

	parseKeyword(): Token | null {
		let token = '';
		let ret: Token | null = null;
		let iEnd = this.last;
		let lastSpace = false;

		for (let size = 1; size < Context.KEYWORD_MAX_LENGTH && this.last < this.len; ++size, ++this.last) {
			// Composed keywords shouldn't have more than one whitespace between keywords.
			if (Context.isWhitespace(this.at(this.last))) {
				if (lastSpace) {
					--size;
					continue;
				}
				lastSpace = true;
			} else {
				lastSpace = false;
			}

			token += this.at(this.last);
			const flags = Context.isKeyword(token);

			if ((this.last + 1 !== this.len && !Context.isSeparator(this.at(this.last + 1))) || !flags) {
				continue;
			}

			// No break, so the longest keyword wins (`OR` versus `ORDER`).
			ret = new Token(token, Token.TYPE_KEYWORD, flags);
			iEnd = this.last;
		}

		this.last = iEnd;
		return ret;
	}

	parseLabel(): Token | null {
		let token = '';
		let ret: Token | null = null;
		let iEnd = this.last;
		for (let size = 1; size < Context.LABEL_MAX_LENGTH && this.last < this.len; ++size, ++this.last) {
			const character = this.at(this.last);
			if (character === ':' && size > 1) {
				token += character;
				ret = new Token(token, Token.TYPE_LABEL);
				iEnd = this.last;
				break;
			}
			if (Context.isWhitespace(character) && size > 1) {
				// Whitespace between the label and the colon does not count.
				--size;
			} else if (Context.isSeparator(character)) {
				break;
			}
			token += character;
		}
		this.last = iEnd;
		return ret;
	}

	parseOperator(): Token | null {
		let token = '';
		let ret: Token | null = null;
		let iEnd = this.last;
		for (let size = 1; size < Context.OPERATOR_MAX_LENGTH && this.last < this.len; ++size, ++this.last) {
			token += this.at(this.last);
			const flags = Context.isOperator(token);
			if (!flags) {
				continue;
			}
			ret = new Token(token, Token.TYPE_OPERATOR, flags);
			iEnd = this.last;
		}
		this.last = iEnd;
		return ret;
	}

	parseWhitespace(): Token | null {
		let token = this.at(this.last);
		if (!Context.isWhitespace(token)) {
			return null;
		}
		while (++this.last < this.len && Context.isWhitespace(this.at(this.last))) {
			token += this.at(this.last);
		}
		--this.last;
		return new Token(token, Token.TYPE_WHITESPACE);
	}

	parseComment(): Token | null {
		const iBak = this.last;
		let token = this.at(this.last);

		// Bash style comments (#comment\n).
		if (Context.isComment(token)) {
			while (++this.last < this.len && this.at(this.last) !== '\n') {
				token += this.at(this.last);
			}
			// The trailing \n becomes a whitespace token.
			if (this.last < this.len) {
				--this.last;
			}
			return new Token(token, Token.TYPE_COMMENT, Token.FLAG_COMMENT_BASH);
		}

		// C style comments (/*comment*\/).
		if (++this.last < this.len) {
			token += this.at(this.last);
			if (Context.isComment(token)) {
				// In "*/*" the first star is an operator ("SELECT */* comment */ FROM ...").
				const next = this.last + 1;
				if (next < this.len && this.at(next) === '*' && token === '*/') {
					this.last = iBak;
					return null;
				}

				let flags = Token.FLAG_COMMENT_C;

				// This comment already ended; it may close a MySQL specific command.
				if (token === '*/') {
					return new Token(token, Token.TYPE_COMMENT, flags);
				}

				// MySQL specific commands are split and only their beginning is a comment.
				if (this.last + 1 < this.len && this.at(this.last + 1) === '!') {
					flags |= Token.FLAG_COMMENT_MYSQL_CMD;
					token += this.at(++this.last);
					while (++this.last < this.len && this.at(this.last) >= '0' && this.at(this.last) <= '9') {
						token += this.at(this.last);
					}
					--this.last;
					return new Token(token, Token.TYPE_COMMENT, flags);
				}

				while (++this.last < this.len && (this.at(this.last - 1) !== '*' || this.at(this.last) !== '/')) {
					token += this.at(this.last);
				}

				if (this.last < this.len) {
					token += this.at(this.last);
				}
				return new Token(token, Token.TYPE_COMMENT, flags);
			}
		}

		// SQL style comments (-- comment\n).
		let end: boolean;
		if (++this.last < this.len) {
			token += this.at(this.last);
			end = false;
		} else {
			--this.last;
			end = true;
		}
		if (Context.isComment(token, end)) {
			// Unless the comment already ended (```--\n```).
			if (this.at(this.last) !== '\n') {
				while (++this.last < this.len && this.at(this.last) !== '\n') {
					token += this.at(this.last);
				}
			}
			if (this.last < this.len) {
				--this.last;
			}
			return new Token(token, Token.TYPE_COMMENT, Token.FLAG_COMMENT_SQL);
		}

		this.last = iBak;
		return null;
	}

	parseBool(): Token | null {
		// At least strlen('TRUE') characters are required.
		if (this.last + 3 >= this.len) {
			return null;
		}
		const iBak = this.last;
		let token = this.at(this.last) + this.at(++this.last) + this.at(++this.last) + this.at(++this.last);

		if (Context.isBool(token)) {
			return new Token(token, Token.TYPE_BOOL);
		}

		if (++this.last < this.len) {
			token += this.at(this.last);
			if (Context.isBool(token)) {
				return new Token(token, Token.TYPE_BOOL, 1);
			}
		}

		this.last = iBak;
		return null;
	}

	/** A state machine over the notations of numbers; valid final states are 2, 3, 4, 6 and 9. */
	parseNumber(): Token | null {
		const iBak = this.last;
		let token = '';
		let flags = 0;
		let state = 1;
		for (; this.last < this.len; ++this.last) {
			const character = this.at(this.last);
			if (state === 1) {
				if (character === '-') {
					flags |= Token.FLAG_NUMBER_NEGATIVE;
				} else if (this.last + 1 < this.len && character === '0' && this.at(this.last + 1) === 'x') {
					token += this.at(this.last++);
					state = 2;
				} else if (character >= '0' && character <= '9') {
					state = 3;
				} else if (character === '.') {
					state = 10;
				} else if (character === 'b') {
					state = 7;
				} else if (character !== '+') {
					// `+` is a valid character in a number.
					break;
				}
			} else if (state === 2) {
				flags |= Token.FLAG_NUMBER_HEX;
				if (!(isDigit(character) || (character >= 'A' && character <= 'F') || (character >= 'a' && character <= 'f'))) {
					break;
				}
			} else if (state === 3) {
				if (character === '.') {
					state = 4;
				} else if (character === 'e' || character === 'E') {
					state = 5;
				} else if (isLetter(character)) {
					// A number can't be directly followed by a letter.
					state = -state;
					break;
				} else if (character < '0' || character > '9') {
					break;
				}
			} else if (state === 4) {
				flags |= Token.FLAG_NUMBER_FLOAT;
				if (character === 'e' || character === 'E') {
					state = 5;
				} else if (isLetter(character)) {
					state = -state;
					break;
				} else if (character < '0' || character > '9') {
					break;
				}
			} else if (state === 5) {
				flags |= Token.FLAG_NUMBER_APPROXIMATE;
				if (character === '+' || character === '-' || isDigit(character)) {
					state = 6;
				} else if (isLetter(character)) {
					state = -state;
					break;
				} else {
					break;
				}
			} else if (state === 6) {
				if (character < '0' || character > '9') {
					break;
				}
			} else if (state === 7) {
				flags |= Token.FLAG_NUMBER_BINARY;
				if (character !== '\'') {
					break;
				}
				state = 8;
			} else if (state === 8) {
				if (character === '\'') {
					state = 9;
				} else if (character !== '0' && character !== '1') {
					break;
				}
			} else if (state === 9) {
				break;
			} else if (state === 10) {
				flags |= Token.FLAG_NUMBER_FLOAT;
				if (character < '0' || character > '9') {
					break;
				}
				state = 4;
			}
			token += this.at(this.last);
		}

		if (state === 2 || state === 3 || (token !== '.' && state === 4) || state === 6 || state === 9) {
			--this.last;
			return new Token(token, Token.TYPE_NUMBER, flags);
		}

		this.last = iBak;
		return null;
	}

	parseString(quote = ''): Token | null {
		let token = this.at(this.last);
		const flags = Context.isString(token);

		if (!flags && token !== quote) {
			return null;
		}

		const opening = token;

		while (++this.last < this.len) {
			if (
				this.last + 1 < this.len
				&& ((this.at(this.last) === opening && this.at(this.last + 1) === opening)
					|| (this.at(this.last) === '\\' && opening !== '`'))
			) {
				token += this.at(this.last) + this.at(++this.last);
			} else {
				if (this.at(this.last) === opening) {
					break;
				}
				token += this.at(this.last);
			}
		}

		if (this.last >= this.len || this.at(this.last) !== opening) {
			this.error(sprintf(Translator.gettext('Ending quote %1$s was expected.'), opening), '', this.last);
		} else {
			token += this.at(this.last);
		}

		return new Token(token, Token.TYPE_STRING, flags ?? 0);
	}

	parseSymbol(): Token | null {
		let token = this.at(this.last);
		let flags = Context.isSymbol(token);

		if (!flags) {
			return null;
		}

		if (flags & Token.FLAG_SYMBOL_VARIABLE) {
			if (this.last + 1 < this.len && this.at(++this.last) === '@') {
				// A system variable (e.g. `@@hostname`).
				token += this.at(this.last++);
				flags |= Token.FLAG_SYMBOL_SYSTEM;
			}
		} else if (flags & Token.FLAG_SYMBOL_PARAMETER) {
			if (token !== '?' && this.last + 1 < this.len) {
				++this.last;
			}
		} else {
			token = '';
		}

		let str: Token | null = null;

		if (this.last < this.len) {
			str = this.parseString('`');
			if (str === null) {
				str = this.parseUnknown();
				if (str === null && !(flags & Token.FLAG_SYMBOL_PARAMETER)) {
					this.error('Variable name was expected.', this.at(this.last), this.last);
				}
			}
		}

		if (str !== null) {
			token += str.token ?? '';
		}

		return new Token(token, Token.TYPE_SYMBOL, flags);
	}

	parseUnknown(): Token | null {
		let token = this.at(this.last);
		if (Context.isSeparator(token)) {
			return null;
		}

		const delimiter = this.delimiter ?? '';
		while (++this.last < this.len && !Context.isSeparator(this.at(this.last))) {
			token += this.at(this.last);

			// A token ending with the current delimiter loses it.
			if (token.endsWith(delimiter)) {
				token = token.slice(0, token.length - delimiter.length);
				// PHP moves back by the byte length of the delimiter.
				this.last -= this.delimiterLen - 1;
				break;
			}
		}

		--this.last;
		return new Token(token);
	}

	parseDelimiter(): Token | null {
		const delimiter = this.delimiter ?? '';
		let idx = 0;
		while (idx < this.delimiterLen && this.last + idx < this.len) {
			if (this.delimiterUnits[idx] !== this.at(this.last + idx)) {
				return null;
			}
			++idx;
		}
		this.last += this.delimiterLen - 1;
		return new Token(delimiter, Token.TYPE_DELIMITER);
	}
}

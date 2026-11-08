// Port of PhpMyAdmin\SqlParser\Utils\BufferedQuery: splits a growing buffer into statements, as the SQL import does.
import { Context } from '../Context.ts';
import { phpEmpty, phpTrim, strtoupper } from '../php.ts';

export interface BufferedQueryOptions {
	delimiter: string;
	parse_delimiter: boolean;
	add_delimiter: boolean;
}


export class BufferedQuery {
	static readonly STATUS_STRING = 16;

	static readonly STATUS_STRING_SINGLE_QUOTES = 17;

	static readonly STATUS_STRING_DOUBLE_QUOTES = 18;

	static readonly STATUS_STRING_BACKTICK = 20;

	static readonly STATUS_COMMENT = 32;

	static readonly STATUS_COMMENT_BASH = 33;

	static readonly STATUS_COMMENT_C = 34;

	static readonly STATUS_COMMENT_SQL = 36;

	// A function-level static in PHP; kept per instance so an aborted import cannot leak into the next request of the isolate.
	private position = 0;

	query = '';

	options: BufferedQueryOptions;

	delimiter = '';

	delimiterLen = 0;

	status: number | null = null;

	current = '';

	constructor(query = '', options: Partial<BufferedQueryOptions> = {}) {
		this.options = {
			delimiter: ';',
			parse_delimiter: false,
			add_delimiter: false,
			...options,
		};
		this.query = query;
		this.setDelimiter(this.options.delimiter);
	}

	/** The character at $index; a negative index counts from the end like PHP string offsets. */
	private at(index: number): string {
		if (index < 0) {
			return this.query[this.query.length + index] ?? '';
		}
		return this.query[index] ?? '';
	}

	/** Handles a DELIMITER statement at $start; returns null when it is incomplete and more data is needed. */
	private extractDelimiter(start: number, len: number, end: boolean): string | null {
		// Skipping DELIMITER and the whitespaces after it.
		let i = start + 9;
		while (i < len && Context.isWhitespace(this.at(i))) {
			++i;
		}

		let delimiter = '';
		while (i < len && !Context.isWhitespace(this.at(i))) {
			delimiter += this.at(i++);
		}

		if (delimiter !== '' && ((i < len && Context.isWhitespace(this.at(i))) || (i === len && end))) {
			this.setDelimiter(delimiter);

			// The DELIMITER statement is returned only when requested.
			let ret = '';
			if (!phpEmpty(this.options.parse_delimiter)) {
				ret = phpTrim(`${this.current} ${this.query.slice(start, i)}`);
			}

			// Removing the statement that was just extracted from the query.
			this.query = this.query.slice(i);
			this.position = 0;

			this.current = '';

			return ret;
		}

		// Incomplete statement: the position stays on DELIMITER.
		this.position = start;
		return null;
	}

	setDelimiter(delimiter: string): void {
		this.delimiter = delimiter;
		this.delimiterLen = delimiter.length;
	}

	/**
	 * The next complete statement, '' when more data is needed (or a DELIMITER statement was consumed),
	 * or false when the buffer is empty. With $end, the rest of the buffer is the last statement.
	 */
	extract(end = false): string | false {
		if (phpEmpty(this.query)) {
			return false;
		}

		const len = this.query.length;
		// The last 16 characters may be the beginning of a delimiter or a comment, so they wait for more data.
		const loopLen = end ? len : len - 16;

		for (; this.position < loopLen; ++this.position) {
			const i = this.position;
			const character = this.at(i);

			// A backslash escapes the next character, whatever it is.
			if (((this.status ?? 0) & BufferedQuery.STATUS_COMMENT) === 0 && character === '\\') {
				this.current += character + (i + 1 < len ? this.at(++this.position) : '');
				continue;
			}

			if (this.status === BufferedQuery.STATUS_STRING_SINGLE_QUOTES) {
				if (character === '\'') {
					this.status = 0;
				}
				this.current += character;
				continue;
			}
			if (this.status === BufferedQuery.STATUS_STRING_DOUBLE_QUOTES) {
				if (character === '"') {
					this.status = 0;
				}
				this.current += character;
				continue;
			}
			if (this.status === BufferedQuery.STATUS_STRING_BACKTICK) {
				if (character === '`') {
					this.status = 0;
				}
				this.current += character;
				continue;
			}
			if (this.status === BufferedQuery.STATUS_COMMENT_BASH || this.status === BufferedQuery.STATUS_COMMENT_SQL) {
				// Bash (#) and SQL (-- ) comments end with the line.
				if (character === '\n') {
					this.status = 0;
				}
				this.current += character;
				continue;
			}
			if (this.status === BufferedQuery.STATUS_COMMENT_C) {
				if (this.at(i - 1) === '*' && character === '/') {
					this.status = 0;
				}
				this.current += character;
				continue;
			}

			// Strings.
			if (character === '\'') {
				this.status = BufferedQuery.STATUS_STRING_SINGLE_QUOTES;
				this.current += character;
				continue;
			}

			if (character === '"') {
				this.status = BufferedQuery.STATUS_STRING_DOUBLE_QUOTES;
				this.current += character;
				continue;
			}

			if (character === '`') {
				this.status = BufferedQuery.STATUS_STRING_BACKTICK;
				this.current += character;
				continue;
			}

			// Comments.
			if (character === '#') {
				this.status = BufferedQuery.STATUS_COMMENT_BASH;
				this.current += character;
				continue;
			}

			if (i + 2 < len) {
				if (character === '-' && this.at(i + 1) === '-' && Context.isWhitespace(this.at(i + 2))) {
					this.status = BufferedQuery.STATUS_COMMENT_SQL;
					this.current += character;
					continue;
				}

				if (character === '/' && this.at(i + 1) === '*' && this.at(i + 2) !== '!') {
					this.status = BufferedQuery.STATUS_COMMENT_C;
					this.current += character;
					continue;
				}
			}

			// DELIMITER is only special at the beginning of a statement and is not a keyword.
			if (i + 9 < len && strtoupper(this.query.slice(i, i + 9)) === 'DELIMITER' && Context.isWhitespace(this.at(i + 9))) {
				return this.extractDelimiter(i, len, end) ?? false;
			}

			// A statement ended; the first character of the delimiter is checked first as an optimization.
			if (
				character === this.delimiter[0]
				&& (this.delimiterLen === 1 || this.query.slice(i, i + this.delimiterLen) === this.delimiter)
			) {
				let ret = this.current;

				if (!phpEmpty(this.options.add_delimiter)) {
					ret += this.delimiter;
				}

				// Removing the statement that was just extracted from the query.
				this.query = this.query.slice(i + this.delimiterLen);
				this.position = 0;

				this.current = '';

				return phpTrim(ret);
			}

			this.current += character;
		}

		if (end && this.position === len) {
			// The end of the buffer: the statement extracted so far is returned and the buffer emptied.
			const ret = this.current;

			this.query = '';
			this.position = 0;

			this.current = '';

			return phpTrim(ret);
		}

		return '';
	}
}

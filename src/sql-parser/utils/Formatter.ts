// Port of PhpMyAdmin\SqlParser\Utils\Formatter: re-indents a query as text, CLI colors or HTML highlighting.
import { JoinKeyword } from '../components/JoinKeyword.ts';
import { Lexer } from '../Lexer.ts';
import { KEYWORD_PARSERS, STATEMENT_PARSERS } from '../parser-data.ts';
import {
	htmlspecialcharsNoQuotes,
	isset,
	mbStrlen,
	phpEmpty,
	phpStr,
	strtolower,
	strtoupper,
} from '../php.ts';
import { Token } from '../Token.ts';

import type { TokensList } from '../TokensList.ts';

export type FormatFunction = ((text: string) => string) | 'strtoupper' | 'strtolower' | '';

export interface Format {
	type: number;
	flags: number;
	html: string;
	cli: string;
	function: FormatFunction;
}

export interface FormatterOptions {
	type: 'text' | 'cli' | 'html' | string;
	line_ending: string | null;
	indentation: string | null;
	remove_comments: boolean;
	clause_newline: boolean;
	parts_newline: boolean;
	indent_parts: boolean;
	formats: Format[];
}

export type FormatterInput = Partial<Omit<FormatterOptions, 'formats'>> & { formats?: Partial<Format>[]; };

const TRANSFORMS: Record<string, (text: string) => string> = { strtoupper, strtolower };

// The CLI color of the previous token; a function-level static in PHP, so it is shared by every formatter.
let previousCliColor: string | undefined;

/** Control characters become \xHH so they cannot alter the terminal. */
function escapeConsole(text: string): string {
	let escaped = '';
	for (const character of text) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20) {
			escaped += String.raw`\x` + code.toString(16).toUpperCase().padStart(2, '0');
		} else {
			escaped += character;
		}
	}
	return escaped;
}

export class Formatter {
	static SHORT_CLAUSES: Record<string, boolean> = {
		CREATE: true,
		INSERT: true,
	};

	static INLINE_CLAUSES: Record<string, boolean> = {
		'CREATE': true,
		'INTO': true,
		'LIMIT': true,
		'PARTITION BY': true,
		'PARTITION': true,
		'PROCEDURE': true,
		'SUBPARTITION BY': true,
		'VALUES': true,
	};

	static format(query: string, options: FormatterInput = {}): string {
		const lexer = new Lexer(query);
		const formatter = new Formatter(options);
		return formatter.formatList(lexer.list);
	}

	/** The length of the fragment up to the closing bracket. */
	static getGroupLength(list: TokensList): number {
		let count = 1;
		let length = 0;
		for (let idx = list.idx; idx < list.count; ++idx) {
			const token = list.tokens[idx];
			if (token.type === Token.TYPE_OPERATOR) {
				if (token.value === '(') {
					++count;
				} else if (token.value === ')') {
					--count;
					if (count === 0) {
						break;
					}
				}
			}

			length += mbStrlen(phpStr(token.value));
		}

		return length;
	}

	/** 2 for a statement keyword (or DELIMITER), 1 for a clause keyword, false otherwise. */
	static isClause(token: Token): 1 | 2 | false {
		if (
			(token.type === Token.TYPE_KEYWORD && isset(STATEMENT_PARSERS, token.keyword))
			|| (token.type === Token.TYPE_NONE && strtoupper(token.token ?? '') === 'DELIMITER')
		) {
			return 2;
		}

		if (token.type === Token.TYPE_KEYWORD && isset(KEYWORD_PARSERS, token.keyword)) {
			return 1;
		}

		return false;
	}

	/** Formats with the same type and flags replace the defaults; the others are appended. */
	private static mergeFormats(formats: Format[], newFormats: Partial<Format>[]): Format[] {
		const added: number[] = [];
		const sanitized: Format[] = newFormats.map((format) => {
			return {
				type: format.type ?? 0,
				flags: format.flags ?? 0,
				html: format.html ?? '',
				cli: format.cli ?? '',
				function: format.function ?? '',
			};
		});
		const merged = [...formats];

		for (const [index, original] of merged.entries()) {
			for (const [newIndex, format] of sanitized.entries()) {
				if (format.type !== original.type || original.flags !== format.flags) {
					continue;
				}
				merged[index] = format;
				added.push(newIndex);
			}
		}

		for (const [newIndex, format] of sanitized.entries()) {
			if (added.includes(newIndex)) {
				continue;
			}
			merged.push(format);
		}

		return merged;
	}

	options: FormatterOptions;

	constructor(options: FormatterInput = {}) {
		this.options = this.getMergedOptions(options);
	}

	protected getMergedOptions(input: FormatterInput): FormatterOptions {
		const { formats, ...rest } = input;
		const options = { ...this.getDefaultOptions(), ...rest } as FormatterOptions;

		options.formats = formats === undefined ? this.getDefaultFormats() : Formatter.mergeFormats(this.getDefaultFormats(), formats);

		if (options.line_ending === null) {
			options.line_ending = options.type === 'html' ? '<br/>' : '\n';
		}

		if (options.indentation === null) {
			options.indentation = options.type === 'html' ? '&nbsp;&nbsp;&nbsp;&nbsp;' : ' '.repeat(4);
		}

		// parts_newline requires clause_newline.
		options.parts_newline = Boolean(options.parts_newline) && Boolean(options.clause_newline);

		return options;
	}

	protected getDefaultOptions(): Omit<FormatterOptions, 'formats'> {
		return {
			// PHP_SAPI is not "cli" for web requests.
			type: 'text',
			line_ending: null,
			indentation: null,
			remove_comments: false,
			clause_newline: true,
			parts_newline: true,
			indent_parts: true,
		};
	}

	protected getDefaultFormats(): Format[] {
		return [
			{
				type: Token.TYPE_KEYWORD,
				flags: Token.FLAG_KEYWORD_RESERVED,
				html: 'class="sql-reserved"',
				cli: '\u{1B}[35m',
				function: 'strtoupper',
			},
			{
				type: Token.TYPE_KEYWORD,
				flags: 0,
				html: 'class="sql-keyword"',
				cli: '\u{1B}[95m',
				function: 'strtoupper',
			},
			{
				type: Token.TYPE_COMMENT,
				flags: 0,
				html: 'class="sql-comment"',
				cli: '\u{1B}[37m',
				function: '',
			},
			{
				type: Token.TYPE_BOOL,
				flags: 0,
				html: 'class="sql-atom"',
				cli: '\u{1B}[36m',
				function: 'strtoupper',
			},
			{
				type: Token.TYPE_NUMBER,
				flags: 0,
				html: 'class="sql-number"',
				cli: '\u{1B}[92m',
				function: 'strtolower',
			},
			{
				type: Token.TYPE_STRING,
				flags: 0,
				html: 'class="sql-string"',
				cli: '\u{1B}[91m',
				function: '',
			},
			{
				type: Token.TYPE_SYMBOL,
				flags: Token.FLAG_SYMBOL_PARAMETER,
				html: 'class="sql-parameter"',
				cli: '\u{1B}[31m',
				function: '',
			},
			{
				type: Token.TYPE_SYMBOL,
				flags: 0,
				html: 'class="sql-variable"',
				cli: '\u{1B}[36m',
				function: '',
			},
		];
	}

	formatList(list: TokensList): string {
		const options = this.options;
		const lineEnding = options.line_ending ?? '';
		const indentation = options.indentation ?? '';

		let ret = '';
		// PHP's array_pop() on an empty array gives null, which is kept until the next increment.
		let indent: number | null = 0;
		let lineEnded = false;
		let shortGroup = false;
		let lastClause = '';
		const blocksIndentation: (number | null)[] = [];
		const blocksLineEndings: boolean[] = [];
		let formattedOptions = false;
		let prev: Token | null = null;

		// Two pointers: at every iteration the previous token is the one added.
		for (list.idx = 0; list.idx < list.count; ++list.idx) {
			const curr = list.tokens[list.idx];
			const next = list.idx + 1 < list.count ? list.tokens[list.idx + 1] : null;

			if (curr.type === Token.TYPE_WHITESPACE) {
				// Line breaks before and after comments are kept.
				if (
					(curr.token ?? '').includes('\n')
					&& ((prev !== null && prev.type === Token.TYPE_COMMENT) || (next !== null && next.type === Token.TYPE_COMMENT))
				) {
					lineEnded = true;
				}

				// The formatter adds its own whitespaces.
				continue;
			}

			if (curr.type === Token.TYPE_COMMENT && options.remove_comments) {
				continue;
			}

			if (prev !== null) {
				// A new clause started.
				if (Formatter.isClause(prev) !== false) {
					lastClause = phpStr(prev.value);
					formattedOptions = false;
				}

				// The options of a clause stay on the same line, and so does what follows.
				if (
					options.parts_newline
					&& !formattedOptions
					&& !isset(Formatter.INLINE_CLAUSES, lastClause)
					&& (curr.type !== Token.TYPE_KEYWORD || (curr.flags & Token.FLAG_KEYWORD_FUNCTION))
				) {
					formattedOptions = true;
					lineEnded = true;
					indent = (indent ?? 0) + 1;
				}

				// This clause ended.
				const isClause = Formatter.isClause(curr);
				if (
					isClause !== false
					&& (isClause === 2 || options.clause_newline)
					&& !isset(Formatter.SHORT_CLAUSES, lastClause)
				) {
					lineEnded = true;
					if (options.parts_newline && indent !== null && indent > 0) {
						--indent;
					}
				}

				// Inline JOINs.
				if (
					(prev.type === Token.TYPE_KEYWORD && isset(JoinKeyword.JOINS, prev.value))
					|| ((curr.value === 'ON' || curr.value === 'USING') && isset(JoinKeyword.JOINS, list.tokens[list.idx - 2]?.value))
					|| isset(JoinKeyword.JOINS, list.tokens[list.idx - 4]?.value)
					|| isset(JoinKeyword.JOINS, list.tokens[list.idx - 6]?.value)
				) {
					lineEnded = false;
				}

				// Indenting BEGIN ... END blocks.
				if (prev.type === Token.TYPE_KEYWORD && prev.keyword === 'BEGIN') {
					lineEnded = true;
					blocksIndentation.push(indent);
					indent = (indent ?? 0) + 1;
				} else if (curr.type === Token.TYPE_KEYWORD && curr.keyword === 'END') {
					lineEnded = true;
					indent = blocksIndentation.pop() ?? null;
				}

				// Fragments delimited by a comma are broken only if the clause is not inlined or the brackets are on new lines.
				if (
					prev.type === Token.TYPE_OPERATOR
					&& prev.value === ','
					&& (blocksLineEndings.at(-1) === true
						|| (!isset(Formatter.INLINE_CLAUSES, lastClause) && !shortGroup && options.parts_newline))
				) {
					lineEnded = true;
				}

				// Brackets are indented only if the fragment between them is longer than 30 characters.
				if (prev.type === Token.TYPE_OPERATOR && prev.value === '(') {
					blocksIndentation.push(indent);
					shortGroup = true;
					if (Formatter.getGroupLength(list) > 30) {
						indent = (indent ?? 0) + 1;
						lineEnded = true;
						shortGroup = false;
					}
					blocksLineEndings.push(lineEnded);
				} else if (curr.type === Token.TYPE_OPERATOR && curr.value === ')') {
					indent = blocksIndentation.pop() ?? null;
					// The pop must happen even when the line already ended, so no short-circuit here.
					const blockLineEnded = blocksLineEndings.pop() ?? false;
					lineEnded ||= blockLineEnded;
					shortGroup = false;
				}

				ret += this.toString(prev);

				if (lineEnded) {
					ret += lineEnding + indentation.repeat(Math.max(indent ?? 0, 0));
					lineEnded = false;
				} else if (
					// A space after delimiters longer than 2 characters.
					prev.keyword === 'DELIMITER'
					|| !(
						// No space after . and (.
						(prev.type === Token.TYPE_OPERATOR && (prev.value === '.' || prev.value === '('))
						// No space before . , ( and ).
						|| (curr.type === Token.TYPE_OPERATOR && ['.', ',', '(', ')'].includes(curr.value as string))
						|| (curr.type === Token.TYPE_DELIMITER && mbStrlen(phpStr(curr.value)) < 2)
					)
				) {
					ret += ' ';
				}
			}

			prev = curr;
		}

		if (options.type === 'cli') {
			return `${ret}\u{1B}[0m`;
		}

		return ret;
	}

	escapeConsole(string: string): string {
		return escapeConsole(string);
	}

	toString(token: Token): string {
		let text = token.token ?? '';

		for (const format of this.options.formats) {
			if (token.type !== format.type || (token.flags & format.flags) !== format.flags) {
				continue;
			}

			if (!phpEmpty(format.function)) {
				const transform = typeof format.function === 'function' ? format.function : TRANSFORMS[format.function];
				if (transform !== undefined) {
					text = transform(text);
				}
			}

			if (this.options.type === 'html') {
				return `<span ${format.html}>${htmlspecialcharsNoQuotes(text)}</span>`;
			}

			if (this.options.type === 'cli') {
				if (previousCliColor !== format.cli) {
					previousCliColor = format.cli;
					return format.cli + escapeConsole(text);
				}
				return escapeConsole(text);
			}

			break;
		}

		if (this.options.type === 'cli') {
			if (previousCliColor !== '\u{1B}[39m') {
				previousCliColor = '\u{1B}[39m';
				return `\u{1B}[39m${escapeConsole(text)}`;
			}
			return escapeConsole(text);
		}

		if (this.options.type === 'html') {
			return htmlspecialcharsNoQuotes(text);
		}

		return text;
	}
}

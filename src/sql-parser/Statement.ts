// Port of PhpMyAdmin\SqlParser\Statement: the generic clause-driven statement parser and builder.
import { componentClass } from './components/index.ts';
import { OptionsArray, type OptionsSpec } from './components/OptionsArray.ts';
import { KEYWORD_PARSERS, STATEMENT_PARSERS } from './parser-data.ts';
import {
	isset,
	lookup,
	phpEmpty,
	phpTrim,
	stripos,
} from './php.ts';
import { Token } from './Token.ts';

import type { Parser } from './Parser.ts';
import type { TokensList } from './TokensList.ts';

/** A clause: the keyword and its build flags (1 builds the field, 2 adds the keyword). */
export type Clause = readonly [string, number];
export type Clauses = Record<string, Clause>;

export interface StatementClass {
	OPTIONS: OptionsSpec;
	CLAUSES: Clauses;
	GROUP_OPTIONS: OptionsSpec;
	END_OPTIONS: OptionsSpec;
	new (parser?: Parser | null, list?: TokensList | null): Statement;
}

const UNION_KEYWORDS = new Set(['UNION', 'UNION ALL', 'UNION DISTINCT', 'EXCEPT', 'INTERSECT']);

/** array_flip() of a list: each value maps to its last index. */
function flip(values: string[]): Record<string, number> {
	const flipped: Record<string, number> = Object.create(null);
	for (const [index, value] of values.entries()) {
		flipped[value] = index;
	}
	return flipped;
}

/** Query::getClauseStartOffset(): the index of the token starting the clause, or -1. */
export function getClauseStartOffset(statement: Statement, list: TokensList, clause: string): number {
	let brackets = 0;
	const clauses = flip(Object.keys(statement.getClauses()));

	for (let i = statement.first ?? 0; i <= (statement.last ?? -1); ++i) {
		const token = list.tokens[i];
		if (token === undefined) {
			continue;
		}

		if (token.type === Token.TYPE_COMMENT) {
			continue;
		}

		if (token.type === Token.TYPE_OPERATOR) {
			if (token.value === '(') {
				++brackets;
			} else if (token.value === ')') {
				--brackets;
			}
		}

		if (brackets !== 0) {
			continue;
		}

		if (token.type === Token.TYPE_KEYWORD && isset(clauses, token.keyword) && clause === token.keyword) {
			return i;
		}

		if (token.keyword === 'UNION') {
			return -1;
		}
	}

	return -1;
}

export abstract class Statement {
	static OPTIONS: OptionsSpec = {};
	static CLAUSES: Clauses = {};
	static GROUP_OPTIONS: OptionsSpec = {};
	static END_OPTIONS: OptionsSpec = {};

	// Declared without initializers: subclasses parse from the base constructor, which runs before field initializers.
	declare options: OptionsArray | null;
	declare first: number | null;
	declare last: number | null;

	constructor(parser: Parser | null = null, list: TokensList | null = null) {
		this.options = null;
		this.first = null;
		this.last = null;
		this.initProperties();
		if (parser === null || list === null) {
			return;
		}
		this.parse(parser, list);
	}

	/** Sets the subclass property defaults; called before parse() so they are not overwritten afterwards. */
	protected initProperties(): void {
		// The base statement has no extra properties.
	}

	/** The class of this statement, for late static binding (static::$OPTIONS...). */
	protected statics(): StatementClass {
		return this.constructor as unknown as StatementClass;
	}

	/** `$this instanceof SelectStatement` without importing the subclass here. */
	isSelectStatement(): boolean {
		return false;
	}

	isSetStatement(): boolean {
		return false;
	}

	/** `$this->$field`. */
	getProperty(field: string): unknown {
		return (this as unknown as Record<string, unknown>)[field] ?? null;
	}

	setProperty(field: string, value: unknown): void {
		(this as unknown as Record<string, unknown>)[field] = value;
	}

	build(): string {
		let query = '';
		const built: Record<string, boolean> = {};

		for (const [name, type] of Object.values(this.getClauses())) {
			const info = lookup(KEYWORD_PARSERS, name);
			const className = info?.class;
			const field = info?.field;

			// The field is empty, there is nothing to be built.
			if (className === undefined || field === undefined || phpEmpty(this.getProperty(field))) {
				continue;
			}

			// Checking if this field was already built.
			if (type & 1) {
				if (built[field]) {
					continue;
				}
				built[field] = true;
			}

			// Checking if the name of the clause should be added.
			if (type & 2) {
				query = `${phpTrim(query)} ${name}`;
			}

			// Checking if the result of the builder should be added.
			if (!(type & 1)) {
				continue;
			}

			query = `${phpTrim(query)} ${componentClass(className).build(this.getProperty(field))}`;
		}

		return query;
	}

	parse(parser: Parser, list: TokensList): void {
		const statics = this.statics();
		const parsedClauses: Record<string, boolean> = {};

		// This may be corrected by the parser.
		this.first = list.idx;

		let parsedOptions = phpEmpty(statics.OPTIONS);

		for (; list.idx < list.count; ++list.idx) {
			const token = list.tokens[list.idx];

			if (token.type === Token.TYPE_DELIMITER) {
				break;
			}

			// A closing bracket that pairs with a bracket outside the statement.
			if (token.value === ')' && parser.brackets > 0) {
				--parser.brackets;
				continue;
			}

			// Only keywords are relevant here; the rest is processed by the components.
			if (token.type !== Token.TYPE_KEYWORD) {
				if (token.type !== Token.TYPE_COMMENT && token.type !== Token.TYPE_WHITESPACE) {
					parser.error('Unexpected token.', token);
				}
				continue;
			}

			// Unions are handled by the parser because they span several statements.
			if (UNION_KEYWORDS.has(token.keyword ?? '')) {
				break;
			}

			const lastIdx = list.idx;

			// ON DUPLICATE KEY UPDATE belongs to the parent INSERT or REPLACE.
			if (this.isSelectStatement() && token.value === 'ON') {
				++list.idx;
				const first = list.getNextOfType(Token.TYPE_KEYWORD);
				const second = list.getNextOfType(Token.TYPE_KEYWORD);
				const third = list.getNextOfType(Token.TYPE_KEYWORD);
				if (first && second && third && first.value === 'DUPLICATE' && second.value === 'KEY' && third.value === 'UPDATE') {
					list.idx = lastIdx;
					break;
				}
			}

			list.idx = lastIdx;

			let className: string | null = null;
			let field: string | null = null;
			let options: Record<string, unknown> = {};

			const value = typeof token.value === 'string' ? token.value : '';

			// Looking for duplicated clauses.
			if (!phpEmpty(lookup(KEYWORD_PARSERS, value)) || !phpEmpty(lookup(STATEMENT_PARSERS, value))) {
				if (parsedClauses[value]) {
					parser.error('This type of clause was previously parsed.', token);
					break;
				}
				parsedClauses[value] = true;
			}

			// TRUNCATE is not a reserved keyword, so its value keeps the original case.
			const tokenValue = token.keyword === 'TRUNCATE' ? token.keyword : value;
			const keywordParser = lookup(KEYWORD_PARSERS, tokenValue);
			if (keywordParser !== undefined && !phpEmpty(keywordParser) && list.idx < list.count) {
				className = keywordParser.class ?? null;
				field = keywordParser.field ?? null;
				if (!phpEmpty(keywordParser.options)) {
					options = keywordParser.options ?? {};
				}
			}

			if (!phpEmpty(lookup(STATEMENT_PARSERS, token.keyword))) {
				if (!phpEmpty(statics.CLAUSES) && phpEmpty(lookup(statics.CLAUSES, value))) {
					// A keyword like SET may start a statement or a clause; here it starts a new statement.
					parser.error('A new statement was found, but no delimiter between it and the previous one.', token);
					break;
				}

				if (!parsedOptions) {
					if (phpEmpty(lookup(statics.OPTIONS, value))) {
						// Skipping the keyword because it is not an option.
						++list.idx;
					}
					this.options = OptionsArray.parse(parser, list, statics.OPTIONS);
					parsedOptions = true;
				}
			} else if (className === null) {
				if (this.isSelectStatement() && token.value === 'WITH ROLLUP') {
					this.setProperty('group_options', OptionsArray.parse(parser, list, statics.GROUP_OPTIONS));
				} else if (
					(this.isSelectStatement() && ['FOR UPDATE', 'LOCK IN SHARE MODE'].includes(value))
					|| (this.isSetStatement() && ['COLLATE', 'DEFAULT'].includes(value))
				) {
					this.setProperty('end_options', OptionsArray.parse(parser, list, statics.END_OPTIONS));
				} else {
					// No parser for this keyword and it does not start a statement either.
					parser.error('Unrecognized keyword.', token);
					continue;
				}
			}

			this.before?.(parser, list, token);

			if (className !== null) {
				// A keyword cannot be parsed at the end of the statement.
				if (list.idx >= list.count) {
					parser.error('Keyword at end of statement.', token);
					continue;
				}

				// Skipping the keyword or the last option.
				++list.idx;
				this.setProperty(field ?? '', componentClass(className).parse(parser, list, options));
			}

			this.after?.(parser, list, token);
		}

		// Go back to the last used token; this may be corrected by the parser.
		this.last = --list.idx;
	}

	/** Called before the component of a clause keyword is parsed, for statements that look around it. */
	before?(parser: Parser, list: TokensList, token: Token): void;

	/** Called after the component of a clause keyword is parsed, for statements that parse more. */
	after?(parser: Parser, list: TokensList, token: Token): void;

	getClauses(): Clauses {
		return this.statics().CLAUSES;
	}

	/** The position of every clause, with _END_OPTIONS expanded to the end options. */
	getClauseOrder(): Record<string, number> {
		const clauses: string[] = [];
		for (const key of Object.keys(this.getClauses())) {
			if (key === '_END_OPTIONS') {
				clauses.push(...Object.keys(this.statics().END_OPTIONS));
			} else {
				clauses.push(key);
			}
		}
		return flip(clauses);
	}

	toString(): string {
		return this.build();
	}

	validateClauseOrder(parser: Parser, list: TokensList): boolean {
		const clauses = flip(Object.keys(this.getClauses()));

		if (phpEmpty(clauses)) {
			return true;
		}

		let minIdx = -1;
		let minJoin = 0;
		let maxJoin = 0;
		let error = 0;
		let lastIdx = 0;

		for (const clauseType of Object.keys(clauses)) {
			const clauseStartIdx = getClauseStartOffset(this, list, clauseType);

			if (
				clauseStartIdx !== -1
				&& this.isSelectStatement()
				&& ['FORCE', 'IGNORE', 'USE'].includes(clauseType)
			) {
				// Ordering the clauses of a SELECT statement with index hints is not supported.
				return true;
			}

			// stripos() returns 0 for "JOIN" itself, which PHP treats as false.
			const joinPosition = stripos(clauseType, 'JOIN');
			const isJoin = joinPosition !== false && joinPosition !== 0;

			// Handles the ordering of multiple joins.
			if (clauseStartIdx !== -1) {
				if (minJoin === 0 && isJoin) {
					// The first JOIN clause.
					minJoin = clauseStartIdx;
					maxJoin = clauseStartIdx;
				} else if (minJoin !== 0 && !isJoin) {
					// A non-JOIN clause after a JOIN clause.
					maxJoin = lastIdx;
				} else if (maxJoin < clauseStartIdx && isJoin) {
					error = 1;
				}
			}

			if (clauseStartIdx !== -1 && clauseStartIdx < minIdx) {
				if (minJoin === 0 || error === 1) {
					parser.error('Unexpected ordering of clauses.', list.tokens[clauseStartIdx] ?? null);
					return false;
				}
				minIdx = clauseStartIdx;
			} else if (clauseStartIdx !== -1) {
				minIdx = clauseStartIdx;
			}

			lastIdx = clauseStartIdx === -1 ? lastIdx : clauseStartIdx;
		}

		return true;
	}
}

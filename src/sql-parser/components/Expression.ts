// Port of PhpMyAdmin\SqlParser\Components\Expression: a column, table or arbitrary expression with an optional alias.
import { Component, type ComponentOptions } from '../Component.ts';
import { Context } from '../Context.ts';
import { STATEMENT_PARSERS } from '../parser-data.ts';
import {
	isset,
	phpEmpty,
	phpRtrim,
	phpStr,
	phpTrim,
	strtoupper,
} from '../php.ts';
import { Token, type TokenValue } from '../Token.ts';
import { CaseExpression } from './CaseExpression.ts';

import type { Parser } from '../Parser.ts';
import type { TokensList } from '../TokensList.ts';

const ALLOWED_KEYWORDS: Record<string, number> = {
	'AND': 1,
	'AS': 1,
	'BETWEEN': 1,
	'CASE': 1,
	'DUAL': 1,
	'DIV': 1,
	'IS': 1,
	'MOD': 1,
	'NOT': 1,
	'NOT NULL': 1,
	'NULL': 1,
	'OR': 1,
	'OVER': 1,
	'REGEXP': 1,
	'RLIKE': 1,
	'XOR': 1,
};

export interface ExpressionOptions extends ComponentOptions {
	parseField?: string;
	field?: string;
	breakOnAlias?: boolean;
	breakOnParentheses?: boolean;
	parenthesesDelimited?: boolean;
}

export class Expression extends Component {
	static parse(parser: Parser, list: TokensList, options: ExpressionOptions = {}): Expression | null {
		const ret = new this();
		const parseOptions: ExpressionOptions = { ...options };

		let isExpr = false;
		let dot = false;
		let alias = false;
		let brackets = 0;
		const prev: [Token | null, Token | null] = [null, null];

		// When a field is parsed, no parentheses are expected.
		if (!phpEmpty(parseOptions.parseField)) {
			parseOptions.breakOnParentheses = true;
			parseOptions.field = parseOptions.parseField;
		}

		for (; list.idx < list.count; ++list.idx) {
			const token = list.tokens[list.idx];

			if (token.type === Token.TYPE_DELIMITER) {
				break;
			}

			if (token.type === Token.TYPE_WHITESPACE || token.type === Token.TYPE_COMMENT) {
				// The closing C comment of a MySQL command is ignored.
				if (isExpr && token.token !== '*/') {
					ret.expr = `${ret.expr ?? ''}${token.token ?? ''}`;
				}
				continue;
			}

			if (token.type === Token.TYPE_KEYWORD) {
				if (brackets > 0 && phpEmpty(ret.subquery) && !phpEmpty(STATEMENT_PARSERS[token.keyword ?? ''])) {
					// A `(` followed by the beginning of a statement is a subquery.
					ret.subquery = token.keyword;
				} else if ((token.flags & Token.FLAG_KEYWORD_FUNCTION) && phpEmpty(parseOptions.parseField) && !alias) {
					isExpr = true;
				} else if ((token.flags & Token.FLAG_KEYWORD_RESERVED) && brackets === 0) {
					if (!isset(ALLOWED_KEYWORDS, token.keyword)) {
						// A reserved keyword that is not allowed means a new clause starts.
						break;
					}

					if (token.keyword === 'AS') {
						if (!phpEmpty(parseOptions.breakOnAlias)) {
							break;
						}

						if (alias) {
							parser.error('An alias was expected.', token);
							break;
						}

						alias = true;
						continue;
					}

					if (token.keyword === 'CASE') {
						// For a use of CASE like 'SELECT a = CASE .... END, b=1, `id`, ... FROM ...'.
						const tempCaseExpr = CaseExpression.parse(parser, list);
						ret.expr = `${ret.expr ?? ''}${CaseExpression.build(tempCaseExpr)}`;
						isExpr = true;
						continue;
					}

					isExpr = true;
				} else if (brackets === 0 && phpStr(ret.expr).length > 0 && !alias && (ret.table === null || ret.table === '')) {
					// End of expression.
					break;
				}
			}

			if (
				token.type === Token.TYPE_NUMBER
				|| token.type === Token.TYPE_BOOL
				|| (token.type === Token.TYPE_SYMBOL && (token.flags & Token.FLAG_SYMBOL_VARIABLE))
				|| (token.type === Token.TYPE_SYMBOL && (token.flags & Token.FLAG_SYMBOL_PARAMETER))
				|| (token.type === Token.TYPE_OPERATOR && token.value !== '.')
			) {
				if (!phpEmpty(parseOptions.parseField)) {
					break;
				}

				// Numbers, booleans and operators (except the dot) are usually part of expressions.
				isExpr = true;
			}

			if (token.type === Token.TYPE_OPERATOR) {
				if (!phpEmpty(parseOptions.breakOnParentheses) && (token.value === '(' || token.value === ')')) {
					break;
				}

				if (token.value === '(') {
					++brackets;
					if (
						phpEmpty(ret.function) && prev[1] !== null
						&& (prev[1].type === Token.TYPE_NONE
							|| prev[1].type === Token.TYPE_SYMBOL
							|| (prev[1].type === Token.TYPE_KEYWORD && (prev[1].flags & Token.FLAG_KEYWORD_FUNCTION)))
					) {
						ret.function = prev[1].value;
					}
				} else if (token.value === ')') {
					if (brackets === 0) {
						// Not our bracket.
						break;
					}

					--brackets;
					if (brackets === 0) {
						if (!phpEmpty(parseOptions.parenthesesDelimited)) {
							// The current token is the last bracket; the next one is outside the expression.
							ret.expr = `${ret.expr ?? ''}${token.token ?? ''}`;
							++list.idx;
							break;
						}
					} else if (brackets < 0) {
						break;
					}
				} else if (token.value === ',' && brackets === 0) {
					// Expressions are comma-delimited.
					break;
				}
			}

			prev[0] = prev[1];
			prev[1] = token;

			if (alias) {
				// An alias is expected after AS.
				if (!phpEmpty(ret.alias)) {
					parser.error('An alias was previously found.', token);
					break;
				}

				ret.alias = token.value;
				alias = false;
			} else if (isExpr) {
				const previous = prev[0];
				const current = token;
				if (
					brackets === 0
					&& (previous === null
						|| ((previous.type !== Token.TYPE_OPERATOR || previous.token === ')')
							&& (previous.type !== Token.TYPE_KEYWORD || !(previous.flags & Token.FLAG_KEYWORD_RESERVED))))
						&& (current.type === Token.TYPE_STRING
							|| (current.type === Token.TYPE_SYMBOL
								&& !(current.flags & Token.FLAG_SYMBOL_VARIABLE)
								&& !(current.flags & Token.FLAG_SYMBOL_PARAMETER))
							|| (current.type === Token.TYPE_NONE && strtoupper(current.token ?? '') !== 'OVER'))
				) {
					if (!phpEmpty(ret.alias)) {
						parser.error('An alias was previously found.', token);
						break;
					}

					ret.alias = current.value;
				} else {
					const currIdx = list.idx;
					--list.idx;
					const beforeToken = list.getPrevious();
					list.idx = currIdx;

					// Column names followed by keywords (column options) are separated by a space.
					if (
						ret.expr !== null
						&& beforeToken
						&& [Token.TYPE_NONE, Token.TYPE_SYMBOL, Token.TYPE_STRING].includes(beforeToken.type)
						&& token.type === Token.TYPE_KEYWORD
					) {
						ret.expr = `${phpRtrim(ret.expr, ' ')} `;
					}

					ret.expr = `${ret.expr ?? ''}${token.token ?? ''}`;
				}
			} else if (token.type === Token.TYPE_OPERATOR && token.value === '.') {
				// A dot means the name parsed so far was a table (or a database) name.
				if (!phpEmpty(ret.database) || dot) {
					parser.error('Unexpected dot.', token);
				}

				ret.database = ret.table;
				ret.table = ret.column;
				ret.column = null;
				dot = true;
				ret.expr = `${ret.expr ?? ''}${token.token ?? ''}`;
			} else {
				const field = phpEmpty(parseOptions.field) ? 'column' : phpStr(parseOptions.field);
				if (phpEmpty(ret.getField(field))) {
					ret.setField(field, token.value);
					ret.expr = `${ret.expr ?? ''}${token.token ?? ''}`;
					dot = false;
				} else {
					// No alias is expected.
					if (!phpEmpty(parseOptions.breakOnAlias)) {
						break;
					}

					if (!phpEmpty(ret.alias)) {
						parser.error('An alias was previously found.', token);
						break;
					}

					ret.alias = token.value;
				}
			}
		}

		if (alias) {
			parser.error('An alias was expected.', list.tokens[list.idx - 1] ?? null);
		}

		// Whitespaces might be added at the end.
		ret.expr = phpTrim(phpStr(ret.expr));

		if (ret.expr === '') {
			return null;
		}

		--list.idx;
		return ret;
	}

	static build(component: Expression | Expression[] | null): string {
		if (Array.isArray(component)) {
			return component.map(item => phpStr(item)).join(', ');
		}
		if (component === null) {
			return '';
		}

		let ret: string;
		if (component.expr !== '' && component.expr !== null) {
			ret = component.expr;
		} else {
			const fields: unknown[] = [];
			if (component.database !== null && component.database !== '') {
				fields.push(component.database);
			}
			if (component.table !== null && component.table !== '') {
				fields.push(component.table);
			}
			if (component.column !== null && component.column !== '') {
				fields.push(component.column);
			}
			ret = Context.escape(fields).join('.');
		}

		if (!phpEmpty(component.alias)) {
			ret += ` AS ${Context.escape(component.alias)}`;
		}

		return ret;
	}

	database: TokenValue = null;

	table: TokenValue = null;

	column: TokenValue = null;

	expr: string | null = '';

	alias: TokenValue = null;

	function: TokenValue = null;

	subquery: string | null = null;

	/** Either (expr, alias) or (database, table, column, alias), as in PHP. */
	constructor(database: TokenValue = null, table: TokenValue = null, column: TokenValue = null, alias: TokenValue = null) {
		super();
		if (column === null && alias === null) {
			this.expr = database as string | null;
			this.alias = table;
		} else {
			this.database = database;
			this.table = table;
			this.column = column;
			this.alias = alias;
		}
	}

	/** `$expression->$field`; LOAD DATA parses into a dynamic `file` property. */
	getField(field: string): TokenValue {
		return (Reflect.get(this, field) as TokenValue | undefined) ?? null;
	}

	setField(field: string, value: TokenValue): void {
		Reflect.set(this, field, value);
	}
}

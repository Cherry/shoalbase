// Port of PhpMyAdmin\SqlParser\Components\CaseExpression: CASE [value] WHEN ... THEN ... [ELSE ...] END [AS alias].
import { Component } from '../Component.ts';
import { Context } from '../Context.ts';
import { phpBool, phpEmpty, phpStr } from '../php.ts';
import { Token, type TokenValue } from '../Token.ts';
import { Condition } from './Condition.ts';
import { Expression } from './Expression.ts';

import type { Parser } from '../Parser.ts';
import type { TokensList } from '../TokensList.ts';

export class CaseExpression extends Component {
	static parse(parser: Parser, list: TokensList): CaseExpression {
		const ret = new this();

		let state = 0;
		let type = 0;

		// Skip 'CASE'.
		++list.idx;

		for (; list.idx < list.count; ++list.idx) {
			const token = list.tokens[list.idx];

			if (token.type === Token.TYPE_WHITESPACE || token.type === Token.TYPE_COMMENT) {
				continue;
			}

			if (state === 0) {
				if (token.type === Token.TYPE_KEYWORD) {
					if (token.keyword === 'WHEN') {
						++list.idx;
						ret.conditions.push(Condition.parse(parser, list));
						type = 1;
						state = 1;
					} else if (token.keyword === 'ELSE') {
						++list.idx;
						ret.else_result = Expression.parse(parser, list);
						// The last clause of the CASE expression.
						state = 0;
					} else if (token.keyword === 'END') {
						state = 3;
						++list.idx;
						break;
					} else {
						parser.error('Unexpected keyword.', token);
						break;
					}
				} else {
					ret.value = Expression.parse(parser, list);
					type = 0;
					state = 1;
				}
			} else if (state === 1) {
				if (type === 0) {
					if (token.type === Token.TYPE_KEYWORD) {
						if (token.keyword === 'WHEN') {
							++list.idx;
							ret.compare_values.push(Expression.parse(parser, list));
							state = 2;
						} else if (token.keyword === 'ELSE') {
							++list.idx;
							ret.else_result = Expression.parse(parser, list);
							state = 0;
						} else if (token.keyword === 'END') {
							state = 3;
							++list.idx;
							break;
						} else {
							parser.error('Unexpected keyword.', token);
							break;
						}
					}
				} else if (token.type === Token.TYPE_KEYWORD && token.keyword === 'THEN') {
					++list.idx;
					ret.results.push(Expression.parse(parser, list));
					state = 0;
				} else if (token.type === Token.TYPE_KEYWORD) {
					parser.error('Unexpected keyword.', token);
					break;
				}
			} else if (state === 2 && type === 0) {
				if (token.type === Token.TYPE_KEYWORD && token.keyword === 'THEN') {
					++list.idx;
					ret.results.push(Expression.parse(parser, list));
					state = 1;
				} else if (token.type === Token.TYPE_KEYWORD) {
					parser.error('Unexpected keyword.', token);
					break;
				}
			}
		}

		if (state === 3) {
			this.parseAlias(parser, list, ret);
		} else {
			parser.error('Unexpected end of CASE expression', list.tokens[list.idx - 1] ?? null);
		}

		--list.idx;
		return ret;
	}

	static build(component: CaseExpression): string {
		let ret = 'CASE ';
		if (component.value !== null) {
			// Syntax type 0.
			ret += `${phpStr(component.value)} `;
			const count = Math.min(component.compare_values.length, component.results.length);
			for (let i = 0; i < count; ++i) {
				ret += `WHEN ${phpStr(component.compare_values[i])} `;
				ret += `THEN ${phpStr(component.results[i])} `;
			}
		} else {
			// Syntax type 1.
			const count = Math.min(component.conditions.length, component.results.length);
			for (let i = 0; i < count; ++i) {
				ret += `WHEN ${Condition.build(component.conditions[i])} `;
				ret += `THEN ${phpStr(component.results[i])} `;
			}
		}

		if (component.else_result !== null) {
			ret += `ELSE ${phpStr(component.else_result)} `;
		}

		ret += 'END';

		if (phpBool(component.alias)) {
			ret += ` AS ${Context.escape(component.alias)}`;
		}

		return ret;
	}

	/** Reads the optional alias after END, with or without AS. */
	private static parseAlias(parser: Parser, list: TokensList, ret: CaseExpression): void {
		let asFound = false;
		for (; list.idx < list.count; ++list.idx) {
			const token = list.tokens[list.idx];

			if (token.type === Token.TYPE_DELIMITER) {
				break;
			}

			if (token.type === Token.TYPE_WHITESPACE || token.type === Token.TYPE_COMMENT) {
				continue;
			}

			if (token.type === Token.TYPE_KEYWORD && token.keyword === 'AS') {
				if (asFound || !phpEmpty(ret.alias)) {
					parser.error('Potential duplicate alias of CASE expression.', token);
					break;
				}
				asFound = true;
				continue;
			}

			if (
				asFound
				&& token.type === Token.TYPE_KEYWORD
				&& ((token.flags & Token.FLAG_KEYWORD_RESERVED) || (token.flags & Token.FLAG_KEYWORD_FUNCTION))
			) {
				parser.error(`An alias expected after AS but got ${phpStr(token.value)}`, token);
				asFound = false;
				break;
			}

			// PHP evaluates `! $token->flags & FLAG_SYMBOL_VARIABLE` as `(! $token->flags) & 1`.
			const flagless = token.flags ? 0 : 1;
			if (
				asFound
				|| token.type === Token.TYPE_STRING
				|| (token.type === Token.TYPE_SYMBOL && (flagless & Token.FLAG_SYMBOL_VARIABLE))
				|| token.type === Token.TYPE_NONE
			) {
				if (!phpEmpty(ret.alias)) {
					parser.error('An alias was previously found.', token);
					break;
				}
				ret.alias = token.value;
				asFound = false;
				continue;
			}

			break;
		}

		if (asFound) {
			parser.error('An alias was expected after AS.', list.tokens[list.idx - 1] ?? null);
		}

		ret.expr = this.build(ret);
	}

	value: Expression | null = null;

	conditions: Condition[][] = [];

	results: (Expression | null)[] = [];

	compare_values: (Expression | null)[] = [];

	else_result: Expression | null = null;

	alias: TokenValue = null;

	expr = '';
}

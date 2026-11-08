// Port of PhpMyAdmin\SqlParser\Components\ExpressionArray: a comma separated list of expressions.
import { Component } from '../Component.ts';
import { Token } from '../Token.ts';
import { CaseExpression } from './CaseExpression.ts';
import { Expression, type ExpressionOptions } from './Expression.ts';

import type { Parser } from '../Parser.ts';
import type { TokensList } from '../TokensList.ts';

export class ExpressionArray extends Component {
	static parse(parser: Parser, list: TokensList, options: ExpressionOptions = {}): (Expression | CaseExpression)[] {
		const ret: (Expression | CaseExpression)[] = [];

		let state = 0;

		for (; list.idx < list.count; ++list.idx) {
			const token = list.tokens[list.idx];

			if (token.type === Token.TYPE_DELIMITER) {
				break;
			}

			if (token.type === Token.TYPE_WHITESPACE || token.type === Token.TYPE_COMMENT) {
				continue;
			}

			if (
				token.type === Token.TYPE_KEYWORD
				&& (token.flags & Token.FLAG_KEYWORD_RESERVED)
				&& (~token.flags & Token.FLAG_KEYWORD_FUNCTION)
				&& token.value !== 'DUAL'
				&& token.value !== 'NULL'
				&& token.value !== 'CASE'
				&& token.value !== 'NOT'
			) {
				// No keyword is expected.
				break;
			}

			if (state === 0) {
				let expr: Expression | CaseExpression | null;
				if (token.type === Token.TYPE_KEYWORD && token.value === 'CASE') {
					expr = CaseExpression.parse(parser, list);
				} else {
					expr = Expression.parse(parser, list, options);
				}

				if (expr === null) {
					break;
				}

				ret.push(expr);
				state = 1;
			} else if (state === 1) {
				if (token.value !== ',') {
					break;
				}
				state = 0;
			}
		}

		if (state === 0) {
			parser.error('An expression was expected.', list.tokens[list.idx] ?? null);
		}

		--list.idx;

		// A trailing "-- comment" is not part of the last expression.
		const last = ret.at(-1);
		if (last !== undefined) {
			const expr = last.expr ?? '';
			const match = /\s*--\s.*$/.exec(expr);
			if (match) {
				last.expr = expr.slice(0, expr.length - match[0].length);
			}
		}

		return ret;
	}

	static build(component: Component[]): string {
		return component.map(fragment => fragment.toString()).join(', ');
	}
}

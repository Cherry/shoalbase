// Port of PhpMyAdmin\SqlParser\Components\OrderKeyword: the expressions and directions of ORDER BY.
import { Component } from '../Component.ts';
import { phpEmpty, phpStr } from '../php.ts';
import { Token } from '../Token.ts';
import { Expression } from './Expression.ts';

import type { Parser } from '../Parser.ts';
import type { TokensList } from '../TokensList.ts';

export class OrderKeyword extends Component {
	static parse(parser: Parser, list: TokensList): OrderKeyword[] {
		const ret: OrderKeyword[] = [];

		let expr = new this();
		let state = 0;

		for (; list.idx < list.count; ++list.idx) {
			const token = list.tokens[list.idx];

			if (token.type === Token.TYPE_DELIMITER) {
				break;
			}

			if (token.type === Token.TYPE_WHITESPACE || token.type === Token.TYPE_COMMENT) {
				continue;
			}

			if (state === 0) {
				expr.expr = Expression.parse(parser, list);
				state = 1;
			} else if (state === 1) {
				if (token.type === Token.TYPE_KEYWORD && (token.keyword === 'ASC' || token.keyword === 'DESC')) {
					expr.type = token.keyword;
				} else if (token.type === Token.TYPE_OPERATOR && token.value === ',') {
					if (!phpEmpty(expr.expr)) {
						ret.push(expr);
					}
					expr = new this();
					state = 0;
				} else {
					break;
				}
			}
		}

		// The last iteration was not processed.
		if (!phpEmpty(expr.expr)) {
			ret.push(expr);
		}

		--list.idx;
		return ret;
	}

	static build(component: OrderKeyword | OrderKeyword[]): string {
		if (Array.isArray(component)) {
			return component.map(item => phpStr(item)).join(', ');
		}
		return `${phpStr(component.expr)} ${component.type}`;
	}

	expr: Expression | null;

	type: string;

	constructor(expr: Expression | null = null, type = 'ASC') {
		super();
		this.expr = expr;
		this.type = type;
	}
}

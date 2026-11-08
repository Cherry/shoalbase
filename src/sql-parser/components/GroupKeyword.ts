// Port of PhpMyAdmin\SqlParser\Components\GroupKeyword: the expressions of GROUP BY.
import { Component } from '../Component.ts';
import { phpEmpty, phpStr, phpTrim } from '../php.ts';
import { Token } from '../Token.ts';
import { Expression } from './Expression.ts';

import type { Parser } from '../Parser.ts';
import type { TokensList } from '../TokensList.ts';

export class GroupKeyword extends Component {
	static parse(parser: Parser, list: TokensList): GroupKeyword[] {
		const ret: GroupKeyword[] = [];

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

	static build(component: GroupKeyword | GroupKeyword[]): string {
		if (Array.isArray(component)) {
			return component.map(item => phpStr(item)).join(', ');
		}
		return phpTrim(phpStr(component.expr));
	}

	type: string | null = null;

	expr: Expression | null;

	constructor(expr: Expression | null = null) {
		super();
		this.expr = expr;
	}
}

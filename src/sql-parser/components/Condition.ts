// Port of PhpMyAdmin\SqlParser\Components\Condition: WHERE/HAVING/ON conditions split on logical operators.
import { Component } from '../Component.ts';
import {
	inArrayLoose,
	isset,
	phpStr,
	phpTrim,
} from '../php.ts';
import { Token, type TokenValue } from '../Token.ts';

import type { Parser } from '../Parser.ts';
import type { TokensList } from '../TokensList.ts';

export class Condition extends Component {
	static DELIMITERS = ['&&', '||', 'AND', 'OR', 'XOR'];

	static ALLOWED_KEYWORDS: Record<string, number> = {
		'ALL': 1,
		'AND': 1,
		'BETWEEN': 1,
		'COLLATE': 1,
		'EXISTS': 1,
		'IF': 1,
		'IN': 1,
		'INTERVAL': 1,
		'IS': 1,
		'LIKE': 1,
		'MATCH': 1,
		'NOT IN': 1,
		'NOT NULL': 1,
		'NOT': 1,
		'NULL': 1,
		'OR': 1,
		'REGEXP': 1,
		'RLIKE': 1,
		'SOUNDS': 1,
		'XOR': 1,
	};

	static parse(parser: Parser, list: TokensList): Condition[] {
		const ret: Condition[] = [];

		let expr = new this();
		let brackets = 0;
		let betweenBefore = false;

		for (; list.idx < list.count; ++list.idx) {
			const token = list.tokens[list.idx];

			if (token.type === Token.TYPE_DELIMITER) {
				break;
			}

			if (token.type === Token.TYPE_COMMENT) {
				continue;
			}

			// Every whitespace becomes a single space.
			if (token.type === Token.TYPE_WHITESPACE) {
				expr.expr += ' ';
				continue;
			}

			// Conditions are delimited by logical operators.
			if (
				(token.type === Token.TYPE_KEYWORD || token.type === Token.TYPE_OPERATOR)
				&& this.DELIMITERS.includes(token.value as string)
			) {
				if (betweenBefore && token.value === 'AND') {
					// The AND of BETWEEN ... AND ... is part of the condition.
					betweenBefore = false;
				} else {
					expr.expr = phpTrim(expr.expr);
					if (expr.expr !== '') {
						ret.push(expr);
					}

					expr = new this(token.value);
					expr.isOperator = true;
					ret.push(expr);

					expr = new this();
					continue;
				}
			}

			if (
				token.type === Token.TYPE_KEYWORD
				&& (token.flags & Token.FLAG_KEYWORD_RESERVED)
				&& !(token.flags & Token.FLAG_KEYWORD_FUNCTION)
			) {
				if (token.value === 'BETWEEN') {
					betweenBefore = true;
				}
				if (brackets === 0 && !isset(this.ALLOWED_KEYWORDS, token.value)) {
					break;
				}
			}

			if (token.type === Token.TYPE_OPERATOR) {
				if (token.value === '(') {
					++brackets;
				} else if (token.value === ')') {
					if (brackets === 0) {
						break;
					}
					--brackets;
				}
			}

			expr.expr += token.token ?? '';
			if (
				token.type !== Token.TYPE_NONE
				&& (token.type !== Token.TYPE_KEYWORD || (token.flags & Token.FLAG_KEYWORD_RESERVED))
				&& token.type !== Token.TYPE_STRING
				&& (token.type !== Token.TYPE_SYMBOL || (token.flags & Token.FLAG_SYMBOL_PARAMETER))
			) {
				continue;
			}

			if (inArrayLoose(token.value, expr.identifiers)) {
				continue;
			}

			expr.identifiers.push(token.value);
		}

		// The last iteration was not processed.
		expr.expr = phpTrim(expr.expr);
		if (expr.expr !== '') {
			ret.push(expr);
		}

		--list.idx;
		return ret;
	}

	static build(component: Condition | Condition[]): string {
		if (Array.isArray(component)) {
			return component.map(item => phpStr(item)).join(' ');
		}
		return component.expr;
	}

	identifiers: TokenValue[] = [];

	isOperator = false;

	expr: string;

	constructor(expr: unknown = null) {
		super();
		this.expr = phpTrim(phpStr(expr));
	}
}

// Port of PhpMyAdmin\SqlParser\Components\SetOperation: column = value assignments of SET.
import { Component } from '../Component.ts';
import { phpStr, phpTrim } from '../php.ts';
import { Token } from '../Token.ts';
import { Expression } from './Expression.ts';

import type { Parser } from '../Parser.ts';
import type { TokensList } from '../TokensList.ts';

export class SetOperation extends Component {
	static parse(parser: Parser, list: TokensList): SetOperation[] {
		const ret: SetOperation[] = [];

		let expr = new this();
		let state = 0;
		let commaLastSeenAt: Token | null = null;

		for (; list.idx < list.count; ++list.idx) {
			const token = list.tokens[list.idx];

			if (token.type === Token.TYPE_DELIMITER) {
				break;
			}

			if (token.type === Token.TYPE_WHITESPACE || token.type === Token.TYPE_COMMENT) {
				continue;
			}

			// No keyword is expected.
			if (token.type === Token.TYPE_KEYWORD && (token.flags & Token.FLAG_KEYWORD_RESERVED) && state === 0) {
				break;
			}

			if (state === 0) {
				if (token.token === '=' || token.token === ':=') {
					state = 1;
				} else if (token.value === ',') {
					commaLastSeenAt = token;
				} else {
					expr.column += token.token ?? '';
				}
			} else if (state === 1) {
				const tmp = Expression.parse(parser, list, { breakOnAlias: true });
				if (tmp === null) {
					parser.error('Missing expression.', token);
					break;
				}

				expr.column = phpTrim(expr.column);
				expr.value = tmp.expr ?? '';
				ret.push(expr);
				expr = new this();
				state = 0;
				commaLastSeenAt = null;
			}
		}

		--list.idx;

		// A comma without a column-value pair after it.
		if (commaLastSeenAt !== null) {
			parser.error('Unexpected token.', commaLastSeenAt);
		}

		return ret;
	}

	static build(component: SetOperation | SetOperation[]): string {
		if (Array.isArray(component)) {
			return component.map(item => phpStr(item)).join(', ');
		}
		return `${component.column} = ${component.value}`;
	}

	column: string;

	value: string;

	constructor(column = '', value = '') {
		super();
		this.column = column;
		this.value = value;
	}
}

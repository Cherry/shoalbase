// Port of PhpMyAdmin\SqlParser\Components\LockExpression: a table and its lock type in LOCK TABLES.
import { Component } from '../Component.ts';
import { phpStr } from '../php.ts';
import { Token } from '../Token.ts';
import { Expression } from './Expression.ts';

import type { Parser } from '../Parser.ts';
import type { TokensList } from '../TokensList.ts';

export class LockExpression extends Component {
	static parse(parser: Parser, list: TokensList): LockExpression {
		const ret = new this();

		let state = 0;
		let prevToken: Token | null = null;

		for (; list.idx < list.count; ++list.idx) {
			const token = list.tokens[list.idx];

			if (token.type === Token.TYPE_DELIMITER || (token.type === Token.TYPE_OPERATOR && token.value === ',')) {
				break;
			}

			if (state === 0) {
				ret.table = Expression.parse(parser, list, { parseField: 'table' });
				state = 1;
			} else if (state === 1) {
				ret.type = this.parseLockType(parser, list);
				state = 2;
			}

			prevToken = token;
		}

		// 2 is the only valid end state.
		if (state !== 2) {
			parser.error('Unexpected end of LOCK expression.', prevToken);
		}

		--list.idx;
		return ret;
	}

	static build(component: LockExpression | LockExpression[]): string {
		if (Array.isArray(component)) {
			return component.map(item => phpStr(item)).join(', ');
		}
		return `${phpStr(component.table)} ${phpStr(component.type)}`;
	}

	private static parseLockType(parser: Parser, list: TokensList): string {
		let lockType = '';

		let state = 0;
		let prevToken: Token | null = null;

		for (; list.idx < list.count; ++list.idx) {
			const token = list.tokens[list.idx];

			if (token.type === Token.TYPE_DELIMITER || (token.type === Token.TYPE_OPERATOR && token.value === ',')) {
				--list.idx;
				break;
			}

			if (token.type === Token.TYPE_WHITESPACE || token.type === Token.TYPE_COMMENT) {
				continue;
			}

			// Only keywords are expected.
			if (token.type !== Token.TYPE_KEYWORD) {
				parser.error('Unexpected token.', token);
				break;
			}

			if (state === 0) {
				if (token.keyword === 'READ') {
					state = 1;
				} else if (token.keyword === 'LOW_PRIORITY') {
					state = 2;
				} else if (token.keyword === 'WRITE') {
					state = 3;
				} else {
					parser.error('Unexpected keyword.', token);
					break;
				}
				lockType += token.keyword;
			} else if (state === 1) {
				if (token.keyword !== 'LOCAL') {
					parser.error('Unexpected keyword.', token);
					break;
				}
				lockType += ` ${token.keyword}`;
				state = 3;
			} else if (state === 2) {
				if (token.keyword !== 'WRITE') {
					parser.error('Unexpected keyword.', token);
					break;
				}
				lockType += ` ${token.keyword}`;
				// Parsing is over.
				state = 3;
			}

			prevToken = token;
		}

		// Only two possible end states.
		if (state !== 1 && state !== 3) {
			parser.error('Unexpected end of LOCK expression.', prevToken);
		}

		return lockType;
	}

	table: Expression | null = null;

	type: string | null = null;
}

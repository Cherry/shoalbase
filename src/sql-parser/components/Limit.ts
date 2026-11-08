// Port of PhpMyAdmin\SqlParser\Components\Limit: LIMIT [offset,] row_count and LIMIT row_count OFFSET offset.
import { Component } from '../Component.ts';
import { phpStr } from '../php.ts';
import { Token, type TokenValue } from '../Token.ts';

import type { Parser } from '../Parser.ts';
import type { TokensList } from '../TokensList.ts';

export class Limit extends Component {
	static parse(parser: Parser, list: TokensList): Limit {
		const ret = new this();

		let offset = false;

		for (; list.idx < list.count; ++list.idx) {
			const token = list.tokens[list.idx];

			if (token.type === Token.TYPE_DELIMITER) {
				break;
			}

			if (token.type === Token.TYPE_WHITESPACE || token.type === Token.TYPE_COMMENT) {
				continue;
			}

			if (token.type === Token.TYPE_KEYWORD && (token.flags & Token.FLAG_KEYWORD_RESERVED)) {
				break;
			}

			if (token.type === Token.TYPE_KEYWORD && token.keyword === 'OFFSET') {
				if (offset) {
					parser.error('An offset was expected.', token);
				}
				offset = true;
				continue;
			}

			if (token.type === Token.TYPE_OPERATOR && token.value === ',') {
				ret.offset = ret.rowCount;
				ret.rowCount = 0;
				continue;
			}

			// Only numbers and bind parameters (?) are expected.
			if (!(token.type === Token.TYPE_NUMBER || (token.type === Token.TYPE_SYMBOL && (token.flags & Token.FLAG_SYMBOL_PARAMETER)))) {
				break;
			}

			if (offset) {
				ret.offset = token.value;
				offset = false;
			} else {
				ret.rowCount = token.value;
			}
		}

		if (offset) {
			parser.error('An offset was expected.', list.tokens[list.idx - 1] ?? null);
		}

		--list.idx;
		return ret;
	}

	static build(component: Limit): string {
		return `${phpStr(component.offset)}, ${phpStr(component.rowCount)}`;
	}

	offset: TokenValue;

	rowCount: TokenValue;

	constructor(rowCount: TokenValue = 0, offset: TokenValue = 0) {
		super();
		this.rowCount = rowCount;
		this.offset = offset;
	}
}

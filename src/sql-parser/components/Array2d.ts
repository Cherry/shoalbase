// Port of PhpMyAdmin\SqlParser\Components\Array2d: a list of value lists, as in INSERT ... VALUES (...), (...).
import { sprintf } from '../../lib/pma/sprintf.ts';
import { Component, type ComponentOptions } from '../Component.ts';
import { Token } from '../Token.ts';
import { Translator } from '../Translator.ts';
import { ArrayObj } from './ArrayObj.ts';

import type { Parser } from '../Parser.ts';
import type { TokensList } from '../TokensList.ts';

export class Array2d extends Component {
	static parse(parser: Parser, list: TokensList, options: ComponentOptions = {}): ArrayObj[] {
		const ret: ArrayObj[] = [];

		// The number of values in each row, taken from the first one.
		let count = -1;
		let state = 0;

		for (; list.idx < list.count; ++list.idx) {
			const token = list.tokens[list.idx];

			if (token.type === Token.TYPE_DELIMITER) {
				break;
			}

			if (token.type === Token.TYPE_WHITESPACE || token.type === Token.TYPE_COMMENT) {
				continue;
			}

			// No keyword is expected.
			if (token.type === Token.TYPE_KEYWORD && (token.flags & Token.FLAG_KEYWORD_RESERVED)) {
				break;
			}

			if (state === 0) {
				if (token.value !== '(') {
					break;
				}

				const arr = ArrayObj.parse(parser, list, options) as ArrayObj;
				const arrCount = arr.values.length;
				if (count === -1) {
					count = arrCount;
				} else if (arrCount !== count) {
					parser.error(
						sprintf(Translator.gettext('%1$d values were expected, but found %2$d.'), count, arrCount),
						token,
					);
				}

				ret.push(arr);
				state = 1;
			} else if (state === 1) {
				if (token.value !== ',') {
					break;
				}
				state = 0;
			}
		}

		if (state === 0) {
			parser.error('An opening bracket followed by a set of values was expected.', list.tokens[list.idx] ?? null);
		}

		--list.idx;
		return ret;
	}

	static build(component: ArrayObj[]): string {
		return ArrayObj.build(component);
	}
}

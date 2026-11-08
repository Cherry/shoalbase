// Port of PhpMyAdmin\SqlParser\Components\FunctionCall: a function name followed by its parameters, as in CALL.
import { Component } from '../Component.ts';
import { phpStr } from '../php.ts';
import { Token } from '../Token.ts';
import { ArrayObj } from './ArrayObj.ts';

import type { Parser } from '../Parser.ts';
import type { TokensList } from '../TokensList.ts';

export class FunctionCall extends Component {
	static parse(parser: Parser, list: TokensList): FunctionCall {
		const ret = new this();

		let state = 0;

		for (; list.idx < list.count; ++list.idx) {
			const token = list.tokens[list.idx];

			if (token.type === Token.TYPE_DELIMITER) {
				// Stay on the previous token to avoid "This type of clause was previously parsed.".
				--list.idx;
				break;
			}

			if (token.type === Token.TYPE_WHITESPACE || token.type === Token.TYPE_COMMENT) {
				continue;
			}

			if (state === 0) {
				if (token.type === Token.TYPE_OPERATOR && token.value === '(') {
					// ArrayObj needs to start with `(`.
					--list.idx;
					state = 1;
					continue;
				}
				ret.name = (ret.name ?? '') + phpStr(token.value);
			} else if (state === 1) {
				ret.parameters = ArrayObj.parse(parser, list) as ArrayObj;
				break;
			}
		}

		return ret;
	}

	static build(component: FunctionCall): string {
		return phpStr(component.name) + phpStr(component.parameters);
	}

	name: string | null;

	parameters: ArrayObj | null = null;

	constructor(name: string | null = null, parameters: ArrayObj | string[] | null = null) {
		super();
		this.name = name;
		if (Array.isArray(parameters)) {
			this.parameters = new ArrayObj(parameters);
		} else if (parameters instanceof ArrayObj) {
			this.parameters = parameters;
		}
	}
}

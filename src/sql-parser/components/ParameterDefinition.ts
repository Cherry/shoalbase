// Port of PhpMyAdmin\SqlParser\Components\ParameterDefinition: the parameters of a routine definition.
import { Component } from '../Component.ts';
import { Context } from '../Context.ts';
import { phpEmpty, phpStr, phpTrim } from '../php.ts';
import { Token, type TokenValue } from '../Token.ts';
import { DataType } from './DataType.ts';

import type { Parser } from '../Parser.ts';
import type { TokensList } from '../TokensList.ts';

export class ParameterDefinition extends Component {
	static parse(parser: Parser, list: TokensList): ParameterDefinition[] {
		const ret: ParameterDefinition[] = [];

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
				// Everything up to the opening bracket is skipped.
				if (token.type === Token.TYPE_OPERATOR && token.value === '(') {
					state = 1;
				}
			} else if (state === 1) {
				if (['IN', 'OUT', 'INOUT'].includes(token.value as string)) {
					expr.inOut = token.value;
					++list.idx;
				} else if (token.value === ')') {
					++list.idx;
					break;
				} else {
					expr.name = token.value;
					state = 2;
				}
			} else if (state === 2) {
				expr.type = DataType.parse(parser, list);
				state = 3;
			} else if (state === 3) {
				ret.push(expr);
				expr = new this();
				if (token.value === ',') {
					state = 1;
				} else if (token.value === ')') {
					++list.idx;
					break;
				}
			}
		}

		// The last iteration was not saved.
		if (expr.name !== null && expr.name !== '') {
			ret.push(expr);
		}

		--list.idx;
		return ret;
	}

	static build(component: ParameterDefinition | ParameterDefinition[]): string {
		if (Array.isArray(component)) {
			return `(${component.map(item => phpStr(item)).join(', ')})`;
		}

		let tmp = '';
		if (!phpEmpty(component.inOut)) {
			tmp += `${phpStr(component.inOut)} `;
		}

		return phpTrim(`${tmp}${Context.escape(component.name)} ${phpStr(component.type)}`);
	}

	name: TokenValue;

	inOut: TokenValue;

	type: DataType | null;

	constructor(name: TokenValue = null, inOut: TokenValue = null, type: DataType | null = null) {
		super();
		this.name = name;
		this.inOut = inOut;
		this.type = type;
	}
}

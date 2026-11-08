// Port of PhpMyAdmin\SqlParser\Components\PartitionDefinition: a PARTITION or SUBPARTITION definition.
import { Component } from '../Component.ts';
import { phpEmpty, phpStr, phpTrim } from '../php.ts';
import { Token, type TokenValue } from '../Token.ts';
import { ArrayObj } from './ArrayObj.ts';
import { Expression } from './Expression.ts';
import { OptionsArray, type OptionsSpec } from './OptionsArray.ts';

import type { Parser } from '../Parser.ts';
import type { TokensList } from '../TokensList.ts';

export class PartitionDefinition extends Component {
	static OPTIONS: OptionsSpec = {
		'STORAGE ENGINE': [1, 'var'],
		'ENGINE': [1, 'var'],
		'COMMENT': [2, 'var'],
		'DATA DIRECTORY': [3, 'var'],
		'INDEX DIRECTORY': [4, 'var'],
		'MAX_ROWS': [5, 'var'],
		'MIN_ROWS': [6, 'var'],
		'TABLESPACE': [7, 'var'],
		'NODEGROUP': [8, 'var'],
	};

	static parse(parser: Parser, list: TokensList): PartitionDefinition {
		const ret = new this();

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
				ret.isSubpartition = token.type === Token.TYPE_KEYWORD && token.keyword === 'SUBPARTITION';
				state = 1;
			} else if (state === 1) {
				ret.name = token.value;

				// The name ends at the first token that is not a plain name (usually a whitespace).
				let nextToken: Token | undefined;
				while ((nextToken = list.tokens[++list.idx]) !== undefined) {
					if (nextToken.type !== Token.TYPE_NONE) {
						break;
					}
					ret.name = phpStr(ret.name) + phpStr(nextToken.value);
				}

				// Looking ahead for a VALUES keyword after the whitespace, then stepping back for the loop.
				nextToken = list.tokens[list.idx + 1];
				list.idx--;
				state = nextToken?.type === Token.TYPE_KEYWORD && nextToken.value === 'VALUES' ? 2 : 5;
			} else if (state === 2) {
				state = 3;
			} else if (state === 3) {
				ret.type = token.value;
				state = 4;
			} else if (state === 4) {
				if (token.value === 'MAXVALUE') {
					ret.expr = token.value;
				} else {
					ret.expr = Expression.parse(parser, list, { parenthesesDelimited: true, breakOnAlias: true });
				}
				state = 5;
			} else if (state === 5) {
				ret.options = OptionsArray.parse(parser, list, this.OPTIONS);
				state = 6;
			} else if (state === 6) {
				if (token.type === Token.TYPE_OPERATOR && token.value === '(') {
					ret.subpartitions = ArrayObj.parse(parser, list, { type: this }) as PartitionDefinition[];
					++list.idx;
				}
				break;
			}
		}

		--list.idx;
		return ret;
	}

	static build(component: PartitionDefinition | PartitionDefinition[]): string {
		if (Array.isArray(component)) {
			return `(\n${component.map(item => phpStr(item)).join(',\n')}\n)`;
		}

		if (component.isSubpartition) {
			return phpTrim(`SUBPARTITION ${phpStr(component.name)} ${phpStr(component.options)}`);
		}

		const subpartitions = phpEmpty(component.subpartitions) ? '' : ` ${this.build(component.subpartitions ?? [])}`;

		const values = phpEmpty(component.type) ? '' : ` VALUES ${phpStr(component.type)} ${phpStr(component.expr)} `;
		const separator = !phpEmpty(component.options) && !phpEmpty(component.type) ? '' : ' ';
		return phpTrim(`PARTITION ${phpStr(component.name)}${values}${separator}${phpStr(component.options)}${subpartitions}`);
	}

	isSubpartition: boolean | null = null;

	name: TokenValue = null;

	type: TokenValue = null;

	expr: Expression | TokenValue = null;

	subpartitions: PartitionDefinition[] | null = null;

	options: OptionsArray | null = null;
}

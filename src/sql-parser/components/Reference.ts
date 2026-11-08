// Port of PhpMyAdmin\SqlParser\Components\Reference: the REFERENCES part of a foreign key.
import { Component } from '../Component.ts';
import { Context } from '../Context.ts';
import { phpStr, phpTrim } from '../php.ts';
import { Token } from '../Token.ts';
import { ArrayObj } from './ArrayObj.ts';
import { Expression } from './Expression.ts';
import { OptionsArray, type OptionsSpec } from './OptionsArray.ts';

import type { Parser } from '../Parser.ts';
import type { TokensList } from '../TokensList.ts';

export class Reference extends Component {
	static REFERENCES_OPTIONS: OptionsSpec = {
		'MATCH': [1, 'var'],
		'ON DELETE': [2, 'var'],
		'ON UPDATE': [3, 'var'],
	};

	static parse(parser: Parser, list: TokensList): Reference {
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
				ret.table = Expression.parse(parser, list, { parseField: 'table', breakOnAlias: true });
				state = 1;
			} else if (state === 1) {
				ret.columns = (ArrayObj.parse(parser, list) as ArrayObj).values;
				state = 2;
			} else if (state === 2) {
				ret.options = OptionsArray.parse(parser, list, this.REFERENCES_OPTIONS);
				++list.idx;
				break;
			}
		}

		--list.idx;
		return ret;
	}

	static build(component: Reference): string {
		return phpTrim(`${phpStr(component.table)} (${Context.escape(component.columns).join(', ')}) ${phpStr(component.options)}`);
	}

	table: Expression | null;

	columns: string[];

	options: OptionsArray | null;

	constructor(table: Expression | null = null, columns: string[] = [], options: OptionsArray | null = null) {
		super();
		this.table = table;
		this.columns = columns;
		this.options = options;
	}
}

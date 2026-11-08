// Port of PhpMyAdmin\SqlParser\Components\DataType: a column type with its parameters and options.
import { Component, type ComponentOptions } from '../Component.ts';
import {
	phpEmpty,
	phpStr,
	phpTrim,
	strtolower,
	strtoupper,
} from '../php.ts';
import { Token } from '../Token.ts';
import { ArrayObj } from './ArrayObj.ts';
import { OptionsArray, type OptionsSpec } from './OptionsArray.ts';

import type { Parser } from '../Parser.ts';
import type { TokensList } from '../TokensList.ts';

export class DataType extends Component {
	static DATA_TYPE_OPTIONS: OptionsSpec = {
		'BINARY': 1,
		'CHARACTER SET': [2, 'var'],
		'CHARSET': [2, 'var'],
		'COLLATE': [3, 'var'],
		'UNSIGNED': 4,
		'ZEROFILL': 5,
	};

	static parse(parser: Parser, list: TokensList): DataType | null {
		const ret = new this();

		let state = 0;

		for (; list.idx < list.count; ++list.idx) {
			const token = list.tokens[list.idx];

			if (token.type === Token.TYPE_WHITESPACE || token.type === Token.TYPE_COMMENT) {
				continue;
			}

			if (state === 0) {
				ret.name = strtoupper(phpStr(token.value));
				if (token.type !== Token.TYPE_KEYWORD || !(token.flags & Token.FLAG_KEYWORD_DATA_TYPE)) {
					parser.error('Unrecognized data type.', token);
				}
				state = 1;
			} else if (state === 1) {
				if (token.type === Token.TYPE_OPERATOR && token.value === '(') {
					const parameters = ArrayObj.parse(parser, list) as ArrayObj;
					++list.idx;
					ret.parameters = ret.name === 'ENUM' || ret.name === 'SET' ? parameters.raw : parameters.values;
				}
				ret.options = OptionsArray.parse(parser, list, this.DATA_TYPE_OPTIONS);
				++list.idx;
				break;
			}
		}

		if (phpEmpty(ret.name)) {
			return null;
		}

		--list.idx;
		return ret;
	}

	static build(component: DataType | null, options: ComponentOptions = {}): string {
		const name = phpEmpty(options.lowercase) ? phpStr(component?.name) : strtolower(phpStr(component?.name));

		let parameters = '';
		if (component && component.parameters.length > 0) {
			parameters = `(${component.parameters.join(',')})`;
		}

		return phpTrim(`${name}${parameters} ${phpStr(component?.options)}`);
	}

	name: string | null;

	parameters: string[];

	options: OptionsArray | null;

	constructor(name: string | null = null, parameters: string[] = [], options: OptionsArray | null = null) {
		super();
		this.name = name;
		this.parameters = parameters;
		this.options = options;
	}
}

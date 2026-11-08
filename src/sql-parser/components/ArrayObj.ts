// Port of PhpMyAdmin\SqlParser\Components\ArrayObj: a parenthesised list, kept raw or parsed into components.
import { Component, type ComponentClass, type ComponentOptions } from '../Component.ts';
import { phpEmpty, phpStr, phpTrim } from '../php.ts';
import { Token } from '../Token.ts';

import type { Parser } from '../Parser.ts';
import type { TokensList } from '../TokensList.ts';

export interface ArrayObjOptions extends ComponentOptions {
	type?: ComponentClass;
	typeOptions?: ComponentOptions;
}

export class ArrayObj extends Component {
	/** An ArrayObj, or the parsed items when options.type names a component class. */
	static parse(parser: Parser, list: TokensList, options: ArrayObjOptions = {}): ArrayObj | unknown[] {
		const type = phpEmpty(options.type) ? null : options.type ?? null;
		const ret = type === null ? new this() : null;
		const items: unknown[] = [];

		let lastRaw = '';
		let lastValue = '';
		let brackets = 0;
		let isCommaLast = false;

		for (; list.idx < list.count; ++list.idx) {
			const token = list.tokens[list.idx];

			if (token.type === Token.TYPE_DELIMITER) {
				if (brackets > 0) {
					parser.error('A closing bracket was expected.', token);
				}
				break;
			}

			if (token.type === Token.TYPE_WHITESPACE || token.type === Token.TYPE_COMMENT) {
				lastRaw += token.token ?? '';
				lastValue = `${phpTrim(lastValue)} `;
				continue;
			}

			if (brackets === 0 && (token.type !== Token.TYPE_OPERATOR || token.value !== '(')) {
				parser.error('An opening bracket was expected.', token);
				break;
			}

			if (token.type === Token.TYPE_OPERATOR) {
				if (token.value === '(') {
					// 1 is the base level.
					if (++brackets === 1) {
						continue;
					}
				} else if (token.value === ')') {
					if (--brackets === 0) {
						break;
					}
				} else if (token.value === ',' && brackets === 1) {
					isCommaLast = true;
					if (ret !== null) {
						ret.raw.push(phpTrim(lastRaw));
						ret.values.push(phpTrim(lastValue));
						lastRaw = '';
						lastValue = '';
					}
					continue;
				}
			}

			if (type === null) {
				lastRaw += token.token ?? '';
				lastValue += phpStr(token.value);
			} else {
				items.push(type.parse(parser, list, phpEmpty(options.typeOptions) ? {} : options.typeOptions));
			}
		}

		// Handles "[a,]" as ['a', ''] and "[]" as [].
		lastRaw = phpTrim(lastRaw);
		if (ret !== null && (lastRaw.length > 0 || isCommaLast)) {
			ret.raw.push(lastRaw);
			ret.values.push(phpTrim(lastValue));
		}

		return ret ?? items;
	}

	static build(component: ArrayObj | unknown[]): string {
		if (Array.isArray(component)) {
			return component.map(item => phpStr(item)).join(', ');
		}
		if (component.raw.length > 0) {
			return `(${component.raw.join(', ')})`;
		}
		return `(${component.values.join(', ')})`;
	}

	raw: string[];

	values: string[];

	constructor(raw: string[] = [], values: string[] = []) {
		super();
		this.raw = raw;
		this.values = values;
	}
}

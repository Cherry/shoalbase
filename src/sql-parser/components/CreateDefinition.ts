// Port of PhpMyAdmin\SqlParser\Components\CreateDefinition: the column and key definitions of CREATE TABLE.
import { Component } from '../Component.ts';
import { Context } from '../Context.ts';
import { phpEmpty, phpStr, phpTrim } from '../php.ts';
import { Token, type TokenValue } from '../Token.ts';
import { DataType } from './DataType.ts';
import { Key } from './Key.ts';
import { OptionsArray, type OptionsSpec } from './OptionsArray.ts';
import { Reference } from './Reference.ts';

import type { Parser } from '../Parser.ts';
import type { TokensList } from '../TokensList.ts';

export class CreateDefinition extends Component {
	static FIELD_OPTIONS: OptionsSpec = {
		// Tells OptionsArray to keep the options in the order they were written.
		'_UNSORTED': true,
		'NOT NULL': 1,
		'NULL': 1,
		'DEFAULT': [2, 'expr', { breakOnAlias: true }],
		// Not in the grammar, but MySQL accepts these anywhere.
		'CHARSET': [2, 'var'],
		'COLLATE': [3, 'var'],
		'AUTO_INCREMENT': 3,
		'KEY': 4,
		'PRIMARY': 4,
		'PRIMARY KEY': 4,
		'UNIQUE': 4,
		'UNIQUE KEY': 4,
		'COMMENT': [5, 'var'],
		'COLUMN_FORMAT': [6, 'var'],
		'ON UPDATE': [7, 'expr'],
		// Generated columns options.
		'GENERATED ALWAYS': 8,
		'AS': [9, 'expr', { parenthesesDelimited: true }],
		'VIRTUAL': 10,
		'PERSISTENT': 11,
		'STORED': 11,
		'CHECK': [12, 'expr', { parenthesesDelimited: true }],
		'INVISIBLE': 13,
		'ENFORCED': 14,
		'NOT': 15,
		'COMPRESSED': 16,
		'SRID': [17, 'var'],
	};

	static parse(parser: Parser, list: TokensList): CreateDefinition[] {
		const ret: CreateDefinition[] = [];

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
				if (token.type !== Token.TYPE_OPERATOR || token.value !== '(') {
					parser.error('An opening bracket was expected.', token);
					break;
				}
				state = 1;
			} else if (state === 1) {
				if (token.type === Token.TYPE_KEYWORD && token.keyword === 'CONSTRAINT') {
					expr.isConstraint = true;
				} else if (token.type === Token.TYPE_KEYWORD && (token.flags & Token.FLAG_KEYWORD_KEY)) {
					expr.key = Key.parse(parser, list);
					state = 4;
				} else if (token.type === Token.TYPE_SYMBOL || token.type === Token.TYPE_NONE) {
					expr.name = token.value;
					if (!expr.isConstraint) {
						state = 2;
					}
				} else if (token.type === Token.TYPE_KEYWORD) {
					if (token.flags & Token.FLAG_KEYWORD_RESERVED) {
						// Reserved keywords can't be used as field names without backquotes.
						parser.error(
							'A symbol name was expected! '
							+ 'A reserved keyword can not be used '
							+ 'as a column name without backquotes.',
							token,
						);
						return ret;
					}

					// Non-reserved keywords are allowed without backquotes.
					expr.name = token.value;
					state = 2;
				} else {
					parser.error('A symbol name was expected!', token);
					return ret;
				}
			} else if (state === 2) {
				expr.type = DataType.parse(parser, list);
				state = 3;
			} else if (state === 3) {
				expr.options = OptionsArray.parse(parser, list, this.FIELD_OPTIONS);
				state = 4;
			} else if (state === 4) {
				if (token.type === Token.TYPE_KEYWORD && token.keyword === 'REFERENCES') {
					// Skipping the keyword.
					++list.idx;
					expr.references = Reference.parse(parser, list);
				} else {
					--list.idx;
				}
				state = 5;
			} else if (state === 5) {
				if (!phpEmpty(expr.type) || !phpEmpty(expr.key)) {
					ret.push(expr);
				}
				expr = new this();
				if (token.value === ',') {
					state = 1;
				} else if (token.value === ')') {
					state = 6;
					++list.idx;
					break;
				} else {
					parser.error('A comma or a closing bracket was expected.', token);
					state = 0;
					break;
				}
			}
		}

		// The last iteration was not saved.
		if (!phpEmpty(expr.type) || !phpEmpty(expr.key)) {
			ret.push(expr);
		}

		if (state !== 0 && state !== 6) {
			parser.error('A closing bracket was expected.', list.tokens[list.idx - 1] ?? null);
		}

		--list.idx;
		return ret;
	}

	static build(component: CreateDefinition | CreateDefinition[]): string {
		if (Array.isArray(component)) {
			return `(\n  ${component.map(item => phpStr(item)).join(',\n  ')}\n)`;
		}

		let tmp = '';

		if (component.isConstraint) {
			tmp += 'CONSTRAINT ';
		}

		if (component.name !== null && component.name !== '') {
			tmp += `${Context.escape(component.name)} `;
		}

		if (!phpEmpty(component.type)) {
			tmp += `${DataType.build(component.type, { lowercase: true })} `;
		}

		if (!phpEmpty(component.key)) {
			tmp += `${phpStr(component.key)} `;
		}

		if (!phpEmpty(component.references)) {
			tmp += `REFERENCES ${phpStr(component.references)} `;
		}

		tmp += phpStr(component.options);

		return phpTrim(tmp);
	}

	name: TokenValue;

	isConstraint: boolean | null = null;

	type: DataType | null = null;

	key: Key | null = null;

	references: Reference | null = null;

	options: OptionsArray | null;

	constructor(name: TokenValue = null, options: OptionsArray | null = null, type: DataType | Key | null = null, isConstraint = false, references: Reference | null = null) {
		super();
		this.name = name;
		this.options = options;
		if (type instanceof DataType) {
			this.type = type;
		} else if (type instanceof Key) {
			this.key = type;
			this.isConstraint = isConstraint;
			this.references = references;
		}
	}
}

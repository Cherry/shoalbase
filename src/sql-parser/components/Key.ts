// Port of PhpMyAdmin\SqlParser\Components\Key: an index definition (columns or expressions) with its options.
import { Component } from '../Component.ts';
import { Context } from '../Context.ts';
import { phpEmpty, phpStr, phpTrim } from '../php.ts';
import { Token, type TokenValue } from '../Token.ts';
import { Expression } from './Expression.ts';
import { OptionsArray, type OptionsSpec } from './OptionsArray.ts';

import type { Parser } from '../Parser.ts';
import type { TokensList } from '../TokensList.ts';

/** A key column: name, optional prefix length and order, in the order they were read. */
export interface KeyColumn {
	name?: TokenValue;
	length?: TokenValue;
	order?: string | null;
}

export class Key extends Component {
	static KEY_OPTIONS: OptionsSpec = {
		'KEY_BLOCK_SIZE': [1, 'var='],
		'USING': [2, 'var'],
		'WITH PARSER': [3, 'var'],
		'COMMENT': [4, 'var'],
		// MariaDB options.
		'CLUSTERING': [4, 'var='],
		'ENGINE_ATTRIBUTE': [5, 'var='],
		'SECONDARY_ENGINE_ATTRIBUTE': [5, 'var='],
		// MariaDB and MySQL options.
		'VISIBLE': 6,
		'INVISIBLE': 6,
		// MariaDB options.
		'IGNORED': 10,
		'NOT IGNORED': 10,
	};

	static parse(parser: Parser, list: TokensList): Key {
		const ret = new this();

		let lastColumn: KeyColumn = {};
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
				ret.type = token.value;
				state = 1;
			} else if (state === 1) {
				if (token.type === Token.TYPE_OPERATOR && token.value === '(') {
					const positionBeforeSearch = list.idx;
					// Skip the "(" itself or the search would always find it.
					list.idx++;
					const nextToken = list.getNext();
					list.idx = positionBeforeSearch;
					// A second bracket switches to expression mode.
					state = nextToken !== null && nextToken.value === '(' ? 5 : 2;
				} else {
					ret.name = token.value;
				}
			} else if (state === 2) {
				if (token.type === Token.TYPE_OPERATOR) {
					if (token.value === '(') {
						state = 3;
					} else if (token.value === ',' || token.value === ')') {
						state = token.value === ',' ? 2 : 4;
						if (!phpEmpty(lastColumn)) {
							ret.columns.push(lastColumn);
							lastColumn = {};
						}
					}
				} else if (token.type === Token.TYPE_KEYWORD && (token.keyword === 'ASC' || token.keyword === 'DESC')) {
					lastColumn.order = token.keyword;
				} else {
					lastColumn.name = token.value;
				}
			} else if (state === 3) {
				if (token.type === Token.TYPE_OPERATOR && token.value === ')') {
					state = 2;
				} else {
					lastColumn.length = token.value;
				}
			} else if (state === 4) {
				ret.options = OptionsArray.parse(parser, list, this.KEY_OPTIONS);
				++list.idx;
				break;
			} else if (state === 5) {
				if (token.type === Token.TYPE_OPERATOR) {
					// The end of the expressions; the options follow.
					if (token.value === ')') {
						state = 4;
						continue;
					}

					// Another expression follows.
					if (token.value === ',') {
						ret.expr = `${ret.expr ?? ''}, `;
						continue;
					}

					if (token.value === '(') {
						if (ret.expr === null) {
							ret.expr = '';
						}
						ret.expr += phpStr(Expression.parse(parser, list, { parenthesesDelimited: true }));
						continue;
					}
				}

				parser.error('Unexpected token.', token);
			}
		}

		--list.idx;
		return ret;
	}

	static build(component: Key): string {
		let ret = `${phpStr(component.type)} `;
		if (!phpEmpty(component.name)) {
			ret += `${Context.escape(component.name)} `;
		}

		if (component.expr !== null) {
			return `${ret}(${component.expr}) ${phpStr(component.options)}`;
		}

		const columns: string[] = [];
		for (const column of component.columns) {
			let tmp = '';
			if (column.name !== undefined && column.name !== null) {
				tmp += Context.escape(column.name);
			}
			if (column.length !== undefined && column.length !== null) {
				tmp += `(${phpStr(column.length)})`;
			}
			if (column.order !== undefined && column.order !== null) {
				tmp += ` ${column.order}`;
			}
			columns.push(tmp);
		}

		ret += `(${columns.join(',')}) ${phpStr(component.options)}`;

		return phpTrim(ret);
	}

	name: TokenValue;

	columns: KeyColumn[];

	type: TokenValue;

	expr: string | null = null;

	options: OptionsArray | null;

	constructor(name: TokenValue = null, columns: KeyColumn[] = [], type: TokenValue = null, options: OptionsArray | null = null) {
		super();
		this.name = name;
		this.columns = columns;
		this.type = type;
		this.options = options;
	}
}

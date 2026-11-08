// Port of PhpMyAdmin\SqlParser\Components\IndexHint: USE/IGNORE/FORCE INDEX|KEY [FOR JOIN|ORDER BY|GROUP BY] (...).
import { Component, type ComponentOptions } from '../Component.ts';
import { phpStr } from '../php.ts';
import { Token } from '../Token.ts';
import { ExpressionArray } from './ExpressionArray.ts';

import type { Parser } from '../Parser.ts';
import type { TokensList } from '../TokensList.ts';
import type { CaseExpression } from './CaseExpression.ts';
import type { Expression } from './Expression.ts';


export class IndexHint extends Component {
	static parse(parser: Parser, list: TokensList, options: ComponentOptions = {}): IndexHint[] {
		const ret: IndexHint[] = [];
		let expr = new this();
		expr.type = (options.type as string | undefined) ?? null;
		let state = 0;

		// The keyword is analysed too, to determine the type of the hint.
		if (list.idx > 0) {
			--list.idx;
		}

		for (; list.idx < list.count; ++list.idx) {
			const token = list.tokens[list.idx];

			if (token.type === Token.TYPE_DELIMITER) {
				break;
			}

			if (token.type === Token.TYPE_WHITESPACE || token.type === Token.TYPE_COMMENT) {
				continue;
			}

			if (state === 0) {
				if (token.type === Token.TYPE_KEYWORD) {
					if (!['USE', 'IGNORE', 'FORCE'].includes(token.keyword ?? '')) {
						break;
					}
					expr.type = token.keyword;
					state = 1;
				}
			} else if (state === 1) {
				if (token.type === Token.TYPE_KEYWORD) {
					if (token.keyword === 'INDEX' || token.keyword === 'KEY') {
						expr.indexOrKey = token.keyword;
					} else {
						parser.error('Unexpected keyword.', token);
					}
					state = 2;
				} else {
					parser.error('Unexpected token.', token);
				}
			} else if (state === 2) {
				if (token.type === Token.TYPE_KEYWORD && token.keyword === 'FOR') {
					state = 3;
				} else {
					expr.indexes = ExpressionArray.parse(parser, list);
					state = 0;
					ret.push(expr);
					expr = new this();
				}
			} else if (state === 3) {
				if (token.type === Token.TYPE_KEYWORD) {
					if (['JOIN', 'GROUP BY', 'ORDER BY'].includes(token.keyword ?? '')) {
						expr.for = token.keyword;
					} else {
						parser.error('Unexpected keyword.', token);
					}
					state = 4;
				} else {
					parser.error('Unexpected token.', token);
				}
			} else if (state === 4) {
				expr.indexes = ExpressionArray.parse(parser, list);
				state = 0;
				ret.push(expr);
				expr = new this();
			}
		}

		--list.idx;
		return ret;
	}

	static build(component: IndexHint | IndexHint[]): string {
		if (Array.isArray(component)) {
			return component.map(item => phpStr(item)).join(' ');
		}
		let ret = `${phpStr(component.type)} ${phpStr(component.indexOrKey)} `;
		if (component.for !== null) {
			ret += `FOR ${component.for} `;
		}
		return ret + ExpressionArray.build(component.indexes);
	}

	type: string | null;

	indexOrKey: string | null;

	for: string | null;

	indexes: (Expression | CaseExpression)[];

	constructor(type: string | null = null, indexOrKey: string | null = null, forClause: string | null = null, indexes: (Expression | CaseExpression)[] = []) {
		super();
		this.type = type;
		this.indexOrKey = indexOrKey;
		this.for = forClause;
		this.indexes = indexes;
	}
}

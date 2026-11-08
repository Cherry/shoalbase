// Port of PhpMyAdmin\SqlParser\Components\JoinKeyword: the JOIN clauses with their ON/USING conditions and index hints.
import { Component } from '../Component.ts';
import { lookup, phpEmpty, phpStr } from '../php.ts';
import { Token } from '../Token.ts';
import { ArrayObj } from './ArrayObj.ts';
import { Condition } from './Condition.ts';
import { Expression } from './Expression.ts';
import { IndexHint } from './IndexHint.ts';

import type { Parser } from '../Parser.ts';
import type { TokensList } from '../TokensList.ts';

export class JoinKeyword extends Component {
	static JOINS: Record<string, string> = {
		'CROSS JOIN': 'CROSS',
		'FULL JOIN': 'FULL',
		'FULL OUTER JOIN': 'FULL',
		'INNER JOIN': 'INNER',
		'JOIN': 'JOIN',
		'LEFT JOIN': 'LEFT',
		'LEFT OUTER JOIN': 'LEFT',
		'RIGHT JOIN': 'RIGHT',
		'RIGHT OUTER JOIN': 'RIGHT',
		'NATURAL JOIN': 'NATURAL',
		'NATURAL LEFT JOIN': 'NATURAL LEFT',
		'NATURAL RIGHT JOIN': 'NATURAL RIGHT',
		'NATURAL LEFT OUTER JOIN': 'NATURAL LEFT OUTER',
		'NATURAL RIGHT OUTER JOIN': 'NATURAL RIGHT OUTER',
		'STRAIGHT_JOIN': 'STRAIGHT',
	};

	static parse(parser: Parser, list: TokensList): JoinKeyword[] {
		const ret: JoinKeyword[] = [];

		let expr = new this();
		let state = 0;

		// The keyword is analysed too, to determine the type of the join.
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
				const type = lookup(this.JOINS, token.keyword);
				if (token.type !== Token.TYPE_KEYWORD || phpEmpty(type)) {
					break;
				}
				expr.type = type ?? null;
				state = 1;
			} else if (state === 1) {
				expr.expr = Expression.parse(parser, list, { field: 'table' });
				state = 2;
			} else if (state === 2) {
				if (token.type === Token.TYPE_KEYWORD) {
					const type = lookup(this.JOINS, token.keyword);
					if (token.keyword === 'ON') {
						state = 3;
					} else if (token.keyword === 'USING') {
						state = 4;
					} else if (['USE', 'IGNORE', 'FORCE'].includes(token.keyword ?? '')) {
						// Index hints on the JOIN clause.
						expr.indexHints = IndexHint.parse(parser, list);
					} else if (phpEmpty(type)) {
						// The next clause is starting.
						break;
					} else {
						ret.push(expr);
						expr = new this();
						expr.type = type ?? null;
						state = 1;
					}
				}
			} else if (state === 3) {
				expr.on = Condition.parse(parser, list);
				ret.push(expr);
				expr = new this();
				state = 0;
			} else if (state === 4) {
				expr.using = ArrayObj.parse(parser, list) as ArrayObj;
				ret.push(expr);
				expr = new this();
				state = 0;
			}
		}

		if (!phpEmpty(expr.type)) {
			ret.push(expr);
		}

		--list.idx;
		return ret;
	}

	static build(component: JoinKeyword[]): string {
		const ret: string[] = [];
		for (const join of component) {
			// array_search() returns the first join name of the type, or false (an empty string).
			const name = Object.keys(this.JOINS).find(key => this.JOINS[key] === join.type) ?? '';
			let built = `${name} ${phpStr(join.expr)}`;
			if (join.indexHints.length > 0) {
				built += ` ${IndexHint.build(join.indexHints)}`;
			}
			if (!phpEmpty(join.on)) {
				built += ` ON ${Condition.build(join.on ?? [])}`;
			}
			if (!phpEmpty(join.using)) {
				built += ` USING ${ArrayObj.build(join.using ?? [])}`;
			}
			ret.push(built);
		}
		return ret.join(' ');
	}

	type: string | null;

	expr: Expression | null;

	on: Condition[] | null;

	using: ArrayObj | null;

	indexHints: IndexHint[];

	constructor(type: string | null = null, expr: Expression | null = null, on: Condition[] | null = null, using: ArrayObj | null = null, indexHints: IndexHint[] = []) {
		super();
		this.type = type;
		this.expr = expr;
		this.on = on;
		this.using = using;
		this.indexHints = indexHints;
	}
}

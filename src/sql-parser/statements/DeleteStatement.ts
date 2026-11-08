// Port of PhpMyAdmin\SqlParser\Statements\DeleteStatement.
import { Condition } from '../components/Condition.ts';
import { ExpressionArray } from '../components/ExpressionArray.ts';
import { JoinKeyword } from '../components/JoinKeyword.ts';
import { Limit } from '../components/Limit.ts';
import { OptionsArray, type OptionsSpec } from '../components/OptionsArray.ts';
import { OrderKeyword } from '../components/OrderKeyword.ts';
import { phpStr, stripos } from '../php.ts';
import { type Clauses, Statement } from '../Statement.ts';
import { Token } from '../Token.ts';

import type { ArrayObj } from '../components/ArrayObj.ts';
import type { CaseExpression } from '../components/CaseExpression.ts';
import type { Expression } from '../components/Expression.ts';
import type { Parser } from '../Parser.ts';
import type { TokensList } from '../TokensList.ts';

export class DeleteStatement extends Statement {
	static override OPTIONS: OptionsSpec = {
		LOW_PRIORITY: 1,
		QUICK: 2,
		IGNORE: 3,
	};

	static override CLAUSES: Clauses = {
		'DELETE': ['DELETE', 2],
		// Used for options.
		'_OPTIONS': ['_OPTIONS', 1],
		'FROM': ['FROM', 3],
		'PARTITION': ['PARTITION', 3],
		'USING': ['USING', 3],
		'WHERE': ['WHERE', 3],
		'ORDER BY': ['ORDER BY', 3],
		'LIMIT': ['LIMIT', 3],
	};

	declare from: (Expression | CaseExpression)[] | null;
	declare join: JoinKeyword[] | null;
	declare using: (Expression | CaseExpression)[] | null;
	declare columns: (Expression | CaseExpression)[] | null;
	declare partition: ArrayObj | null;
	declare where: Condition[] | null;
	declare order: OrderKeyword[] | null;
	declare limit: Limit | null;

	protected override initProperties(): void {
		this.from = null;
		this.join = null;
		this.using = null;
		this.columns = null;
		this.partition = null;
		this.where = null;
		this.order = null;
		this.limit = null;
	}

	override build(): string {
		let ret = `DELETE ${OptionsArray.build(this.options)}`;

		if (this.columns !== null && this.columns.length > 0) {
			ret += ` ${ExpressionArray.build(this.columns)}`;
		}

		if (this.from !== null && this.from.length > 0) {
			ret += ` FROM ${ExpressionArray.build(this.from)}`;
		}

		if (this.join !== null && this.join.length > 0) {
			ret += ` ${JoinKeyword.build(this.join)}`;
		}

		if (this.using !== null && this.using.length > 0) {
			ret += ` USING ${ExpressionArray.build(this.using)}`;
		}

		if (this.where !== null && this.where.length > 0) {
			ret += ` WHERE ${Condition.build(this.where)}`;
		}

		if (this.order !== null && this.order.length > 0) {
			ret += ` ORDER BY ${ExpressionArray.build(this.order)}`;
		}

		if (this.limit !== null && phpStr(this.limit).length > 0) {
			ret += ` LIMIT ${Limit.build(this.limit)}`;
		}

		return ret;
	}

	override parse(parser: Parser, list: TokensList): void {
		// Skipping DELETE.
		++list.idx;

		this.options = OptionsArray.parse(parser, list, DeleteStatement.OPTIONS);
		++list.idx;

		let state = 0;
		let multiTable = false;

		for (; list.idx < list.count; ++list.idx) {
			const token = list.tokens[list.idx];

			if (token.type === Token.TYPE_DELIMITER) {
				break;
			}

			if (state === 0) {
				if (token.type === Token.TYPE_KEYWORD) {
					if (token.keyword !== 'FROM') {
						parser.error('Unexpected keyword.', token);
						break;
					}

					// Skip FROM.
					++list.idx;
					this.from = ExpressionArray.parse(parser, list);

					state = 2;
				} else {
					this.columns = ExpressionArray.parse(parser, list);
					state = 1;
				}
			} else if (state === 1) {
				if (token.type !== Token.TYPE_KEYWORD) {
					parser.error('Unexpected token.', token);
					break;
				}

				if (token.keyword !== 'FROM') {
					parser.error('Unexpected keyword.', token);
					break;
				}

				++list.idx;
				this.from = ExpressionArray.parse(parser, list);

				state = 2;
			} else if (state === 2) {
				if (token.type === Token.TYPE_KEYWORD) {
					if (stripos(token.keyword ?? '', 'JOIN') !== false) {
						++list.idx;
						this.join = JoinKeyword.parse(parser, list);
						// Remain in state 2.
					} else if (token.keyword === 'USING') {
						++list.idx;
						this.using = ExpressionArray.parse(parser, list);
						state = 3;
						multiTable = true;
					} else if (token.keyword === 'WHERE') {
						++list.idx;
						this.where = Condition.parse(parser, list);
						state = 4;
					} else if (token.keyword === 'ORDER BY') {
						++list.idx;
						this.order = OrderKeyword.parse(parser, list);
						state = 5;
					} else if (token.keyword === 'LIMIT') {
						++list.idx;
						this.limit = Limit.parse(parser, list);
						state = 6;
					} else {
						parser.error('Unexpected keyword.', token);
						break;
					}
				}
			} else if (state === 3) {
				if (token.type !== Token.TYPE_KEYWORD) {
					parser.error('Unexpected token.', token);
					break;
				}

				if (token.keyword !== 'WHERE') {
					parser.error('Unexpected keyword.', token);
					break;
				}

				++list.idx;
				this.where = Condition.parse(parser, list);
				state = 4;
			} else if (state === 4) {
				if (multiTable && token.type === Token.TYPE_KEYWORD) {
					parser.error('This type of clause is not valid in Multi-table queries.', token);
					break;
				}

				if (token.type === Token.TYPE_KEYWORD) {
					if (token.keyword === 'ORDER BY') {
						++list.idx;
						this.order = OrderKeyword.parse(parser, list);
						state = 5;
					} else if (token.keyword === 'LIMIT') {
						++list.idx;
						this.limit = Limit.parse(parser, list);
						state = 6;
					} else {
						parser.error('Unexpected keyword.', token);
						break;
					}
				}
			} else if (state === 5 && token.type === Token.TYPE_KEYWORD) {
				if (token.keyword !== 'LIMIT') {
					parser.error('Unexpected keyword.', token);
					break;
				}

				++list.idx;
				this.limit = Limit.parse(parser, list);
				state = 6;
			}
		}

		if (state >= 2) {
			for (const fromExpr of this.from ?? []) {
				const expression = fromExpr as Expression;
				expression.database = expression.table;
				expression.table = expression.column;
				expression.column = null;
			}
		}

		--list.idx;
	}
}

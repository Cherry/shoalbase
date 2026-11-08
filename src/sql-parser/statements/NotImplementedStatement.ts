// Port of PhpMyAdmin\SqlParser\Statements\NotImplementedStatement: keeps the tokens of statements without a parser.
import { Statement } from '../Statement.ts';
import { Token } from '../Token.ts';

import type { Parser } from '../Parser.ts';
import type { TokensList } from '../TokensList.ts';

export class NotImplementedStatement extends Statement {
	declare unknown: Token[];

	protected override initProperties(): void {
		this.unknown = [];
	}

	override build(): string {
		// The parsed part of the query (if any), then the unknown tokens.
		let query = `${super.build()} `;
		for (const token of this.unknown) {
			query += token.token ?? '';
		}
		return query;
	}

	override parse(_parser: Parser, list: TokensList): void {
		for (; list.idx < list.count; ++list.idx) {
			if (list.tokens[list.idx].type === Token.TYPE_DELIMITER) {
				break;
			}
			this.unknown.push(list.tokens[list.idx]);
		}
	}
}

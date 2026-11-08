// Port of PhpMyAdmin\SqlParser\Statements\PurgeStatement: PURGE { BINARY | MASTER } LOGS { TO | BEFORE } expr.
import { Expression } from '../components/Expression.ts';
import { phpStr, phpTrim } from '../php.ts';
import { Statement } from '../Statement.ts';
import { Token } from '../Token.ts';

import type { Parser } from '../Parser.ts';
import type { TokensList } from '../TokensList.ts';

export class PurgeStatement extends Statement {
	private static parseExpectedKeyword(parser: Parser, token: Token, expectedKeywords: string[]): string | null {
		if (token.type === Token.TYPE_KEYWORD) {
			if (expectedKeywords.includes(token.keyword ?? '')) {
				return token.keyword;
			}
			parser.error('Unexpected keyword', token);
		} else {
			parser.error('Unexpected token.', token);
		}
		return null;
	}

	declare log_type: string | null;

	declare end_option: string | null;

	declare end_expr: Expression | null;

	protected override initProperties(): void {
		this.log_type = null;
		this.end_option = null;
		this.end_expr = null;
	}

	override build(): string {
		const end = this.end_option === null ? '' : `${this.end_option} ${phpStr(this.end_expr)}`;
		return phpTrim(`PURGE ${phpStr(this.log_type)} LOGS ${end}`);
	}

	override parse(parser: Parser, list: TokensList): void {
		// Skipping PURGE.
		++list.idx;

		let state = 0;
		let prevToken: Token | null = null;

		for (; list.idx < list.count; ++list.idx) {
			const token = list.tokens[list.idx];

			if (token.type === Token.TYPE_DELIMITER) {
				break;
			}

			if (token.type === Token.TYPE_WHITESPACE || token.type === Token.TYPE_COMMENT) {
				continue;
			}

			switch (state) {
				case 0: {
					this.log_type = PurgeStatement.parseExpectedKeyword(parser, token, ['BINARY', 'MASTER']);
					break;
				}
				case 1: {
					PurgeStatement.parseExpectedKeyword(parser, token, ['LOGS']);
					break;
				}
				case 2: {
					this.end_option = PurgeStatement.parseExpectedKeyword(parser, token, ['TO', 'BEFORE']);
					break;
				}
				case 3: {
					this.end_expr = Expression.parse(parser, list, {});
					break;
				}
				default: {
					parser.error('Unexpected token.', token);
					break;
				}
			}
			state++;
			prevToken = token;
		}

		// Only one possible end state.
		if (state === 4) {
			return;
		}

		parser.error('Unexpected token.', prevToken);
	}
}

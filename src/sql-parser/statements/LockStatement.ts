// Port of PhpMyAdmin\SqlParser\Statements\LockStatement: LOCK TABLES ... and UNLOCK TABLES.
import { LockExpression } from '../components/LockExpression.ts';
import { phpTrim } from '../php.ts';
import { Statement } from '../Statement.ts';
import { Token } from '../Token.ts';

import type { Parser } from '../Parser.ts';
import type { TokensList } from '../TokensList.ts';

export class LockStatement extends Statement {
	declare locked: LockExpression[];
	declare isLock: boolean;

	protected override initProperties(): void {
		this.locked = [];
		this.isLock = true;
	}

	override parse(parser: Parser, list: TokensList): void {
		if (list.tokens[list.idx]?.value === 'UNLOCK') {
			this.isLock = false;
		}

		// Skipping LOCK.
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

			if (state === 0) {
				if (token.type === Token.TYPE_KEYWORD) {
					if (token.keyword !== 'TABLES') {
						parser.error('Unexpected keyword.', token);
						break;
					}
					state = 1;
					continue;
				}
				parser.error('Unexpected token.', token);
				break;
			}

			if (state === 1) {
				if (!this.isLock) {
					// UNLOCK TABLES takes nothing more.
					parser.error('Unexpected token.', token);
					break;
				}
				this.locked.push(LockExpression.parse(parser, list));
				state = 2;
			} else if (state === 2 && token.value === ',') {
				// The next lock expression.
				state = 1;
			}

			prevToken = token;
		}

		if (state === 2 || prevToken === null) {
			return;
		}

		parser.error('Unexpected end of LOCK statement.', prevToken);
	}

	override build(): string {
		return phpTrim(`${this.isLock ? 'LOCK' : 'UNLOCK'} TABLES ${LockExpression.build(this.locked)}`);
	}
}

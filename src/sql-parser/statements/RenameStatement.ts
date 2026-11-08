// Port of PhpMyAdmin\SqlParser\Statements\RenameStatement.
import { RenameOperation } from '../components/RenameOperation.ts';
import { Statement } from '../Statement.ts';
import { Token } from '../Token.ts';

import type { Parser } from '../Parser.ts';
import type { TokensList } from '../TokensList.ts';

export class RenameStatement extends Statement {
	declare renames: RenameOperation[] | null;

	protected override initProperties(): void {
		this.renames = null;
	}

	/** Skips the TABLE keyword after RENAME. */
	override before(_parser: Parser, list: TokensList, token: Token): void {
		if (token.type !== Token.TYPE_KEYWORD || token.keyword !== 'RENAME') {
			return;
		}
		list.getNextOfTypeAndValue(Token.TYPE_KEYWORD, 'TABLE');
	}

	override build(): string {
		return `RENAME TABLE ${RenameOperation.build(this.renames)}`;
	}
}

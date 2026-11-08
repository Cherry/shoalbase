// Port of PhpMyAdmin\SqlParser\Statements\TruncateStatement.
import { phpStr } from '../php.ts';
import { Statement } from '../Statement.ts';

import type { Expression } from '../components/Expression.ts';
import type { OptionsSpec } from '../components/OptionsArray.ts';

export class TruncateStatement extends Statement {
	static override OPTIONS: OptionsSpec = { TABLE: 1 };

	declare table: Expression | null;

	protected override initProperties(): void {
		this.table = null;
	}

	override build(): string {
		return `TRUNCATE TABLE ${phpStr(this.table)};`;
	}
}

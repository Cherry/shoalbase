// Port of PhpMyAdmin\SqlParser\Statements\AnalyzeStatement.
import { Statement } from '../Statement.ts';

import type { Expression } from '../components/Expression.ts';
import type { OptionsSpec } from '../components/OptionsArray.ts';

export class AnalyzeStatement extends Statement {
	static override OPTIONS: OptionsSpec = {
		TABLE: 1,
		NO_WRITE_TO_BINLOG: 2,
		LOCAL: 3,
	};

	declare tables: Expression[] | null;

	protected override initProperties(): void {
		this.tables = null;
	}
}

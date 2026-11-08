// Port of PhpMyAdmin\SqlParser\Statements\DropStatement.
import { type Clauses, Statement } from '../Statement.ts';

import type { Expression } from '../components/Expression.ts';
import type { OptionsSpec } from '../components/OptionsArray.ts';

export class DropStatement extends Statement {
	static override OPTIONS: OptionsSpec = {
		'DATABASE': 1,
		'EVENT': 1,
		'FUNCTION': 1,
		'INDEX': 1,
		'LOGFILE': 1,
		'PROCEDURE': 1,
		'SCHEMA': 1,
		'SERVER': 1,
		'TABLE': 1,
		'VIEW': 1,
		'TABLESPACE': 1,
		'TRIGGER': 1,
		'USER': 1,
		'TEMPORARY': 2,
		'IF EXISTS': 3,
	};

	static override CLAUSES: Clauses = {
		DROP: ['DROP', 2],
		// Used for options.
		_OPTIONS: ['_OPTIONS', 1],
		// Used for select expressions.
		DROP_: ['DROP', 1],
		ON: ['ON', 3],
	};

	declare fields: Expression[] | null;
	declare table: Expression | null;

	protected override initProperties(): void {
		this.fields = null;
		this.table = null;
	}
}

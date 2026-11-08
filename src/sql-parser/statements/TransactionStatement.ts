// Port of PhpMyAdmin\SqlParser\Statements\TransactionStatement: BEGIN/START TRANSACTION ... COMMIT/ROLLBACK.
import { OptionsArray, type OptionsSpec } from '../components/OptionsArray.ts';
import { Statement } from '../Statement.ts';

import type { Parser } from '../Parser.ts';
import type { TokensList } from '../TokensList.ts';

export class TransactionStatement extends Statement {
	static readonly TYPE_BEGIN = 1;
	static readonly TYPE_END = 2;

	static override OPTIONS: OptionsSpec = {
		'START TRANSACTION': 1,
		'BEGIN': 1,
		'COMMIT': 1,
		'ROLLBACK': 1,
		'WITH CONSISTENT SNAPSHOT': 2,
		'WORK': 2,
		'AND NO CHAIN': 3,
		'AND CHAIN': 3,
		'RELEASE': 4,
		'NO RELEASE': 4,
	};

	declare type: number | null;
	/** The statements of the transaction, filled by the parser for a TYPE_BEGIN statement. */
	declare statements: Statement[] | null;
	declare end: TransactionStatement | null;

	protected override initProperties(): void {
		this.type = null;
		this.statements = null;
		this.end = null;
	}

	override parse(parser: Parser, list: TokensList): void {
		super.parse(parser, list);

		const options = this.options ?? new OptionsArray();
		if (options.has('START TRANSACTION') || options.has('BEGIN')) {
			this.type = TransactionStatement.TYPE_BEGIN;
		} else if (options.has('COMMIT') || options.has('ROLLBACK')) {
			this.type = TransactionStatement.TYPE_END;
		}
	}

	override build(): string {
		let ret = OptionsArray.build(this.options);
		if (this.type === TransactionStatement.TYPE_BEGIN) {
			for (const statement of this.statements ?? []) {
				ret += `;${statement.build()}`;
			}
			ret += ';';
			if (this.end !== null) {
				ret += this.end.build();
			}
		}
		return ret;
	}
}

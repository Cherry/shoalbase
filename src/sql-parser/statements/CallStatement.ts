// Port of PhpMyAdmin\SqlParser\Statements\CallStatement.
import { phpStr } from '../php.ts';
import { Statement } from '../Statement.ts';

import type { FunctionCall } from '../components/FunctionCall.ts';

export class CallStatement extends Statement {
	declare call: FunctionCall | null;

	protected override initProperties(): void {
		this.call = null;
	}

	override build(): string {
		const parameters = this.call?.parameters ? this.call.parameters.raw.join(',') : '';
		return `CALL ${phpStr(this.call?.name)}(${parameters})`;
	}
}

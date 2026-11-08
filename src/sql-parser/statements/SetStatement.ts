// Port of PhpMyAdmin\SqlParser\Statements\SetStatement.
import { OptionsArray, type OptionsSpec } from '../components/OptionsArray.ts';
import { SetOperation } from '../components/SetOperation.ts';
import { phpTrim } from '../php.ts';
import { type Clauses, Statement } from '../Statement.ts';

export class SetStatement extends Statement {
	static override CLAUSES: Clauses = {
		SET: ['SET', 3],
		_END_OPTIONS: ['_END_OPTIONS', 1],
	};

	static override OPTIONS: OptionsSpec = {
		'CHARSET': [3, 'var'],
		'CHARACTER SET': [3, 'var'],
		'NAMES': [3, 'var'],
		'PASSWORD': [3, 'expr'],
		'SESSION': 3,
		'GLOBAL': 3,
		'PERSIST': 3,
		'PERSIST_ONLY': 3,
		'@@SESSION': 3,
		'@@GLOBAL': 3,
		'@@PERSIST': 3,
		'@@PERSIST_ONLY': 3,
	};

	static override END_OPTIONS: OptionsSpec = {
		COLLATE: [1, 'var'],
		DEFAULT: 1,
	};

	declare end_options: OptionsArray | null;
	declare set: SetOperation[] | null;

	protected override initProperties(): void {
		this.end_options = null;
		this.set = null;
	}

	override isSetStatement(): boolean {
		return true;
	}

	override build(): string {
		// PHP builds a null SET list as " = " (both properties read from null).
		const assignments = this.set === null ? ' = ' : SetOperation.build(this.set);
		const ret = `SET ${OptionsArray.build(this.options)} ${assignments} ${OptionsArray.build(this.end_options)}`;
		return phpTrim(ret);
	}
}

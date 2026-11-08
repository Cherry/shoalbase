// Port of PhpMyAdmin\SqlParser\Components\WithKeyword: one named common table expression of WITH.
import { Component } from '../Component.ts';
import { Translator } from '../Translator.ts';
import { ArrayObj } from './ArrayObj.ts';

import type { Parser } from '../Parser.ts';

export class WithKeyword extends Component {
	/** Component::parse(): common table expressions are parsed by WithStatement. */
	static parse(): never {
		throw new Error(Translator.gettext('Not implemented yet.'));
	}

	static build(component: unknown): string {
		if (!(component instanceof this)) {
			throw new TypeError('Can not build a component that is not a WithKeyword');
		}

		if (component.statement === null) {
			throw new Error('No statement inside WITH');
		}

		let str = component.name;

		if (component.columns.length > 0) {
			str += ArrayObj.build(component.columns);
		}

		str += ' AS (';

		for (const statement of component.statement.statements) {
			str += statement.build();
		}

		str += ')';

		return str;
	}

	name: string;

	columns: ArrayObj[] = [];

	statement: Parser | null = null;

	constructor(name: string) {
		super();
		this.name = name;
	}
}

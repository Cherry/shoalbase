// Port of PhpMyAdmin\SqlParser\Statements\AlterStatement.
import { AlterOperation } from '../components/AlterOperation.ts';
import { Expression } from '../components/Expression.ts';
import { OptionsArray, type OptionsSpec } from '../components/OptionsArray.ts';
import { phpTrim } from '../php.ts';
import { Statement } from '../Statement.ts';
import { Token } from '../Token.ts';

import type { Parser } from '../Parser.ts';
import type { TokensList } from '../TokensList.ts';

export class AlterStatement extends Statement {
	static override OPTIONS: OptionsSpec = {
		ONLINE: 1,
		OFFLINE: 1,
		IGNORE: 2,
		// DEFINER is also used by ALTER EVENT.
		DEFINER: [2, 'expr='],
		DATABASE: 3,
		EVENT: 3,
		FUNCTION: 3,
		PROCEDURE: 3,
		SERVER: 3,
		TABLE: 3,
		TABLESPACE: 3,
		USER: 3,
		VIEW: 3,
	};

	declare table: Expression | null;
	declare altered: AlterOperation[];

	protected override initProperties(): void {
		this.table = null;
		this.altered = [];
	}

	override parse(parser: Parser, list: TokensList): void {
		// Skipping ALTER.
		++list.idx;
		const parsedOptions = OptionsArray.parse(parser, list, AlterStatement.OPTIONS);
		if (parsedOptions.isEmpty()) {
			parser.error('Unrecognized alter operation.', list.tokens[list.idx] ?? null);
			return;
		}
		this.options = parsedOptions;
		++list.idx;

		// The altered entity.
		this.table = Expression.parse(parser, list, { parseField: 'table', breakOnAlias: true });
		// Skipping the field.
		++list.idx;

		let state = 0;

		for (; list.idx < list.count; ++list.idx) {
			const token = list.tokens[list.idx];

			if (token.type === Token.TYPE_DELIMITER) {
				break;
			}

			if (token.type === Token.TYPE_WHITESPACE || token.type === Token.TYPE_COMMENT) {
				continue;
			}

			if (state === 0) {
				let options: OptionsSpec = {};
				if (this.options.has('DATABASE')) {
					options = AlterOperation.DB_OPTIONS;
				} else if (this.options.has('TABLE')) {
					options = AlterOperation.TABLE_OPTIONS;
				} else if (this.options.has('VIEW')) {
					options = AlterOperation.VIEW_OPTIONS;
				} else if (this.options.has('USER')) {
					options = AlterOperation.USER_OPTIONS;
				} else if (this.options.has('EVENT')) {
					options = AlterOperation.EVENT_OPTIONS;
				} else if (this.options.has('FUNCTION') || this.options.has('PROCEDURE')) {
					options = AlterOperation.ROUTINE_OPTIONS;
				}

				this.altered.push(AlterOperation.parse(parser, list, options));
				state = 1;
			} else if (state === 1 && token.type === Token.TYPE_OPERATOR && token.value === ',') {
				state = 0;
			}
		}
	}

	override build(): string {
		const tmp = this.altered.map(altered => AlterOperation.build(altered));

		return phpTrim(`ALTER ${OptionsArray.build(this.options)} ${Expression.build(this.table)} ${tmp.join(', ')}`);
	}
}

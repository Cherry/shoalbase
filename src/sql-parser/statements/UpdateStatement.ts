// Port of PhpMyAdmin\SqlParser\Statements\UpdateStatement.
import { KEYWORD_PARSERS } from '../parser-data.ts';
import { lookup } from '../php.ts';
import { type Clauses, Statement } from '../Statement.ts';

import type { CaseExpression } from '../components/CaseExpression.ts';
import type { Condition } from '../components/Condition.ts';
import type { Expression } from '../components/Expression.ts';
import type { JoinKeyword } from '../components/JoinKeyword.ts';
import type { Limit } from '../components/Limit.ts';
import type { OptionsSpec } from '../components/OptionsArray.ts';
import type { OrderKeyword } from '../components/OrderKeyword.ts';
import type { SetOperation } from '../components/SetOperation.ts';
import type { Parser } from '../Parser.ts';
import type { Token } from '../Token.ts';
import type { TokensList } from '../TokensList.ts';

export class UpdateStatement extends Statement {
	static override OPTIONS: OptionsSpec = {
		LOW_PRIORITY: 1,
		IGNORE: 2,
	};

	static override CLAUSES: Clauses = {
		'UPDATE': ['UPDATE', 2],
		// Used for options.
		'_OPTIONS': ['_OPTIONS', 1],
		// Used for updated tables.
		'_UPDATE': ['UPDATE', 1],
		'JOIN': ['JOIN', 1],
		'LEFT JOIN': ['LEFT JOIN', 1],
		'INNER JOIN': ['INNER JOIN', 1],
		'SET': ['SET', 3],
		'WHERE': ['WHERE', 3],
		'ORDER BY': ['ORDER BY', 3],
		'LIMIT': ['LIMIT', 3],
	};

	declare tables: (Expression | CaseExpression)[] | null;
	declare set: SetOperation[] | null;
	declare where: Condition[] | null;
	declare order: OrderKeyword[] | null;
	declare limit: Limit | null;
	declare join: JoinKeyword[] | null;

	protected override initProperties(): void {
		this.tables = null;
		this.set = null;
		this.where = null;
		this.order = null;
		this.limit = null;
		this.join = null;
	}

	/** A SET clause must have assignments. */
	override after(parser: Parser, list: TokensList, token: Token): void {
		const tokenValue = token.value;
		// PHP compares with `!== []`, so a SET that was never parsed (null) passes too.
		const setParsed = !Array.isArray(this.set) || this.set.length > 0;
		if (setParsed || lookup(KEYWORD_PARSERS, tokenValue)?.field !== 'set') {
			return;
		}

		parser.error('Missing assignment in SET operation.', list.tokens[list.idx] ?? null);
	}
}

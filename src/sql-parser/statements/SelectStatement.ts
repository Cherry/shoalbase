// Port of PhpMyAdmin\SqlParser\Statements\SelectStatement.
import { phpEmpty } from '../php.ts';
import { type Clauses, Statement } from '../Statement.ts';

import type { ArrayObj } from '../components/ArrayObj.ts';
import type { CaseExpression } from '../components/CaseExpression.ts';
import type { Condition } from '../components/Condition.ts';
import type { Expression } from '../components/Expression.ts';
import type { FunctionCall } from '../components/FunctionCall.ts';
import type { GroupKeyword } from '../components/GroupKeyword.ts';
import type { IndexHint } from '../components/IndexHint.ts';
import type { IntoKeyword } from '../components/IntoKeyword.ts';
import type { JoinKeyword } from '../components/JoinKeyword.ts';
import type { Limit } from '../components/Limit.ts';
import type { OptionsArray, OptionsSpec } from '../components/OptionsArray.ts';
import type { OrderKeyword } from '../components/OrderKeyword.ts';

export class SelectStatement extends Statement {
	static override OPTIONS: OptionsSpec = {
		ALL: 1,
		DISTINCT: 1,
		DISTINCTROW: 1,
		HIGH_PRIORITY: 2,
		MAX_STATEMENT_TIME: [3, 'var='],
		STRAIGHT_JOIN: 4,
		SQL_SMALL_RESULT: 5,
		SQL_BIG_RESULT: 6,
		SQL_BUFFER_RESULT: 7,
		SQL_CACHE: 8,
		SQL_NO_CACHE: 8,
		SQL_CALC_FOUND_ROWS: 9,
	};

	static override GROUP_OPTIONS: OptionsSpec = { 'WITH ROLLUP': 1 };

	static override END_OPTIONS: OptionsSpec = {
		'FOR UPDATE': 1,
		'LOCK IN SHARE MODE': 1,
	};

	static override CLAUSES: Clauses = {
		'SELECT': ['SELECT', 2],
		// Used for options.
		'_OPTIONS': ['_OPTIONS', 1],
		// Used for selected expressions.
		'_SELECT': ['SELECT', 1],
		'INTO': ['INTO', 3],
		'FROM': ['FROM', 3],
		'FORCE': ['FORCE', 1],
		'USE': ['USE', 1],
		'IGNORE': ['IGNORE', 3],
		'PARTITION': ['PARTITION', 3],
		'JOIN': ['JOIN', 1],
		'FULL JOIN': ['FULL JOIN', 1],
		'INNER JOIN': ['INNER JOIN', 1],
		'LEFT JOIN': ['LEFT JOIN', 1],
		'LEFT OUTER JOIN': ['LEFT OUTER JOIN', 1],
		'RIGHT JOIN': ['RIGHT JOIN', 1],
		'RIGHT OUTER JOIN': ['RIGHT OUTER JOIN', 1],
		'NATURAL JOIN': ['NATURAL JOIN', 1],
		'NATURAL LEFT JOIN': ['NATURAL LEFT JOIN', 1],
		'NATURAL RIGHT JOIN': ['NATURAL RIGHT JOIN', 1],
		'NATURAL LEFT OUTER JOIN': ['NATURAL LEFT OUTER JOIN', 1],
		'NATURAL RIGHT OUTER JOIN': ['NATURAL RIGHT JOIN', 1],
		'WHERE': ['WHERE', 3],
		'GROUP BY': ['GROUP BY', 3],
		'_GROUP_OPTIONS': ['_GROUP_OPTIONS', 1],
		'HAVING': ['HAVING', 3],
		'ORDER BY': ['ORDER BY', 3],
		'LIMIT': ['LIMIT', 3],
		'PROCEDURE': ['PROCEDURE', 3],
		'UNION': ['UNION', 1],
		'EXCEPT': ['EXCEPT', 1],
		'INTERSECT': ['INTERSECT', 1],
		'_END_OPTIONS': ['_END_OPTIONS', 1],
	};

	declare expr: (Expression | CaseExpression)[];
	declare from: Expression[];
	declare index_hints: IndexHint[] | null;
	declare partition: ArrayObj | null;
	declare where: Condition[] | null;
	declare group: GroupKeyword[] | null;
	declare group_options: OptionsArray | null;
	declare having: Condition[] | null;
	declare order: OrderKeyword[] | null;
	declare limit: Limit | null;
	declare procedure: FunctionCall | null;
	declare into: IntoKeyword | null;
	declare join: JoinKeyword[] | null;
	declare union: [string, SelectStatement][];
	declare end_options: OptionsArray | null;

	protected override initProperties(): void {
		this.expr = [];
		this.from = [];
		this.index_hints = null;
		this.partition = null;
		this.where = null;
		this.group = null;
		this.group_options = null;
		this.having = null;
		this.order = null;
		this.limit = null;
		this.procedure = null;
		this.into = null;
		this.join = null;
		this.union = [];
		this.end_options = null;
	}

	override isSelectStatement(): boolean {
		return true;
	}

	/** With UNION, the ORDER BY and LIMIT clauses move to the end of the statement. */
	override getClauses(): Clauses {
		if (!phpEmpty(this.union)) {
			const clauses: Clauses = { ...SelectStatement.CLAUSES };
			delete clauses['ORDER BY'];
			delete clauses.LIMIT;
			clauses['ORDER BY'] = ['ORDER BY', 3];
			clauses.LIMIT = ['LIMIT', 3];
			return clauses;
		}
		return (this.constructor as typeof SelectStatement).CLAUSES;
	}
}

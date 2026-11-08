// Port of PhpMyAdmin\SqlParser\Utils\Misc: the aliases of databases, tables and columns of a SELECT (used by export).
import { Expression } from '../components/Expression.ts';
import { phpEmpty, phpStr } from '../php.ts';
import { SelectStatement } from '../statements/SelectStatement.ts';

import type { Statement } from '../Statement.ts';
import type { TokenValue } from '../Token.ts';

/** Keys PHP auto-vivifies on write are optional. */
export interface TableAliases {
	alias?: TokenValue;
	columns: Record<string, TokenValue>;
}

export interface DatabaseAliases {
	alias?: null;
	tables: Record<string, TableAliases> | null;
}

/** PHP array keys are strings or integers; null becomes ''. */
function key(value: TokenValue): string {
	if (value === null || value === false) {
		return '';
	}
	if (value === true) {
		return '1';
	}
	return phpStr(value);
}

export const Misc = {
	/** Aliases by database, then table: [db => ['alias' => null, 'tables' => [table => ['alias', 'columns' => [col => alias]]]]]. */
	getAliases(statement: Statement | null, database: string): Record<string, DatabaseAliases> {
		if (!(statement instanceof SelectStatement) || phpEmpty(statement.expr) || phpEmpty(statement.from)) {
			return {};
		}

		const retval: Record<string, DatabaseAliases> = {};

		const tables: Record<string, Record<string, TokenValue>> = {};

		const expressions: unknown[] = [...statement.from];
		for (const join of statement.join ?? []) {
			expressions.push(join.expr);
		}

		for (const expr of expressions) {
			if (!(expr instanceof Expression) || expr.table === null || expr.table === '') {
				continue;
			}

			const thisDb = expr.database !== null && expr.database !== '' ? key(expr.database) : database;

			retval[thisDb] ??= {
				alias: null,
				tables: {},
			};

			const dbTables = (retval[thisDb].tables ??= {});
			dbTables[key(expr.table)] ??= {
				alias: expr.alias !== null && expr.alias !== '' ? expr.alias : null,
				columns: {},
			};

			tables[thisDb] ??= {};
			tables[thisDb][key(expr.alias)] = expr.table;
		}

		for (const expr of statement.expr) {
			if (!(expr instanceof Expression) || expr.column === null || expr.alias === null || expr.column === '' || expr.alias === '') {
				continue;
			}

			const thisDb = expr.database !== null && expr.database !== '' ? key(expr.database) : database;

			if (expr.table !== null && expr.table !== '') {
				const thisTable = key(tables[thisDb]?.[key(expr.table)] ?? expr.table);
				// Writing creates the missing levels, without their other keys.
				retval[thisDb] ??= { tables: {} };
				const dbTables = (retval[thisDb].tables ??= {});
				dbTables[thisTable] ??= { columns: {} };
				dbTables[thisTable].columns[key(expr.column)] = expr.alias;
			} else {
				// foreach by reference creates a null 'tables' entry when the database is missing.
				retval[thisDb] ??= { tables: null };
				for (const table of Object.values(retval[thisDb].tables ?? {})) {
					table.columns[key(expr.column)] = expr.alias;
				}
			}
		}

		return retval;
	},
};

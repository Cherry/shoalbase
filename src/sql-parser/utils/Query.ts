// Port of PhpMyAdmin\SqlParser\Utils\Query: statement flags, table lists and clause rewriting used by phpMyAdmin.
import { Expression } from '../components/Expression.ts';
import { Lexer } from '../Lexer.ts';
import { Parser } from '../Parser.ts';
import {
	inArrayLoose,
	member,
	phpEmpty,
	phpStr,
	phpTrim,
	strtoupper,
} from '../php.ts';
import { type Statement, getClauseStartOffset } from '../Statement.ts';
import { AlterStatement } from '../statements/AlterStatement.ts';
import { AnalyzeStatement } from '../statements/AnalyzeStatement.ts';
import { CallStatement } from '../statements/CallStatement.ts';
import { CheckStatement } from '../statements/CheckStatement.ts';
import { ChecksumStatement } from '../statements/ChecksumStatement.ts';
import { CreateStatement } from '../statements/CreateStatement.ts';
import { DeleteStatement } from '../statements/DeleteStatement.ts';
import { DropStatement } from '../statements/DropStatement.ts';
import { ExplainStatement } from '../statements/ExplainStatement.ts';
import { InsertStatement } from '../statements/InsertStatement.ts';
import { KillStatement } from '../statements/KillStatement.ts';
import { LoadStatement } from '../statements/LoadStatement.ts';
import { OptimizeStatement } from '../statements/OptimizeStatement.ts';
import { RenameStatement } from '../statements/RenameStatement.ts';
import { RepairStatement } from '../statements/RepairStatement.ts';
import { ReplaceStatement } from '../statements/ReplaceStatement.ts';
import { SelectStatement } from '../statements/SelectStatement.ts';
import { SetStatement } from '../statements/SetStatement.ts';
import { ShowStatement } from '../statements/ShowStatement.ts';
import { TruncateStatement } from '../statements/TruncateStatement.ts';
import { UpdateStatement } from '../statements/UpdateStatement.ts';
import { Token, type TokenValue } from '../Token.ts';

import type { TokensList } from '../TokensList.ts';

/** The flags of Query::$ALLFLAGS. */
export interface QueryFlags {
	distinct: boolean;
	drop_database: boolean;
	group: boolean;
	having: boolean;
	is_affected: boolean;
	is_analyse: boolean;
	is_count: boolean;
	is_delete: boolean;
	is_explain: boolean;
	is_export: boolean;
	is_func: boolean;
	is_group: boolean;
	is_insert: boolean;
	is_maint: boolean;
	is_procedure: boolean;
	is_replace: boolean;
	is_select: boolean;
	is_show: boolean;
	is_subquery: boolean;
	join: boolean;
	limit: boolean;
	offset: boolean;
	order: boolean;
	querytype: string | false;
	reload: boolean;
	select_from: boolean;
	union: boolean;
}

/** [table, database] as Query::getAll() reports selected tables. */
export type SelectTable = [TokenValue, TokenValue];

/** The result of Query::getAll(). */
export interface AnalyzedQuery extends QueryFlags {
	parser?: Parser;
	statement?: Statement;
	select_tables?: SelectTable[];
	select_expr?: (string | null)[];
}

type PartialFlags = Partial<QueryFlags> & { querytype: string | false; };

function allFlags(): QueryFlags {
	return {
		distinct: false,
		drop_database: false,
		group: false,
		having: false,
		is_affected: false,
		is_analyse: false,
		is_count: false,
		is_delete: false,
		is_explain: false,
		is_export: false,
		is_func: false,
		is_group: false,
		is_insert: false,
		is_maint: false,
		is_procedure: false,
		is_replace: false,
		is_select: false,
		is_show: false,
		is_subquery: false,
		join: false,
		limit: false,
		offset: false,
		order: false,
		querytype: false,
		reload: false,
		select_from: false,
		union: false,
	};
}

export class Query {
	static FUNCTIONS = ['SUM', 'AVG', 'STD', 'STDDEV', 'MIN', 'MAX', 'BIT_OR', 'BIT_AND'];

	static get ALLFLAGS(): QueryFlags {
		return allFlags();
	}

	private static getFlagsSelect<T extends PartialFlags>(statement: SelectStatement, flags: T): T {
		flags.querytype = 'SELECT';
		flags.is_select = true;

		if (!phpEmpty(statement.from)) {
			flags.select_from = true;
		}

		if (member(statement.options).has('DISTINCT')) {
			flags.distinct = true;
		}

		if (!phpEmpty(statement.group) || !phpEmpty(statement.having)) {
			flags.is_group = true;
		}

		if (statement.into !== null && statement.into.type === 'OUTFILE') {
			flags.is_export = true;
		}

		const expressions: unknown[] = [...statement.expr];
		for (const join of statement.join ?? []) {
			expressions.push(join.expr);
		}

		for (const expr of expressions) {
			const expression = expr as Partial<Expression> | null;
			if (!phpEmpty(expression?.function)) {
				const fn = strtoupper(phpStr(expression?.function));
				if (fn === 'COUNT') {
					flags.is_count = true;
				} else if (this.FUNCTIONS.includes(fn)) {
					flags.is_func = true;
				}
			}

			if (phpEmpty(expression?.subquery)) {
				continue;
			}

			flags.is_subquery = true;
		}

		if (statement.procedure !== null && statement.procedure.name === 'ANALYSE') {
			flags.is_analyse = true;
		}

		if (!phpEmpty(statement.group)) {
			flags.group = true;
		}

		if (!phpEmpty(statement.having)) {
			flags.having = true;
		}

		if (!phpEmpty(statement.union)) {
			flags.union = true;
		}

		if (!phpEmpty(statement.join)) {
			flags.join = true;
		}

		return flags;
	}

	/** The flags of a statement; with $all every flag of Query::$ALLFLAGS is present. */
	static getFlags(statement: Statement | null, all: true): QueryFlags;
	static getFlags(statement: Statement | null, all?: boolean): PartialFlags;
	static getFlags(statement: Statement | null, all = false): PartialFlags {
		let flags: PartialFlags = { querytype: false };
		if (all) {
			flags = allFlags();
		}

		if (statement instanceof AlterStatement) {
			flags.querytype = 'ALTER';
			flags.reload = true;
		} else if (statement instanceof CreateStatement) {
			flags.querytype = 'CREATE';
			flags.reload = true;
		} else if (statement instanceof AnalyzeStatement) {
			flags.querytype = 'ANALYZE';
			flags.is_maint = true;
		} else if (statement instanceof CheckStatement) {
			flags.querytype = 'CHECK';
			flags.is_maint = true;
		} else if (statement instanceof ChecksumStatement) {
			flags.querytype = 'CHECKSUM';
			flags.is_maint = true;
		} else if (statement instanceof OptimizeStatement) {
			flags.querytype = 'OPTIMIZE';
			flags.is_maint = true;
		} else if (statement instanceof RepairStatement) {
			flags.querytype = 'REPAIR';
			flags.is_maint = true;
		} else if (statement instanceof CallStatement) {
			flags.querytype = 'CALL';
			flags.is_procedure = true;
		} else if (statement instanceof DeleteStatement) {
			flags.querytype = 'DELETE';
			flags.is_delete = true;
			flags.is_affected = true;
		} else if (statement instanceof DropStatement) {
			flags.querytype = 'DROP';
			flags.reload = true;

			if (member(statement.options).has('DATABASE') || member(statement.options).has('SCHEMA')) {
				flags.drop_database = true;
			}
		} else if (statement instanceof ExplainStatement) {
			flags.querytype = 'EXPLAIN';
			flags.is_explain = true;
		} else if (statement instanceof InsertStatement) {
			flags.querytype = 'INSERT';
			flags.is_affected = true;
			flags.is_insert = true;
		} else if (statement instanceof LoadStatement) {
			flags.querytype = 'LOAD';
			flags.is_affected = true;
			flags.is_insert = true;
		} else if (statement instanceof ReplaceStatement) {
			flags.querytype = 'REPLACE';
			flags.is_affected = true;
			flags.is_replace = true;
			flags.is_insert = true;
		} else if (statement instanceof SelectStatement) {
			flags = this.getFlagsSelect(statement, flags);
		} else if (statement instanceof ShowStatement) {
			flags.querytype = 'SHOW';
			flags.is_show = true;
		} else if (statement instanceof UpdateStatement) {
			flags.querytype = 'UPDATE';
			flags.is_affected = true;
		} else if (statement instanceof SetStatement) {
			flags.querytype = 'SET';
		} else if (statement instanceof KillStatement) {
			flags.querytype = 'KILL';
		}

		if (statement instanceof SelectStatement || statement instanceof UpdateStatement || statement instanceof DeleteStatement) {
			if (!phpEmpty(statement.limit)) {
				flags.limit = true;
			}

			if (!phpEmpty(statement.order)) {
				flags.order = true;
			}
		}

		return flags;
	}

	/** Parses the query and reports its flags, the parser, the first statement and the selected tables. */
	static getAll(query: string): AnalyzedQuery {
		const parser = new Parser(query);

		const statement = parser.statements[0] as Statement | undefined;
		if (statement === undefined) {
			return this.getFlags(null, true);
		}

		const ret: AnalyzedQuery = this.getFlags(statement, true);

		ret.parser = parser;
		ret.statement = statement;

		if (statement instanceof SelectStatement) {
			const selectTables: SelectTable[] = [];
			const selectExpr: (string | null)[] = [];
			ret.select_tables = selectTables;
			ret.select_expr = selectExpr;

			// The real names of the table aliases.
			const tableAliases = new Map<string, SelectTable>();
			for (const expr of statement.from) {
				if (expr.table === null || expr.alias === null || expr.table === '' || expr.alias === '') {
					continue;
				}
				tableAliases.set(this.arrayKey(expr.alias), [expr.table, expr.database ?? null]);
			}

			// Tables can only be found in the SELECT clause when they are written explicitly (not for SELECT * FROM film).
			for (const expr of statement.expr) {
				const table = (expr as Partial<Expression>).table ?? null;
				if (table !== null && table !== '') {
					const database = (expr as Partial<Expression>).database ?? null;
					const arr: SelectTable = tableAliases.get(this.arrayKey(table))
						?? [table, database !== null && database !== '' ? database : null];

					if (!inArrayLoose(arr, selectTables)) {
						selectTables.push(arr);
					}
				} else {
					selectExpr.push(expr.expr);
				}
			}

			// Without tables in the SELECT clause (or with expressions like * or COUNT(*)), they come from FROM.
			if (selectTables.length === 0) {
				for (const expr of statement.from) {
					if (expr.table === null || expr.table === '') {
						continue;
					}

					const arr: SelectTable = [expr.table, expr.database !== null && expr.database !== '' ? expr.database : null];

					if (inArrayLoose(arr, selectTables)) {
						continue;
					}

					selectTables.push(arr);
				}
			}
		}

		return ret;
	}

	/** The tables a statement affects, built as identifiers. */
	static getTables(statement: Statement): string[] {
		let expressions: unknown[] = [];

		if (statement instanceof InsertStatement || statement instanceof ReplaceStatement) {
			expressions = [statement.into?.dest];
		} else if (statement instanceof UpdateStatement) {
			expressions = statement.tables ?? [];
		} else if (statement instanceof SelectStatement || statement instanceof DeleteStatement) {
			expressions = statement.from ?? [];
		} else if (statement instanceof AlterStatement || statement instanceof TruncateStatement) {
			expressions = [statement.table];
		} else if (statement instanceof DropStatement) {
			if (!member(statement.options).has('TABLE')) {
				// No tables are dropped.
				return [];
			}
			expressions = statement.fields ?? [];
		} else if (statement instanceof RenameStatement) {
			for (const rename of statement.renames ?? []) {
				expressions.push(rename.old);
			}
		}

		const ret: string[] = [];
		for (const expr of expressions) {
			if (!(expr instanceof Expression) || phpEmpty(expr.table)) {
				continue;
			}

			// Force a rebuild without the alias.
			expr.expr = null;
			expr.alias = null;
			ret.push(Expression.build(expr));
		}

		return ret;
	}

	/**
	 * The clause of a statement, or the clauses before (-1), after (1) or between it and another one.
	 */
	static getClause(statement: Statement, list: TokensList, clause: string, type: number | string = 0, skipFirst = true): string {
		let currIdx = 0;
		let brackets = 0;
		let ret = '';
		let skip = skipFirst;

		const clauses = statement.getClauseOrder();

		const lexer = new Lexer(clause);
		const clauseType = lexer.list.getNextOfType(Token.TYPE_KEYWORD)?.keyword ?? '';

		const clauseIdx = Object.hasOwn(clauses, clauseType) ? clauses[clauseType] : -1;

		let firstClauseIdx = clauseIdx;
		let lastClauseIdx = clauseIdx;

		if (type === -1) {
			// Something small enough.
			firstClauseIdx = -1;
			lastClauseIdx = clauseIdx - 1;
		} else if (type === 1) {
			firstClauseIdx = clauseIdx + 1;
			// Something big enough.
			lastClauseIdx = 10000;
		} else if (typeof type === 'string' && Object.hasOwn(clauses, type)) {
			if (clauses[type] > clauseIdx) {
				firstClauseIdx = clauseIdx + 1;
				lastClauseIdx = clauses[type] - 1;
			} else {
				firstClauseIdx = clauses[type] + 1;
				lastClauseIdx = clauseIdx - 1;
			}
		}

		// This option is unavailable for multiple clauses.
		if (type !== 0) {
			skip = false;
		}

		for (let i = statement.first ?? 0; i <= (statement.last ?? -1); ++i) {
			const token = list.tokens[i];
			if (token === undefined || token.type === Token.TYPE_COMMENT) {
				continue;
			}

			if (token.type === Token.TYPE_OPERATOR) {
				if (token.value === '(') {
					++brackets;
				} else if (token.value === ')') {
					--brackets;
				}
			}

			// Checking if the section was changed.
			if (
				brackets === 0
				&& token.type === Token.TYPE_KEYWORD
				&& Object.hasOwn(clauses, token.keyword ?? '')
				&& clauses[token.keyword ?? ''] >= currIdx
			) {
				currIdx = clauses[token.keyword ?? ''];
				if (skip && currIdx === clauseIdx) {
					// This token is replaced, so it is not added to the old clause.
					continue;
				}
			}

			if (firstClauseIdx > currIdx || currIdx > lastClauseIdx) {
				continue;
			}

			ret += token.token ?? '';
		}

		return phpTrim(ret);
	}

	/** Replaces a clause (or only its keyword with $onlyType) by another one. */
	static replaceClause(statement: Statement, list: TokensList, old: string, replacement: string | null = null, onlyType = false): string {
		const next = replacement ?? old;

		if (onlyType) {
			return `${this.getClause(statement, list, old, -1, false)} ${next} ${this.getClause(statement, list, old, 0)} ${this.getClause(statement, list, old, 1, false)}`;
		}

		return `${this.getClause(statement, list, old, -1, false)} ${next} ${this.getClause(statement, list, old, 1, false)}`;
	}

	/** Replaces several clauses, given in the order they appear in the statement as [old, new] pairs. */
	static replaceClauses(statement: Statement, list: TokensList, ops: [string, string][]): string {
		const count = ops.length;

		if (count === 0) {
			return '';
		}

		// One clause is what replaceClause() is for.
		if (count === 1) {
			return this.replaceClause(statement, list, ops[0][0], ops[0][1]);
		}

		// Everything before the first replacement.
		let ret = `${this.getClause(statement, list, ops[0][0], -1)} `;

		for (const [i, clause] of ops.entries()) {
			ret += `${clause[1]} `;

			// Everything between this replacement and the next one.
			if (i + 1 === count) {
				continue;
			}

			ret += `${this.getClause(statement, list, clause[0], ops[i + 1][0])} `;
		}

		// Everything after the last replacement.
		return ret + this.getClause(statement, list, ops[count - 1][0], 1);
	}

	/** [first statement, the rest of the query, delimiter]; the statement is null when none is complete. */
	static getFirstStatement(query: string, delimiter: string | null = null): [string | null, string, string | null] {
		const lexer = new Lexer(query, false, delimiter);
		const list = lexer.list;

		let currentDelimiter = delimiter;
		let fullStatement = false;
		let statement = '';

		for (list.idx = 0; list.idx < list.count; ++list.idx) {
			const token = list.tokens[list.idx];

			if (token.type === Token.TYPE_COMMENT) {
				continue;
			}

			statement += token.token ?? '';

			if (token.type === Token.TYPE_DELIMITER && !phpEmpty(token.token)) {
				currentDelimiter = token.token;
				fullStatement = true;
				break;
			}
		}

		// No statement was found, so the entire query remains.
		if (!fullStatement) {
			return [null, query, currentDelimiter];
		}

		// The rest of the query after the first statement.
		let rest = '';
		for (++list.idx; list.idx < list.count; ++list.idx) {
			rest += list.tokens[list.idx].token ?? '';
		}

		return [phpTrim(statement), rest, currentDelimiter];
	}

	static getClauseStartOffset(statement: Statement, list: TokensList, clause: string): number {
		return getClauseStartOffset(statement, list, clause);
	}

	/** PHP array keys: numeric strings become integers, other scalars are cast to strings. */
	private static arrayKey(value: TokenValue): string {
		if (value === true) {
			return '1';
		}
		if (value === false || value === null) {
			return '';
		}
		if (typeof value === 'number') {
			return String(Math.trunc(value));
		}
		return value;
	}
}

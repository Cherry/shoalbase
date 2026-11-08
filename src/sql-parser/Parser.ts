// Port of PhpMyAdmin\SqlParser\Parser: turns the token list into statements, handling unions and transactions.
import { Core } from './Core.ts';
import { ParserException } from './exceptions.ts';
import { Lexer } from './Lexer.ts';
import { KEYWORD_PARSERS, STATEMENT_PARSERS } from './parser-data.ts';
import { lookup, phpEmpty, strtoupper } from './php.ts';
import { statementClass } from './statements/index.ts';
import { SelectStatement } from './statements/SelectStatement.ts';
import { TransactionStatement } from './statements/TransactionStatement.ts';
import { Token } from './Token.ts';
import { TokensList } from './TokensList.ts';
import { Translator } from './Translator.ts';

import type { Statement } from './Statement.ts';

const UNION_KEYWORDS = new Set(['UNION', 'UNION ALL', 'UNION DISTINCT', 'EXCEPT', 'INTERSECT']);

export class Parser extends Core<ParserException> {
	static STATEMENT_PARSERS = STATEMENT_PARSERS;
	static KEYWORD_PARSERS = KEYWORD_PARSERS;

	list: TokensList = new TokensList();
	statements: Statement[] = [];
	/** The number of brackets opened before the statements. */
	brackets = 0;

	/** Parses a query string or an existing token list; without either nothing is parsed (a dummy parser for errors). */
	constructor(list: string | TokensList | null = null, strict = false) {
		super();
		if (typeof list === 'string') {
			this.list = new Lexer(list, strict).list;
		} else if (list instanceof TokensList) {
			this.list = list;
		}

		this.strict = strict;

		if (list === null) {
			return;
		}

		this.parse();
	}

	parse(): void {
		let lastTransaction: TransactionStatement | null = null;
		let lastStatement: Statement | null = null;
		let unionType: string | false = false;
		let prevLastIdx = -1;

		const list = this.list;

		for (; list.idx < list.count; ++list.idx) {
			const token = list.tokens[list.idx];

			// DELIMITER is not an actual statement and it requires special handling.
			if (token.type === Token.TYPE_NONE && strtoupper(token.token ?? '') === 'DELIMITER') {
				// Skipping to the end of this statement.
				list.getNextOfType(Token.TYPE_DELIMITER);
				prevLastIdx = list.idx;
				continue;
			}

			// Counting the brackets around statements.
			if (token.value === '(') {
				++this.brackets;
				continue;
			}

			// Statements can start with keywords only; comments, whitespaces, etc. are ignored.
			if (token.type !== Token.TYPE_KEYWORD) {
				if (
					token.type !== Token.TYPE_COMMENT
					&& token.type !== Token.TYPE_WHITESPACE
					// `(` and `)`
					&& token.type !== Token.TYPE_OPERATOR
					&& token.type !== Token.TYPE_DELIMITER
				) {
					this.error('Unexpected beginning of statement.', token);
				}
				continue;
			}

			if (UNION_KEYWORDS.has(token.keyword ?? '')) {
				unionType = token.keyword ?? false;
				continue;
			}

			const lastIdx = list.idx;
			let statementName: string | null = null;

			if (token.keyword === 'ANALYZE') {
				// Skip ANALYZE.
				++list.idx;

				const first = list.getNextOfType(Token.TYPE_KEYWORD);
				const second = list.getNextOfType(Token.TYPE_KEYWORD);

				// ANALYZE TABLE in MariaDB and MySQL, or MariaDB's EXPLAIN ANALYZE.
				statementName = 'EXPLAIN';
				if (first?.keyword === 'TABLE' || second?.keyword === 'TABLE') {
					statementName = 'ANALYZE';
				}

				list.idx = lastIdx;
			} else if (phpEmpty(lookup(STATEMENT_PARSERS, token.keyword))) {
				// A known statement type without a parser is recognized, but not parsed.
				if (lookup(STATEMENT_PARSERS, token.keyword) === undefined) {
					this.error('Unrecognized statement type.', token);
				}

				// Skipping to the end of this statement.
				list.getNextOfType(Token.TYPE_DELIMITER);
				prevLastIdx = list.idx;
				continue;
			}

			const className = lookup(STATEMENT_PARSERS, statementName ?? token.keyword) ?? '';
			const StatementClass = statementClass(className);
			const statement = new StatementClass(this, this.list);

			// The first token of the statement is the first one the previous statement did not process.
			statement.first = prevLastIdx + 1;

			// Storing the index of the last token parsed and updating the old index.
			statement.last = list.idx;
			prevLastIdx = list.idx;

			// Handles unions.
			if (unionType !== false && unionType !== '' && lastStatement instanceof SelectStatement && statement instanceof SelectStatement) {
				// The union is stored in the first statement and the second one is not added to the statements.
				lastStatement.union.push([unionType, statement]);

				// Without brackets, ORDER and LIMIT belong to the first statement.
				lastStatement.order = statement.order;
				lastStatement.limit = statement.limit;
				statement.order = [];
				statement.limit = null;

				// The statement ends where the last statement of the union ends.
				lastStatement.last = statement.last;

				unionType = false;

				statement.validateClauseOrder(this, list);
				continue;
			}

			// Handles transactions.
			if (statement instanceof TransactionStatement) {
				// Statements between BEGIN and COMMIT/ROLLBACK are stored in the transaction.
				if (statement.type === TransactionStatement.TYPE_BEGIN) {
					lastTransaction = statement;
					this.statements.push(statement);
				} else if (statement.type === TransactionStatement.TYPE_END) {
					if (lastTransaction === null) {
						// Even though an error occurred, the query is being saved.
						this.statements.push(statement);
						this.error('No transaction was previously started.', token);
					} else {
						lastTransaction.end = statement;
					}
					lastTransaction = null;
				}

				statement.validateClauseOrder(this, list);
				continue;
			}

			statement.validateClauseOrder(this, list);

			// Finally, storing the statement.
			if (lastTransaction === null) {
				this.statements.push(statement);
			} else {
				lastTransaction.statements ??= [];
				lastTransaction.statements.push(statement);
			}

			lastStatement = statement;
		}
	}

	error(msg: string, token: Token | null = null, code = 0): void {
		this.addError(new ParserException(Translator.gettext(msg), token, code));
	}
}

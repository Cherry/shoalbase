// Port of PhpMyAdmin\SqlParser\Statements\ExplainStatement: EXPLAIN/DESCRIBE of a statement, a connection or a table.
import { OptionsArray, type OptionsSpec } from '../components/OptionsArray.ts';
import { Context } from '../Context.ts';
import { Parser } from '../Parser.ts';
import { phpBool, phpStr } from '../php.ts';
import { Statement } from '../Statement.ts';
import { Token, type TokenValue } from '../Token.ts';
import { TokensList } from '../TokensList.ts';

const EXPLAINABLE = new Set(['SELECT', 'TABLE', 'INSERT', 'REPLACE', 'UPDATE', 'DELETE']);

export class ExplainStatement extends Statement {
	static override OPTIONS: OptionsSpec = {
		EXTENDED: 1,
		PARTITIONS: 1,
		FORMAT: [1, 'var'],
	};

	declare bodyParser: Parser | null;
	declare statementAlias: string | null;
	declare connectionId: TokenValue;
	declare explainedDatabase: TokenValue;
	declare explainedTable: TokenValue;
	declare explainedColumn: TokenValue;

	protected override initProperties(): void {
		this.bodyParser = null;
		this.statementAlias = null;
		this.connectionId = null;
		this.explainedDatabase = null;
		this.explainedTable = null;
		this.explainedColumn = null;
	}

	override parse(parser: Parser, list: TokensList): void {
		// 0: EXPLAIN/DESC/DESCRIBE/ANALYZE, 1: options, 2: the explained statement, 3: a table and a column.
		let state = 0;
		// 0: no keyword yet, 1: EXPLAIN/DESC/DESCRIBE, 2: followed by ANALYZE.
		let miniState = 0;

		for (; list.idx < list.count; ++list.idx) {
			const token = list.tokens[list.idx];

			if (token.type === Token.TYPE_DELIMITER) {
				// Back up one token.
				--list.idx;
				break;
			}

			if (token.type === Token.TYPE_WHITESPACE || token.type === Token.TYPE_COMMENT) {
				continue;
			}

			if (state === 0) {
				if (token.keyword === 'ANALYZE' && miniState === 0) {
					state = 1;
					this.statementAlias = 'ANALYZE';
				} else if (['EXPLAIN', 'DESC', 'DESCRIBE'].includes(token.keyword ?? '')) {
					this.statementAlias = token.keyword;

					let lastIdx = list.idx;
					// Ignore the current token.
					list.idx++;
					let nextKeyword = list.getNextOfType(Token.TYPE_KEYWORD);
					list.idx = lastIdx;

					// Without another keyword, a table is described.
					if (nextKeyword === null) {
						state = 3;
						continue;
					}

					miniState = 1;

					lastIdx = list.idx;
					nextKeyword = list.getNextOfTypeAndValue(Token.TYPE_KEYWORD, 'ANALYZE');
					if (nextKeyword && nextKeyword.keyword !== null) {
						miniState = 2;
						this.statementAlias += ' ANALYZE';
					} else {
						list.idx = lastIdx;
					}

					state = 1;
				}
			} else if (state === 1) {
				this.options = OptionsArray.parse(parser, list, ExplainStatement.OPTIONS);
				state = 2;
			} else if (state === 2) {
				const currIdx = list.idx;
				// Ignore the current token.
				list.idx++;
				let nextToken = list.getNext();
				list.idx = currIdx;

				if (token.keyword === 'FOR' && nextToken?.keyword === 'CONNECTION') {
					list.idx++;
					// CONNECTION
					list.getNext();
					// The connection identifier.
					nextToken = list.getNext();
					this.connectionId = nextToken?.value ?? null;
					break;
				}

				if (!EXPLAINABLE.has(token.keyword ?? '')) {
					parser.error('Unexpected token.', token);
					break;
				}

				// Every remaining token belongs to the explained statement.
				const idxOfLastParsedToken = list.count - 1;
				const subList = new TokensList(list.tokens.slice(list.idx));

				this.bodyParser = new Parser(subList);
				if (this.bodyParser.errors.length > 0) {
					parser.errors.push(...this.bodyParser.errors);
					break;
				}

				list.idx = idxOfLastParsedToken;
				break;
			} else if (state === 3) {
				if (token.type === Token.TYPE_OPERATOR && token.value === '.') {
					continue;
				}

				if (this.explainedDatabase === null) {
					const lastIdx = list.idx;
					const nextDot = list.getNextOfTypeAndValue(Token.TYPE_OPERATOR, '.');
					list.idx = lastIdx;
					// A dot follows, so this is a db.table name.
					if (nextDot !== null) {
						this.explainedDatabase = token.value;
						continue;
					}
				}

				if (this.explainedTable === null) {
					this.explainedTable = token.value;
					continue;
				}

				if (this.explainedColumn === null) {
					this.explainedColumn = token.value;
				}
			}
		}

		if (state !== 3 || this.explainedTable !== null) {
			return;
		}

		// State 3 ended without a table name.
		parser.error('Expected a table name.', list.tokens[list.idx] ?? null);
	}

	override build(): string {
		let str = phpStr(this.statementAlias);

		if (this.options !== null) {
			if (this.options.options.size > 0) {
				str += ' ';
			}
			str += `${OptionsArray.build(this.options)} `;
		}

		if (this.options === null) {
			str += ' ';
		}

		if (this.bodyParser) {
			for (const statement of this.bodyParser.statements) {
				str += statement.build();
			}
		} else if (phpBool(this.connectionId)) {
			str += `FOR CONNECTION ${phpStr(this.connectionId)}`;
		}

		if (this.explainedDatabase !== null && this.explainedTable !== null) {
			str += `${Context.escape(this.explainedDatabase)}.${Context.escape(this.explainedTable)}`;
		} else if (this.explainedTable !== null) {
			str += Context.escape(this.explainedTable);
		}

		if (this.explainedColumn !== null) {
			str += ` ${Context.escape(this.explainedColumn)}`;
		}

		return str;
	}
}

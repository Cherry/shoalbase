// Port of PhpMyAdmin\SqlParser\Statements\WithStatement: WITH [RECURSIVE] cte AS (...)[, ...] followed by a statement.
import { Array2d } from '../components/Array2d.ts';
import { OptionsArray, type OptionsSpec } from '../components/OptionsArray.ts';
import { WithKeyword } from '../components/WithKeyword.ts';
import { ParserException } from '../exceptions.ts';
import { Parser } from '../Parser.ts';
import { phpStr } from '../php.ts';
import { type Clauses, Statement } from '../Statement.ts';
import { Token } from '../Token.ts';
import { TokensList } from '../TokensList.ts';
import { Translator } from '../Translator.ts';

const STATEMENT_KEYWORDS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE']);

export class WithStatement extends Statement {
	static override OPTIONS: OptionsSpec = { RECURSIVE: 1 };

	static override CLAUSES: Clauses = {
		WITH: ['WITH', 2],
		// Used for options.
		_OPTIONS: ['_OPTIONS', 1],
		AS: ['AS', 2],
	};

	/** The common table expressions by name, in the order they were written. */
	declare withers: Map<string, WithKeyword>;

	declare cteStatementParser: Parser | null;

	/** The tokens of the parenthesised subquery, or an error when the closing bracket is missing. */
	private getSubTokenList(list: TokensList): TokensList | ParserException {
		const idx = list.idx;
		let token: Token | undefined = list.tokens[list.idx];
		let openParenthesis = 0;

		while (list.idx < list.count) {
			if (token?.value === '(') {
				++openParenthesis;
			} else if (token?.value === ')' && --openParenthesis === -1) {
				break;
			}

			++list.idx;
			if (list.tokens[list.idx] === undefined) {
				break;
			}

			token = list.tokens[list.idx];
		}

		// Returning the error avoids a try/catch in the loop.
		if (list.idx === list.count) {
			--list.idx;
			return new ParserException(Translator.gettext('A closing bracket was expected.'), token ?? null);
		}

		const length = list.idx - idx;
		return new TokensList(list.tokens.slice(idx, idx + length), length);
	}

	protected override initProperties(): void {
		this.withers = new Map();
		this.cteStatementParser = null;
	}

	override parse(parser: Parser, list: TokensList): void {
		// 0: name, 1: columns or AS, 2: AS after columns, 3: subquery, 4: comma or the final statement, 5: done.
		let state = 0;
		let wither = '';

		// Skipping WITH.
		++list.idx;

		this.options = OptionsArray.parse(parser, list, WithStatement.OPTIONS);
		++list.idx;

		for (; list.idx < list.count; ++list.idx) {
			const token = list.tokens[list.idx];

			if (token.type === Token.TYPE_WHITESPACE || token.type === Token.TYPE_COMMENT) {
				continue;
			}

			if (state === 0) {
				if (token.type !== Token.TYPE_NONE || !/^[\w$]+$/.test(token.token ?? '')) {
					parser.error('The name of the CTE was expected.', token);
					break;
				}

				wither = phpStr(token.value);
				this.withers.set(wither, new WithKeyword(wither));
				state = 1;
			} else if (state === 1) {
				if (token.type === Token.TYPE_OPERATOR && token.value === '(') {
					const columns = Array2d.parse(parser, list);
					if (parser.errors.length > 0) {
						break;
					}
					const keyword = this.withers.get(wither);
					if (keyword) {
						keyword.columns = columns;
					}
					state = 2;
				} else if (token.type === Token.TYPE_KEYWORD && token.keyword === 'AS') {
					state = 3;
				} else {
					parser.error('Unexpected token.', token);
					break;
				}
			} else if (state === 2) {
				if (!(token.type === Token.TYPE_KEYWORD && token.keyword === 'AS')) {
					parser.error('AS keyword was expected.', token);
					break;
				}
				state = 3;
			} else if (state === 3) {
				const idxBeforeGetNext = list.idx;
				// Ignore the current token.
				list.idx++;
				const nextKeyword = list.getNext();

				if (!(token.value === '(' && nextKeyword && nextKeyword.value === 'SELECT')) {
					parser.error('Subquery of the CTE was expected.', token);
					list.idx = idxBeforeGetNext;
					break;
				}

				// Restore the index.
				list.idx = idxBeforeGetNext;

				++list.idx;
				const subList = this.getSubTokenList(list);
				if (subList instanceof ParserException) {
					parser.errors.push(subList);
					break;
				}

				const subParser = new Parser(subList);

				if (subParser.errors.length > 0) {
					parser.errors.push(...subParser.errors);
					break;
				}

				const keyword = this.withers.get(wither);
				if (keyword) {
					keyword.statement = subParser;
				}

				state = 4;
			} else if (state === 4) {
				if (token.value === ',') {
					// Another WITH expression follows.
					state = 0;
					continue;
				}

				if (token.type === Token.TYPE_KEYWORD && STATEMENT_KEYWORDS.has(phpStr(token.value))) {
					state = 5;
					--list.idx;
					continue;
				}

				parser.error('An expression was expected.', token);
				break;
			} else if (state === 5) {
				// By default every remaining token belongs to the final statement.
				let idxOfLastParsedToken = list.count - 1;

				const idxBeforeSearch = list.idx;
				// Null means the sub list goes to the end of the list.
				let lengthOfExpressionTokens: number | null = null;

				if (list.getNextOfTypeAndValue(Token.TYPE_KEYWORD, 'ON')) {
					// getNextOfTypeAndValue() returned ON and moved past it.
					const idxOfOn = list.idx - 1;
					// It must be ON DUPLICATE KEY UPDATE.
					const duplicateToken = list.getNext();
					const keyToken = list.getNext();
					const updateToken = list.getNext();
					if (duplicateToken?.keyword === 'DUPLICATE' && keyToken?.keyword === 'KEY' && updateToken?.keyword === 'UPDATE') {
						// The final statement ends before ON.
						idxOfLastParsedToken = idxOfOn - 1;
						lengthOfExpressionTokens = idxOfOn - idxBeforeSearch;
					}
				}

				list.idx = idxBeforeSearch;

				const end = lengthOfExpressionTokens === null ? undefined : list.idx + lengthOfExpressionTokens;
				const subList = new TokensList(list.tokens.slice(list.idx, end));
				const subParser = new Parser(subList);
				if (subParser.errors.length > 0) {
					parser.errors.push(...subParser.errors);
					break;
				}

				this.cteStatementParser = subParser;

				list.idx = idxOfLastParsedToken;
				break;
			}
		}

		// 5 is the only valid end state.
		if (state !== 5) {
			parser.error('Unexpected end of the WITH CTE.', list.tokens[list.idx] ?? null);
		}

		--list.idx;
	}

	override build(): string {
		let initial = true;
		let str = 'WITH';

		if (this.options !== null && this.options.options.size > 0) {
			str += ` ${OptionsArray.build(this.options)}`;
		}

		for (const wither of this.withers.values()) {
			str += initial ? ' ' : ', ';
			str += WithKeyword.build(wither);
			initial = false;
		}

		str += ' ';

		if (this.cteStatementParser) {
			for (const statement of this.cteStatementParser.statements) {
				str += statement.build();
			}
		}

		return str;
	}
}

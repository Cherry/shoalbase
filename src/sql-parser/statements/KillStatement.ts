// Port of PhpMyAdmin\SqlParser\Statements\KillStatement.
import { OptionsArray, type OptionsSpec } from '../components/OptionsArray.ts';
import { Parser } from '../Parser.ts';
import { phpStr } from '../php.ts';
import { Statement } from '../Statement.ts';
import { Token, type TokenValue } from '../Token.ts';
import { TokensList } from '../TokensList.ts';

export class KillStatement extends Statement {
	static override OPTIONS: OptionsSpec = {
		HARD: 1,
		SOFT: 1,
		CONNECTION: 2,
		QUERY: 2,
		USER: 2,
	};

	/** The connection id, or the SELECT statement that computes it. */
	declare identifier: TokenValue | Statement;
	declare idKeywordUsed: boolean;
	declare parenthesisUsed: boolean;

	protected override initProperties(): void {
		this.identifier = null;
		this.idKeywordUsed = false;
		this.parenthesisUsed = false;
	}

	override parse(parser: Parser, list: TokensList): void {
		let state = 0;

		// Skipping KILL.
		++list.idx;
		this.options = OptionsArray.parse(parser, list, KillStatement.OPTIONS);
		++list.idx;

		for (; list.idx < list.count; ++list.idx) {
			const token = list.tokens[list.idx];

			if (token.type === Token.TYPE_WHITESPACE || token.type === Token.TYPE_COMMENT) {
				continue;
			}

			if (state === 0) {
				const currIdx = list.idx;
				const prev = list.getPreviousOfType(Token.TYPE_KEYWORD);
				list.idx = currIdx;
				if (token.type === Token.TYPE_NUMBER && Token.isIntValue(token)) {
					this.identifier = token.value;
					state = 2;
				} else if (token.type === Token.TYPE_OPERATOR && token.value === '(') {
					this.parenthesisUsed = true;
					state = 3;
				} else if (prev && token.value === 'ID' && prev.value === 'QUERY') {
					this.idKeywordUsed = true;
					state = 0;
				} else {
					parser.error('Unexpected token.', token);
					break;
				}
			} else if (state === 3) {
				if (token.type === Token.TYPE_KEYWORD && token.value === 'SELECT') {
					const subList = new TokensList(list.tokens.slice(list.idx - 1));
					const subParser = new Parser(subList);
					if (subParser.errors.length > 0) {
						// The errors are kept and parsing goes on.
						parser.errors.push(...subParser.errors);
					} else {
						this.identifier = subParser.statements[0] ?? null;
						state = 2;
					}
				} else if (token.type === Token.TYPE_OPERATOR && token.value === ')') {
					state = 2;
				} else if (token.type === Token.TYPE_NUMBER && Token.isIntValue(token)) {
					this.identifier = token.value;
					state = 3;
				} else {
					parser.error('Unexpected token.', token);
					break;
				}
			}
		}

		if (state !== 2) {
			parser.error('Unexpected end of the KILL statement.', list.tokens[list.idx] ?? null);
		}

		--list.idx;
	}

	override build(): string {
		let ret = 'KILL';

		if (this.options !== null && this.options.options.size > 0) {
			ret += ` ${OptionsArray.build(this.options)}`;
		}

		if (this.idKeywordUsed) {
			ret += ' ID';
		}

		const identifier = this.identifier instanceof Statement ? this.identifier.build() : phpStr(this.identifier);
		if (this.parenthesisUsed) {
			ret += ` (${identifier})`;
		} else {
			ret += ` ${identifier}`;
		}

		return ret;
	}
}

// Port of PhpMyAdmin\SqlParser\Statements\LoadStatement: LOAD DATA ... INFILE ... INTO TABLE ...
import { ArrayObj } from '../components/ArrayObj.ts';
import { Expression } from '../components/Expression.ts';
import { ExpressionArray } from '../components/ExpressionArray.ts';
import { OptionsArray, type OptionsSpec } from '../components/OptionsArray.ts';
import { SetOperation } from '../components/SetOperation.ts';
import { phpStr, phpTrim } from '../php.ts';
import { Statement } from '../Statement.ts';
import { Token } from '../Token.ts';

import type { CaseExpression } from '../components/CaseExpression.ts';
import type { Parser } from '../Parser.ts';
import type { TokensList } from '../TokensList.ts';

export class LoadStatement extends Statement {
	static override OPTIONS: OptionsSpec = {
		LOW_PRIORITY: 1,
		CONCURRENT: 1,
		LOCAL: 2,
	};

	static FIELDS_OPTIONS: OptionsSpec = {
		'TERMINATED BY': [1, 'expr'],
		'OPTIONALLY': 2,
		'ENCLOSED BY': [3, 'expr'],
		'ESCAPED BY': [4, 'expr'],
	};

	static LINES_OPTIONS: OptionsSpec = {
		'STARTING BY': [1, 'expr'],
		'TERMINATED BY': [2, 'expr'],
	};

	declare file_name: Expression | null;
	declare table: Expression | null;
	declare partition: ArrayObj | null;
	declare charset_name: Expression | null;
	declare fields_options: OptionsArray | null;
	declare fields_keyword: string | null;
	declare lines_options: OptionsArray | null;
	declare col_name_or_user_var: (Expression | CaseExpression)[] | null;
	declare set: SetOperation[] | null;
	declare ignore_number: Expression | null;
	declare replace_ignore: string | null;
	declare lines_rows: string | null;

	protected override initProperties(): void {
		this.file_name = null;
		this.table = null;
		this.partition = null;
		this.charset_name = null;
		this.fields_options = null;
		this.fields_keyword = null;
		this.lines_options = null;
		this.col_name_or_user_var = null;
		this.set = null;
		this.ignore_number = null;
		this.replace_ignore = null;
		this.lines_rows = null;
	}

	override build(): string {
		let ret = `LOAD DATA ${phpStr(this.options)} INFILE ${phpStr(this.file_name)}`;

		if (this.replace_ignore !== null) {
			ret += ` ${phpTrim(this.replace_ignore)}`;
		}

		ret += ` INTO TABLE ${phpStr(this.table)}`;

		if (this.partition !== null && phpStr(this.partition).length > 0) {
			ret += ` PARTITION ${ArrayObj.build(this.partition)}`;
		}

		if (this.charset_name !== null) {
			ret += ` CHARACTER SET ${phpStr(this.charset_name)}`;
		}

		if (this.fields_keyword !== null) {
			ret += ` ${this.fields_keyword} ${phpStr(this.fields_options)}`;
		}

		if (this.lines_options !== null && phpStr(this.lines_options).length > 0) {
			ret += ` LINES ${phpStr(this.lines_options)}`;
		}

		if (this.ignore_number !== null) {
			ret += ` IGNORE ${phpStr(this.ignore_number)} ${phpStr(this.lines_rows)}`;
		}

		if (this.col_name_or_user_var !== null && this.col_name_or_user_var.length > 0) {
			ret += ` ${ExpressionArray.build(this.col_name_or_user_var)}`;
		}

		if (this.set !== null && this.set.length > 0) {
			ret += ` SET ${SetOperation.build(this.set)}`;
		}

		return ret;
	}

	override parse(parser: Parser, list: TokensList): void {
		// Skipping LOAD DATA.
		++list.idx;

		this.options = OptionsArray.parse(parser, list, LoadStatement.OPTIONS);
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
				if (token.type === Token.TYPE_KEYWORD && token.keyword !== 'INFILE') {
					parser.error('Unexpected keyword.', token);
					break;
				}

				if (token.type !== Token.TYPE_KEYWORD) {
					parser.error('Unexpected token.', token);
					break;
				}

				++list.idx;
				this.file_name = Expression.parse(parser, list, { parseField: 'file' });
				state = 1;
			} else if (state === 1) {
				if (token.type === Token.TYPE_KEYWORD) {
					if (token.keyword === 'REPLACE' || token.keyword === 'IGNORE') {
						this.replace_ignore = phpTrim(token.keyword);
					} else if (token.keyword === 'INTO') {
						state = 2;
					}
				}
			} else if (state === 2) {
				if (token.type !== Token.TYPE_KEYWORD || token.keyword !== 'TABLE') {
					parser.error('Unexpected token.', token);
					break;
				}

				++list.idx;
				this.table = Expression.parse(parser, list, { parseField: 'table', breakOnAlias: true });
				state = 3;
			} else if (state >= 3 && state <= 7) {
				if (token.type === Token.TYPE_KEYWORD) {
					const newState = this.parseKeywordsAccordingToState(parser, list, state);
					if (newState === state) {
						// Avoid an infinite loop.
						break;
					}
				} else if (token.type === Token.TYPE_OPERATOR && token.token === '(') {
					this.col_name_or_user_var = ExpressionArray.parse(parser, list);
					state = 7;
				} else {
					parser.error('Unexpected token.', token);
					break;
				}
			}
		}

		--list.idx;
	}

	parseFileOptions(parser: Parser, list: TokensList, keyword: unknown = 'FIELDS'): void {
		++list.idx;

		if (keyword === 'FIELDS' || keyword === 'COLUMNS') {
			this.fields_options = OptionsArray.parse(parser, list, LoadStatement.FIELDS_OPTIONS);
			this.fields_keyword = keyword;
		} else {
			this.lines_options = OptionsArray.parse(parser, list, LoadStatement.LINES_OPTIONS);
		}
	}

	/** The clauses after the table, each allowed only after the previous ones (the switch falls through in PHP). */
	parseKeywordsAccordingToState(parser: Parser, list: TokensList, state: number): number {
		const token = list.tokens[list.idx];

		if (state <= 3 && token.keyword === 'PARTITION') {
			++list.idx;
			this.partition = ArrayObj.parse(parser, list) as ArrayObj;
			return 4;
		}

		if (state <= 4 && token.keyword === 'CHARACTER SET') {
			++list.idx;
			this.charset_name = Expression.parse(parser, list);
			return 5;
		}

		if (state <= 5 && ['FIELDS', 'COLUMNS', 'LINES'].includes(token.keyword ?? '')) {
			this.parseFileOptions(parser, list, token.value);
			return 6;
		}

		if (state <= 6 && token.keyword === 'IGNORE') {
			++list.idx;

			this.ignore_number = Expression.parse(parser, list);
			const nextToken = list.getNextOfType(Token.TYPE_KEYWORD);

			if (nextToken?.type === Token.TYPE_KEYWORD && (nextToken.keyword === 'LINES' || nextToken.keyword === 'ROWS')) {
				this.lines_rows = nextToken.token;
			}

			return 7;
		}

		if (state <= 7 && token.keyword === 'SET') {
			++list.idx;
			this.set = SetOperation.parse(parser, list);
			return 8;
		}

		return state;
	}
}

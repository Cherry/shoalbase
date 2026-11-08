// Port of PhpMyAdmin\SqlParser\Components\IntoKeyword: INTO a table (INSERT/REPLACE), variables or OUTFILE with its options.
import { Component, type ComponentOptions } from '../Component.ts';
import { phpEmpty, phpStr, phpTrim } from '../php.ts';
import { Token, type TokenValue } from '../Token.ts';
import { ArrayObj } from './ArrayObj.ts';
import { Expression } from './Expression.ts';
import { ExpressionArray } from './ExpressionArray.ts';
import { OptionsArray, type OptionsSpec } from './OptionsArray.ts';

import type { CaseExpression } from './CaseExpression.ts';
import type { Parser } from '../Parser.ts';
import type { TokensList } from '../TokensList.ts';

export class IntoKeyword extends Component {
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

	static parse(parser: Parser, list: TokensList, options: ComponentOptions = {}): IntoKeyword {
		const ret = new this();

		let state = 0;

		for (; list.idx < list.count; ++list.idx) {
			const token = list.tokens[list.idx];

			if (token.type === Token.TYPE_DELIMITER) {
				break;
			}

			if (token.type === Token.TYPE_WHITESPACE || token.type === Token.TYPE_COMMENT) {
				continue;
			}

			if (token.type === Token.TYPE_KEYWORD && (token.flags & Token.FLAG_KEYWORD_RESERVED)) {
				if (state === 0 && token.keyword === 'OUTFILE') {
					ret.type = 'OUTFILE';
					state = 2;
					continue;
				}

				// No other keyword is expected, except LINES in state 4.
				if (state !== 4) {
					break;
				}
			}

			if (state === 0) {
				if (options.fromInsert || options.fromReplace) {
					ret.dest = Expression.parse(parser, list, { parseField: 'table', breakOnAlias: true });
				} else {
					ret.values = ExpressionArray.parse(parser, list);
				}
				state = 1;
			} else if (state === 1) {
				if (token.type === Token.TYPE_OPERATOR && token.value === '(') {
					ret.columns = (ArrayObj.parse(parser, list) as ArrayObj).values;
					++list.idx;
				}
				break;
			} else if (state === 2) {
				ret.dest = token.value;
				state = 3;
			} else if (state === 3) {
				ret.parseFileOptions(parser, list, token.keyword);
				state = 4;
			} else if (state === 4) {
				if (token.type === Token.TYPE_KEYWORD && token.keyword !== 'LINES') {
					break;
				}
				ret.parseFileOptions(parser, list, token.keyword);
				state = 5;
			}
		}

		--list.idx;
		return ret;
	}

	static build(component: IntoKeyword): string {
		if (component.dest instanceof Expression) {
			const columns = phpEmpty(component.columns) ? '' : `(\`${(component.columns ?? []).join('`, `')}\`)`;
			return phpStr(component.dest) + columns;
		}

		if (component.values !== null) {
			return ExpressionArray.build(component.values);
		}

		let ret = `OUTFILE "${phpStr(component.dest)}"`;

		const fieldsOptionsString = OptionsArray.build(component.fields_options);
		if (phpTrim(fieldsOptionsString) !== '') {
			ret += component.fields_keyword ? ' FIELDS' : ' COLUMNS';
			ret += ` ${fieldsOptionsString}`;
		}

		const linesOptionsString = OptionsArray.build(component.lines_options);
		if (phpTrim(linesOptionsString) !== '') {
			ret += ` LINES ${linesOptionsString}`;
		}

		return ret;
	}

	type: string | null;

	dest: Expression | TokenValue;

	columns: string[] | null;

	values: (Expression | CaseExpression)[] | null;

	fields_options: OptionsArray | null;

	fields_keyword: boolean | null;

	lines_options: OptionsArray | null = null;

	constructor(
		type: string | null = null,
		dest: Expression | TokenValue = null,
		columns: string[] | null = null,
		values: (Expression | CaseExpression)[] | null = null,
		fieldsOptions: OptionsArray | null = null,
		fieldsKeyword: boolean | null = null,
	) {
		super();
		this.type = type;
		this.dest = dest;
		this.columns = columns;
		this.values = values;
		this.fields_options = fieldsOptions;
		this.fields_keyword = fieldsKeyword;
	}

	parseFileOptions(parser: Parser, list: TokensList, keyword: string | null = 'FIELDS'): void {
		++list.idx;

		if (keyword === 'FIELDS' || keyword === 'COLUMNS') {
			this.fields_options = OptionsArray.parse(parser, list, IntoKeyword.FIELDS_OPTIONS);
			this.fields_keyword = keyword === 'FIELDS';
		} else {
			this.lines_options = OptionsArray.parse(parser, list, IntoKeyword.LINES_OPTIONS);
		}
	}
}

// Port of PhpMyAdmin\SqlParser\Components\AlterOperation: one operation of an ALTER statement.
import { Component } from '../Component.ts';
import { STATEMENT_PARSERS } from '../parser-data.ts';
import {
	inArrayLoose,
	phpEmpty,
	phpStr,
	phpTrim,
} from '../php.ts';
import { Token } from '../Token.ts';
import { TokensList } from '../TokensList.ts';
import { ArrayObj } from './ArrayObj.ts';
import { Expression } from './Expression.ts';
import { OptionsArray, type OptionsSpec } from './OptionsArray.ts';
import { PartitionDefinition } from './PartitionDefinition.ts';

import type { Parser } from '../Parser.ts';

// Options that apply to a table as well as to a column definition.
const COLUMN_DEFINITION_KEYWORDS = ['AUTO_INCREMENT', 'COMMENT', 'DEFAULT', 'CHARACTER SET', 'COLLATE', 'PRIMARY', 'UNIQUE', 'PRIMARY KEY', 'UNIQUE KEY'];

export class AlterOperation extends Component {
	static DB_OPTIONS: OptionsSpec = {
		'CHARACTER SET': [1, 'var'],
		'CHARSET': [1, 'var'],
		'DEFAULT CHARACTER SET': [1, 'var'],
		'DEFAULT CHARSET': [1, 'var'],
		'UPGRADE': [1, 'var'],
		'COLLATE': [2, 'var'],
		'DEFAULT COLLATE': [2, 'var'],
	};

	static TABLE_OPTIONS: OptionsSpec = {
		'ENGINE': [1, 'var='],
		'ALGORITHM': [1, 'var='],
		'AUTO_INCREMENT': [1, 'var='],
		'AVG_ROW_LENGTH': [1, 'var'],
		'COALESCE PARTITION': [1, 'var'],
		'LOCK': [1, 'var='],
		'MAX_ROWS': [1, 'var'],
		'ROW_FORMAT': [1, 'var'],
		'COMMENT': [1, 'var'],
		'ADD': 1,
		'ALTER': 1,
		'ANALYZE': 1,
		'CHANGE': 1,
		'CHARSET': 1,
		'CHECK': 1,
		'CONVERT': 1,
		'DEFAULT CHARSET': 1,
		'DISABLE': 1,
		'DISCARD': 1,
		'DROP': 1,
		'ENABLE': 1,
		'IMPORT': 1,
		'MODIFY': 1,
		'OPTIMIZE': 1,
		'ORDER': 1,
		'REBUILD': 1,
		'REMOVE': 1,
		'RENAME': 1,
		'REORGANIZE': 1,
		'REPAIR': 1,
		'UPGRADE': 1,
		'COLUMN': 2,
		'CONSTRAINT': 2,
		'DEFAULT': 2,
		'BY': 2,
		'FOREIGN': 2,
		'FULLTEXT': 2,
		'KEY': [2, 'var'],
		'KEYS': 2,
		'PARTITION': 2,
		'PARTITION BY': 2,
		'PARTITIONING': 2,
		'PRIMARY KEY': 2,
		'SPATIAL': 2,
		'TABLESPACE': 2,
		'INDEX': [2, 'var'],
		'UNIQUE': 2,
		'UNIQUE KEY': 2,
		'CHARACTER SET': 3,
		'TO': [3, 'var'],
	};

	static USER_OPTIONS: OptionsSpec = {
		'ATTRIBUTE': [1, 'var'],
		'COMMENT': [1, 'var'],
		'REQUIRE': [1, 'var'],
		'IDENTIFIED VIA': [2, 'var'],
		'IDENTIFIED WITH': [2, 'var'],
		'PASSWORD': [2, 'var'],
		'WITH': [2, 'var'],
		'BY': [4, 'expr'],
		'ACCOUNT': 1,
		'DEFAULT': 1,
		'LOCK': 2,
		'UNLOCK': 2,
		'IDENTIFIED': 3,
	};

	static VIEW_OPTIONS: OptionsSpec = { AS: 1 };

	static EVENT_OPTIONS: OptionsSpec = {
		'ON SCHEDULE': 1,
		'EVERY': [2, 'expr'],
		'AT': [2, 'expr'],
		'STARTS': [3, 'expr'],
		'ENDS': [4, 'expr'],
		'ON COMPLETION PRESERVE': 5,
		'ON COMPLETION NOT PRESERVE': 5,
		'RENAME': 6,
		'TO': [7, 'expr', { parseField: 'table', breakOnAlias: true }],
		'ENABLE': 8,
		'DISABLE': 8,
		'DISABLE ON SLAVE': 8,
		'COMMENT': [9, 'var'],
		'DO': 10,
	};

	static ROUTINE_OPTIONS: OptionsSpec = {
		'COMMENT': [1, 'var'],
		'LANGUAGE SQL': 2,
		'CONTAINS SQL': 3,
		'NO SQL': 3,
		'READS SQL DATA': 3,
		'MODIFIES SQL DATA': 3,
		'SQL SECURITY': 4,
		'DEFINER': 5,
		'INVOKER': 5,
	};

	static parse(parser: Parser, list: TokensList, options: OptionsSpec = {}): AlterOperation {
		const ret = new this();
		const ops = (): OptionsArray => ret.options ?? new OptionsArray();

		let brackets = 0;
		let state = 0;
		let partitionState = 0;

		for (; list.idx < list.count; ++list.idx) {
			const token = list.tokens[list.idx];

			if (token.type === Token.TYPE_DELIMITER) {
				break;
			}

			if (token.type === Token.TYPE_COMMENT) {
				continue;
			}

			// Whitespaces are kept while parsing the unknown part so nothing breaks.
			if (token.type === Token.TYPE_WHITESPACE && state === 2) {
				ret.unknown.push(token);
				continue;
			}

			if (state === 0) {
				ret.options = OptionsArray.parse(parser, list, options);

				// Aliases and event bodies define their own statements, so their tokens are only listed.
				if (ret.options.has('AS') || ret.options.has('DO')) {
					for (; list.idx < list.count; ++list.idx) {
						if (list.tokens[list.idx].type === Token.TYPE_DELIMITER) {
							break;
						}
						ret.unknown.push(list.tokens[list.idx]);
					}
					break;
				}

				state = 1;
				if (ret.options.has('PARTITION') || token.value === 'PARTITION BY') {
					state = 3;
					// To check whether it is PARTITION or PARTITION BY.
					list.getPrevious();
				}
			} else if (state === 1) {
				ret.field = Expression.parse(parser, list, { breakOnAlias: true, parseField: 'column' });
				if (ret.field === null) {
					// No field was read, so the same token is parsed again in state 2.
					--list.idx;
				}

				// RENAME COLUMN: the options are parsed again to get the new name.
				if (ops().has('RENAME') && ops().has('COLUMN')) {
					const nextOptions = OptionsArray.parse(parser, list, options);
					ops().merge(nextOptions);
				}

				state = 2;
			} else if (state === 2) {
				const arrayKey = typeof token.value === 'string' || (typeof token.value === 'number' && Token.isIntValue(token))
					? token.value
					: token.token;

				if (token.type === Token.TYPE_OPERATOR) {
					if (token.value === '(') {
						++brackets;
					} else if (token.value === ')') {
						--brackets;
					} else if (token.value === ',' && brackets === 0) {
						break;
					}
				} else if (!this.checkIfTokenQuotedSymbol(token) && token.type !== Token.TYPE_STRING && token.value !== 'CHECK') {
					const key = phpStr(arrayKey);
					if (Object.hasOwn(STATEMENT_PARSERS, key) && STATEMENT_PARSERS[key] !== '') {
						// Ignore the current token.
						list.idx++;
						const nextToken = list.getNext();

						if (token.value === 'SET' && nextToken !== null && nextToken.value === '(') {
							// Keeps the tokens between the SET() parentheses out of the unknown tokens.
							list.getNextOfTypeAndValue(Token.TYPE_OPERATOR, ')');
						} else if (token.value === 'SET' && nextToken !== null && nextToken.value === 'DEFAULT') {
							// Keeps the DEFAULT token out of the unknown tokens.
							++list.idx;
						} else {
							// A new statement started without a delimiter.
							parser.error('A new statement was found, but no delimiter between it and the previous one.', token);
							break;
						}
					} else if (
						(Object.hasOwn(this.DB_OPTIONS, key) || Object.hasOwn(this.TABLE_OPTIONS, key))
						&& !inArrayLoose(arrayKey, COLUMN_DEFINITION_KEYWORDS)
					) {
						// A comma was missing before this new alter operation.
						parser.error('Missing comma before start of a new alter operation.', token);
						break;
					}
				}

				ret.unknown.push(token);
			} else if (state === 3) {
				if (partitionState === 0) {
					// Ignore the current token.
					list.idx++;
					const nextToken = list.getNext();
					if (
						token.type === Token.TYPE_KEYWORD
						&& (token.keyword === 'PARTITION BY' || (token.keyword === 'PARTITION' && nextToken && nextToken.value !== '('))
					) {
						partitionState = 1;
					} else if (token.type === Token.TYPE_KEYWORD && token.keyword === 'PARTITION') {
						partitionState = 2;
					}

					// Reverting the effect of getNext().
					--list.idx;
					list.getPrevious();
					list.getPrevious();
					++list.idx;
				} else if (partitionState === 1) {
					// Peek at the next token without moving, so whitespaces stay in the field.
					const currIdx = list.idx;
					++list.idx;
					const nextToken = list.getNext();
					list.idx = currIdx;

					if (phpEmpty(ret.field)) {
						ret.field = '';
					}

					if (token.type === Token.TYPE_OPERATOR && token.value === '(' && nextToken && nextToken.keyword === 'PARTITION') {
						partitionState = 2;
						// The current token is "(" and ArrayObj::parse() needs to start on it.
						--list.idx;
					} else {
						ret.field = phpStr(ret.field) + (token.type === Token.TYPE_WHITESPACE ? ' ' : token.token ?? '');
					}
				} else if (partitionState === 2) {
					ret.partitions = ArrayObj.parse(parser, list, { type: PartitionDefinition }) as PartitionDefinition[];
				}
			}
		}

		if (ops().isEmpty()) {
			parser.error('Unrecognized alter operation.', list.tokens[list.idx] ?? null);
		}

		--list.idx;
		return ret;
	}

	static build(component: AlterOperation): string {
		const options = component.options ?? new OptionsArray();

		// RENAME COLUMN puts the field between two groups of options.
		let afterFieldsOptions = new OptionsArray();
		if (options.has('RENAME') && options.has('COLUMN')) {
			afterFieldsOptions = options.clone();
			afterFieldsOptions.remove('RENAME');
			afterFieldsOptions.remove('COLUMN');
			options.remove('TO');
		}

		let ret = `${phpStr(component.options)} `;
		if (component.field !== null && component.field !== '') {
			ret += `${phpStr(component.field)} `;
		}

		ret += phpStr(afterFieldsOptions) + TokensList.build(component.unknown);

		if (component.partitions !== null) {
			ret += PartitionDefinition.build(component.partitions);
		}

		return phpTrim(ret);
	}

	private static checkIfTokenQuotedSymbol(token: Token): boolean {
		return token.type === Token.TYPE_SYMBOL && token.flags === Token.FLAG_SYMBOL_BACKTICK;
	}

	options: OptionsArray | null;

	field: Expression | string | null;

	partitions: PartitionDefinition[] | null;

	unknown: Token[];

	constructor(options: OptionsArray | null = null, field: Expression | string | null = null, partitions: PartitionDefinition[] | null = null, unknown: Token[] = []) {
		super();
		this.partitions = partitions;
		this.options = options;
		this.field = field;
		this.unknown = unknown;
	}
}

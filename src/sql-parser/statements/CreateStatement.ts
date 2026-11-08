// Port of PhpMyAdmin\SqlParser\Statements\CreateStatement: CREATE DATABASE/TABLE/VIEW/TRIGGER/PROCEDURE/FUNCTION/...
import { ArrayObj } from '../components/ArrayObj.ts';
import { CreateDefinition } from '../components/CreateDefinition.ts';
import { DataType } from '../components/DataType.ts';
import { Expression } from '../components/Expression.ts';
import { OptionsArray, type OptionsSpec } from '../components/OptionsArray.ts';
import { ParameterDefinition } from '../components/ParameterDefinition.ts';
import { PartitionDefinition } from '../components/PartitionDefinition.ts';
import { phpEmpty, phpStr, phpTrim } from '../php.ts';
import { Statement } from '../Statement.ts';
import { Token, type TokenValue } from '../Token.ts';
import { TokensList } from '../TokensList.ts';
import { SelectStatement } from './SelectStatement.ts';
import { WithStatement } from './WithStatement.ts';

import type { Parser } from '../Parser.ts';

type PartitionField = 'partitionBy' | 'subpartitionBy';

export class CreateStatement extends Statement {
	static override OPTIONS: OptionsSpec = {
		// CREATE TABLE
		'TEMPORARY': 1,
		// CREATE VIEW
		'OR REPLACE': 2,
		'ALGORITHM': [3, 'var='],
		// DEFINER is also used by CREATE FUNCTION / PROCEDURE.
		'DEFINER': [4, 'expr='],
		// Used in CREATE VIEW.
		'SQL SECURITY': [5, 'var'],
		'DATABASE': 6,
		'EVENT': 6,
		'FUNCTION': 6,
		'INDEX': 6,
		'UNIQUE INDEX': 6,
		'FULLTEXT INDEX': 6,
		'SPATIAL INDEX': 6,
		'PROCEDURE': 6,
		'SERVER': 6,
		'TABLE': 6,
		'TABLESPACE': 6,
		'TRIGGER': 6,
		'USER': 6,
		'VIEW': 6,
		'SCHEMA': 6,
		// CREATE TABLE
		'IF NOT EXISTS': 7,
	};

	static DB_OPTIONS: OptionsSpec = {
		'CHARACTER SET': [1, 'var='],
		'CHARSET': [1, 'var='],
		'DEFAULT CHARACTER SET': [1, 'var='],
		'DEFAULT CHARSET': [1, 'var='],
		'DEFAULT COLLATE': [2, 'var='],
		'COLLATE': [2, 'var='],
	};

	static TABLE_OPTIONS: OptionsSpec = {
		'ENGINE': [1, 'var='],
		'AUTO_INCREMENT': [2, 'var='],
		'AVG_ROW_LENGTH': [3, 'var'],
		'CHARACTER SET': [4, 'var='],
		'CHARSET': [4, 'var='],
		'DEFAULT CHARACTER SET': [4, 'var='],
		'DEFAULT CHARSET': [4, 'var='],
		'CHECKSUM': [5, 'var'],
		'DEFAULT COLLATE': [6, 'var='],
		'COLLATE': [6, 'var='],
		'COMMENT': [7, 'var='],
		'CONNECTION': [8, 'var'],
		'DATA DIRECTORY': [9, 'var'],
		'DELAY_KEY_WRITE': [10, 'var'],
		'INDEX DIRECTORY': [11, 'var'],
		'INSERT_METHOD': [12, 'var'],
		'KEY_BLOCK_SIZE': [13, 'var'],
		'MAX_ROWS': [14, 'var'],
		'MIN_ROWS': [15, 'var'],
		'PACK_KEYS': [16, 'var'],
		'PASSWORD': [17, 'var'],
		'ROW_FORMAT': [18, 'var'],
		'TABLESPACE': [19, 'var'],
		'STORAGE': [20, 'var'],
		'UNION': [21, 'var'],
		'PAGE_COMPRESSED': [22, 'var'],
		'PAGE_COMPRESSION_LEVEL': [23, 'var'],
	};

	static FUNC_OPTIONS: OptionsSpec = {
		'NOT': [2, 'var'],
		'FUNCTION': [3, 'var='],
		'PROCEDURE': [3, 'var='],
		'CONTAINS SQL': 4,
		'NO SQL': 4,
		'READS SQL DATA': 4,
		'MODIFIES SQL DATA': 4,
		'SQL SECURITY': [6, 'var'],
		'LANGUAGE': [7, 'var'],
		'COMMENT': [8, 'var'],
		'CREATE': 1,
		'DETERMINISTIC': 2,
	};

	static TRIGGER_OPTIONS: OptionsSpec = {
		BEFORE: 1,
		AFTER: 1,
		INSERT: 2,
		UPDATE: 2,
		DELETE: 2,
	};

	declare name: Expression | null;

	declare entityOptions: OptionsArray | null;

	declare fields: CreateDefinition[] | ArrayObj | null;

	declare with: WithStatement | null;

	declare select: SelectStatement | null;

	declare like: Expression | null;

	declare partitionBy: string | null;

	declare partitionsNum: TokenValue;

	declare subpartitionBy: string | null;

	declare subpartitionsNum: TokenValue;

	declare partitions: PartitionDefinition[] | null;

	declare table: Expression | null;

	declare return: DataType | null;

	declare parameters: ParameterDefinition[] | null;

	declare body: Token[];

	private collectBody(list: TokensList): void {
		for (; list.idx < list.count; ++list.idx) {
			const token = list.tokens[list.idx];
			if (token.type === Token.TYPE_DELIMITER) {
				break;
			}
			this.body.push(token);
		}
	}

	/** Handles PARTITION BY, PARTITIONS, SUBPARTITION BY, SUBPARTITIONS and the partition definitions. */
	private parsePartitions(parser: Parser, list: TokensList): void {
		let field: PartitionField | null = null;
		// False until a bracket is found, because at least one is required.
		let brackets: number | false = false;

		for (; list.idx < list.count; ++list.idx) {
			const token = list.tokens[list.idx];

			if (token.type === Token.TYPE_DELIMITER) {
				break;
			}

			if (token.type === Token.TYPE_COMMENT) {
				continue;
			}

			if (token.type === Token.TYPE_KEYWORD && token.keyword === 'PARTITION BY') {
				field = 'partitionBy';
				brackets = false;
			} else if (token.type === Token.TYPE_KEYWORD && token.keyword === 'SUBPARTITION BY') {
				field = 'subpartitionBy';
				brackets = false;
			} else if (token.type === Token.TYPE_KEYWORD && token.keyword === 'PARTITIONS') {
				const number = list.getNextOfType(Token.TYPE_NUMBER);
				// getNextOfType() also advances one position.
				--list.idx;
				this.partitionsNum = number?.value ?? null;
			} else if (token.type === Token.TYPE_KEYWORD && token.keyword === 'SUBPARTITIONS') {
				const number = list.getNextOfType(Token.TYPE_NUMBER);
				--list.idx;
				this.subpartitionsNum = number?.value ?? null;
			} else if (field !== null) {
				// The content of PARTITION BY and SUBPARTITION BY.
				if (token.type === Token.TYPE_OPERATOR) {
					if (token.value === '(') {
						brackets = (brackets === false ? 0 : brackets) + 1;
					} else if (token.value === ')' && brackets !== false) {
						// Decrementing false has no effect in PHP.
						--brackets;
					}
				}

				this[field] = phpStr(this[field]) + (token.type === Token.TYPE_WHITESPACE ? ' ' : token.token ?? '');

				// The last bracket was read, so the expression ended.
				if (brackets === 0) {
					this[field] = phpTrim(phpStr(this[field]));
					field = null;
				}
			} else if (token.type === Token.TYPE_OPERATOR && token.value === '(') {
				if (!phpEmpty(this.partitionBy)) {
					this.partitions = ArrayObj.parse(parser, list, { type: PartitionDefinition }) as PartitionDefinition[];
				}
				break;
			}
		}
	}

	protected override initProperties(): void {
		this.name = null;
		this.entityOptions = null;
		this.fields = null;
		this.with = null;
		this.select = null;
		this.like = null;
		this.partitionBy = null;
		this.partitionsNum = null;
		this.subpartitionBy = null;
		this.subpartitionsNum = null;
		this.partitions = null;
		this.table = null;
		this.return = null;
		this.parameters = null;
		this.body = [];
	}

	override build(): string {
		const options = this.options ?? new OptionsArray();
		let fields = '';
		if (!phpEmpty(this.fields)) {
			if (Array.isArray(this.fields)) {
				fields = `${CreateDefinition.build(this.fields)} `;
			} else if (this.fields instanceof ArrayObj) {
				fields = ArrayObj.build(this.fields);
			}
		}

		const head = `CREATE ${OptionsArray.build(this.options)} ${Expression.build(this.name)} `;

		if (options.has('DATABASE') || options.has('SCHEMA')) {
			return head + OptionsArray.build(this.entityOptions);
		}

		if (options.has('TABLE')) {
			if (this.select !== null) {
				return head + this.select.build();
			}

			if (this.like !== null) {
				return `CREATE ${OptionsArray.build(this.options)} ${Expression.build(this.name)} LIKE ${Expression.build(this.like)}`;
			}

			if (this.with !== null) {
				return head + this.with.build();
			}

			let partition = '';

			if (!phpEmpty(this.partitionBy)) {
				partition += `\nPARTITION BY ${phpStr(this.partitionBy)}`;
			}

			if (!phpEmpty(this.partitionsNum)) {
				partition += `\nPARTITIONS ${phpStr(this.partitionsNum)}`;
			}

			if (!phpEmpty(this.subpartitionBy)) {
				partition += `\nSUBPARTITION BY ${phpStr(this.subpartitionBy)}`;
			}

			if (!phpEmpty(this.subpartitionsNum)) {
				partition += `\nSUBPARTITIONS ${phpStr(this.subpartitionsNum)}`;
			}

			if (!phpEmpty(this.partitions)) {
				partition += `\n${PartitionDefinition.build(this.partitions ?? [])}`;
			}

			return head + fields + OptionsArray.build(this.entityOptions) + partition;
		}

		if (options.has('VIEW')) {
			let builtStatement = '';
			if (this.select !== null) {
				builtStatement = this.select.build();
			} else if (this.with !== null) {
				builtStatement = this.with.build();
			}

			const body = this.body.length > 0 ? TokensList.build(this.body) : '';
			return `${head}${fields} AS ${builtStatement}${body} ${OptionsArray.build(this.entityOptions)}`;
		}

		if (options.has('TRIGGER')) {
			return `${head}${OptionsArray.build(this.entityOptions)} ON ${Expression.build(this.table)} FOR EACH ROW ${TokensList.build(this.body)}`;
		}

		if (options.has('PROCEDURE') || options.has('FUNCTION')) {
			let tmp = '';
			if (options.has('FUNCTION')) {
				tmp = `RETURNS ${DataType.build(this.return)}`;
			}

			return `${head}${ParameterDefinition.build(this.parameters ?? [])} ${tmp} ${OptionsArray.build(this.entityOptions)} ${TokensList.build(this.body)}`;
		}

		return head + TokensList.build(this.body);
	}

	override parse(parser: Parser, list: TokensList): void {
		// Skipping CREATE.
		++list.idx;

		this.options = OptionsArray.parse(parser, list, CreateStatement.OPTIONS);
		// Skipping the last option.
		++list.idx;

		const isDatabase = Boolean(this.options.has('DATABASE')) || Boolean(this.options.has('SCHEMA'));
		const fieldName = isDatabase ? 'database' : 'table';

		this.name = Expression.parse(parser, list, { parseField: fieldName, breakOnAlias: true });

		if (this.name === null) {
			parser.error('The name of the entity was expected.', list.tokens[list.idx] ?? null);
		} else {
			// Skipping the field.
			++list.idx;
		}

		let token = list.tokens[list.idx] as Token | undefined;
		let nextidx = list.idx + 1;
		while (nextidx < list.count && list.tokens[nextidx].type === Token.TYPE_WHITESPACE) {
			++nextidx;
		}

		if (isDatabase) {
			this.entityOptions = OptionsArray.parse(parser, list, CreateStatement.DB_OPTIONS);
		} else if (this.options.has('TABLE')) {
			const next = list.tokens[nextidx] as Token | undefined;
			if (token?.type === Token.TYPE_KEYWORD && token.keyword === 'SELECT') {
				// CREATE TABLE ... SELECT
				this.select = new SelectStatement(parser, list);
			} else if (token?.type === Token.TYPE_KEYWORD && token.keyword === 'WITH') {
				// CREATE TABLE WITH
				this.with = new WithStatement(parser, list);
			} else if (token?.type === Token.TYPE_KEYWORD && token.keyword === 'AS' && next?.type === Token.TYPE_KEYWORD) {
				if (next.value === 'SELECT') {
					// CREATE TABLE ... AS SELECT
					list.idx = nextidx;
					this.select = new SelectStatement(parser, list);
				} else if (next.value === 'WITH') {
					// CREATE TABLE WITH
					list.idx = nextidx;
					this.with = new WithStatement(parser, list);
				}
			} else if (token?.type === Token.TYPE_KEYWORD && token.keyword === 'LIKE') {
				// CREATE TABLE `new_tbl` LIKE 'orig_tbl'
				list.idx = nextidx;
				this.like = Expression.parse(parser, list, { parseField: 'table', breakOnAlias: true });
				// The LIKE keyword was found without a table name after it.
				if (this.like === null) {
					parser.error('A table name was expected.', list.tokens[list.idx] ?? null);
				}
			} else {
				this.fields = CreateDefinition.parse(parser, list);
				if (phpEmpty(this.fields)) {
					parser.error('At least one column definition was expected.', list.tokens[list.idx] ?? null);
				}

				++list.idx;

				this.entityOptions = OptionsArray.parse(parser, list, CreateStatement.TABLE_OPTIONS);
				this.parsePartitions(parser, list);
			}
		} else if (this.options.has('PROCEDURE') || this.options.has('FUNCTION')) {
			this.parameters = ParameterDefinition.parse(parser, list);
			if (this.options.has('FUNCTION')) {
				const prevToken = token ?? null;
				token = list.getNextOfType(Token.TYPE_KEYWORD) ?? undefined;
				if (token === undefined || token.keyword !== 'RETURNS') {
					parser.error('A "RETURNS" keyword was expected.', token ?? prevToken);
				} else {
					++list.idx;
					this.return = DataType.parse(parser, list);
				}
			}

			++list.idx;

			this.entityOptions = OptionsArray.parse(parser, list, CreateStatement.FUNC_OPTIONS);
			++list.idx;

			this.collectBody(list);
		} else if (this.options.has('VIEW')) {
			// Skipping whitespaces and comments.
			const first = list.getNext();

			// Parsing the columns list.
			if (first?.type === Token.TYPE_OPERATOR && first.value === '(') {
				// getNext() also moved forward one token.
				--list.idx;
				this.fields = ArrayObj.parse(parser, list) as ArrayObj;
				// Skipping the last token of the array.
				++list.idx;
				list.getNext();
			}

			// Parsing the SELECT expression if the view started with it.
			const next = list.tokens[nextidx] as Token | undefined;
			if (first?.type === Token.TYPE_KEYWORD && first.keyword === 'AS' && next?.type === Token.TYPE_KEYWORD) {
				if (next.value === 'SELECT') {
					list.idx = nextidx;
					this.select = new SelectStatement(parser, list);
					// Skipping the last token of the select.
					++list.idx;
				} else if (next.value === 'WITH') {
					++list.idx;
					this.with = new WithStatement(parser, list);
				}
			}

			// Parsing all other tokens.
			this.collectBody(list);
		} else if (this.options.has('TRIGGER')) {
			// Parsing the time and the event.
			this.entityOptions = OptionsArray.parse(parser, list, CreateStatement.TRIGGER_OPTIONS);
			++list.idx;

			list.getNextOfTypeAndValue(Token.TYPE_KEYWORD, 'ON');
			// Skipping ON.
			++list.idx;

			// Parsing the name of the table.
			this.table = Expression.parse(parser, list, { parseField: 'table', breakOnAlias: true });
			++list.idx;

			list.getNextOfTypeAndValue(Token.TYPE_KEYWORD, 'FOR EACH ROW');
			// Skipping FOR EACH ROW.
			++list.idx;

			this.collectBody(list);
		} else {
			this.collectBody(list);
		}
	}
}

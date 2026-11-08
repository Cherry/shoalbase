// One differential case: every public API phpMyAdmin uses, run over a query. scripts/sql-parser/dump.php computes the same sections in PHP.
import { createHash } from 'node:crypto';

import { type Dumped, dump } from './dump.ts';
import {
	BufferedQuery,
	Context,
	CreateStatement,
	Formatter,
	type FormatterInput,
	Lexer,
	LexerException,
	Misc,
	Parser,
	ParserError,
	ParserException,
	Query,
	Routine,
	type Statement,
	Table,
	Token,
	Tokens,
	TokensList,
} from '../index.ts';
import { listLocales } from '../Translator.ts';

export interface DifferentialCase {
	id: string;
	/** 'query' (the default) runs every section; the other kinds run one helper (or the named api scenario) on the input. */
	kind?: 'query' | 'returnType' | 'parameter' | 'escape' | 'api';
	api?: string;
	query: string;
	context?: string;
	mode?: number | string;
}

export type Sections = Record<string, Dumped>;

const CLAUSES = ['SELECT', 'FROM', 'WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT', 'SET', 'VALUES', 'INTO'];

const FORMATS: FormatterInput[] = [
	{ type: 'text' },
	{ type: 'html' },
	{ type: 'cli' },
	{ type: 'html', remove_comments: true, parts_newline: false },
	{ type: 'text', clause_newline: false, indentation: '\t', line_ending: '\r\n' },
];

/** Runs a section, recording a thrown error as {"@throw": true} because PHP and JavaScript messages differ. */
function attempt(run: () => unknown): Dumped {
	try {
		return dump(run());
	} catch {
		return { '@throw': true };
	}
}

/** Strict mode throws the first lexer or parser error; other errors fail the case. */
function strictErrors(input: string): unknown[] {
	const results: unknown[] = [];
	for (const build of [() => new Lexer(input, true), () => new Parser(input, true)]) {
		try {
			build();
			results.push('ok');
		} catch (error) {
			if (!(error instanceof LexerException) && !(error instanceof ParserException)) {
				throw error;
			}
			results.push(error);
		}
	}
	return results;
}

/** TokensList's array access and cursor methods. */
function tokensListScenario(input: string): unknown[] {
	const list = Lexer.getTokens(input);
	const results: unknown[] = [list.offsetGet(0)?.token ?? null, list.offsetExists(-1), list.offsetExists(list.count)];
	list.offsetSet(null, new Token('X'));
	list.offsetSet(1, new Token('Y'));
	list.offsetUnset(0);
	list.offsetUnset(list.count + 5);
	results.push(list.count, TokensList.build(list));
	list.idx = list.count - 1;
	results.push(list.getPrevious()?.token ?? null, list.getPreviousOfType([Token.TYPE_KEYWORD, Token.TYPE_NONE])?.token ?? null);
	list.idx = 0;
	results.push(list.getNextOfType(Token.TYPE_SYMBOL)?.token ?? null, TokensList.build('raw'), TokensList.build(list.tokens.slice(0, 3)));
	return results;
}

const CUSTOM_FORMATS = [
	{
		type: Token.TYPE_KEYWORD, flags: Token.FLAG_KEYWORD_RESERVED, html: 'class="r"', function: 'strtolower' as const,
	},
	{ type: Token.TYPE_NUMBER, html: 'class="n"' },
	{
		type: Token.TYPE_OPERATOR, flags: 0, html: 'class="o"', function: 'strtoupper' as const,
	},
];

/** APIs the query corpus does not reach, by scenario name. */
function apiScenario(name: string, input: string): unknown {
	switch (name) {
		case 'loadClosest': {
			return [Context.loadClosest(input), Context.loadedContext];
		}
		case 'setMode': {
			Context.setMode(input);
			return [Context.getMode(), Context.hasMode(2), Context.hasMode(1_073_741_824), Context.hasMode(), Context.getIdentifierQuote()];
		}
		case 'replaceTokens': {
			const find = [{ type: Token.TYPE_KEYWORD, value: 'SELECT' }, { value_str: 'distinct' }];
			const replace = [new Token('SELECT DISTINCTROW', Token.TYPE_KEYWORD)];
			const list = Tokens.replaceTokens(Lexer.getTokens(input), [{ type: Token.TYPE_OPERATOR, flags: Token.FLAG_OPERATOR_SQL }], []);
			return [Tokens.replaceTokens(input, find, replace), TokensList.build(list as TokensList), Tokens.match(new Token('x'), { token: 'x', flags: 1 })];
		}
		case 'strict': {
			return strictErrors(input);
		}
		case 'formats': {
			return [Formatter.format(input, { type: 'html', formats: CUSTOM_FORMATS }), Formatter.format(input, { type: 'text', formats: CUSTOM_FORMATS })];
		}
		case 'listLocales': {
			return listLocales(input);
		}
		case 'tokensList': {
			return tokensListScenario(input);
		}
		default: {
			throw new Error(`Unknown scenario ${name}`);
		}
	}
}

/** BufferedQuery over the whole query, with each option set, and fed in chunks like the SQL import does. */
function buffered(query: string): Dumped {
	const runs: Dumped[] = [];
	for (const options of [{}, { parse_delimiter: true, add_delimiter: true }]) {
		const bq = new BufferedQuery(query, options);
		const statements: Dumped[] = [];
		let statement: string | false;
		let guard = 0;
		while ((statement = bq.extract(true)) !== false && guard++ < 1000) {
			statements.push(statement);
		}
		runs.push(statements);
	}

	const bq = new BufferedQuery();
	const statements: Dumped[] = [];
	for (let offset = 0; offset < query.length; offset += 37) {
		bq.query += query.slice(offset, offset + 37);
		let statement: string | false;
		let guard = 0;
		while ((statement = bq.extract()) !== false && statement !== '' && guard++ < 1000) {
			statements.push(statement);
		}
	}
	let statement: string | false;
	let guard = 0;
	while ((statement = bq.extract(true)) !== false && guard++ < 1000) {
		statements.push(statement);
	}
	runs.push(statements);

	return runs;
}

function querySections(query: string): Sections {
	const sections: Sections = {};

	const lexer = new Lexer(query);
	const parser = new Parser(lexer.list);
	sections.lexer = dump(lexer);
	sections.parser = dump(parser);
	sections.errors = attempt(() => {
		const errors = ParserError.get([lexer, parser]);
		return [errors, ParserError.format(errors)];
	});

	const statements: Statement[] = parser.statements;
	const first = statements[0] as Statement | undefined;

	sections.build = statements.map(statement => attempt(() => statement.build()));
	sections.flags = statements.map(statement => attempt(() => Query.getFlags(statement, true)));
	sections.getAll = attempt(() => {
		const all: Record<string, unknown> = { ...Query.getAll(query) };
		delete all.parser;
		delete all.statement;
		return all;
	});

	if (first !== undefined) {
		const clauses: Dumped[] = [];
		for (const clause of CLAUSES) {
			for (const type of [0, -1, 1]) {
				clauses.push(attempt(() => Query.getClause(first, parser.list, clause, type)));
			}
		}
		sections.clauses = clauses;
		sections.replace = [
			attempt(() => Query.replaceClause(first, parser.list, 'ORDER BY `x` DESC')),
			attempt(() => Query.replaceClause(first, parser.list, 'WHERE', 'WHERE 1 = 1', true)),
			attempt(() => Query.replaceClauses(first, parser.list, [['WHERE', 'WHERE 1'], ['ORDER BY', 'ORDER BY 2'], ['LIMIT', 'LIMIT 1']])),
		];
		sections.aliases = attempt(() => Misc.getAliases(first, 'db'));

		if (first instanceof CreateStatement) {
			sections.table = attempt(() => [Table.getFields(first), Table.getForeignKeys(first)]);
			sections.routine = attempt(() => Routine.getParameters(first));
		}
	}

	// getTables() clears the expressions it builds, so it runs after everything that reads them.
	sections.tables = statements.map(statement => attempt(() => Query.getTables(statement)));

	sections.first = [attempt(() => Query.getFirstStatement(query)), attempt(() => Query.getFirstStatement(query, '$$'))];
	// The CLI color of the previous token is shared state; formatting a plain word first makes it the same for every case.
	Formatter.format('x', { type: 'cli' });
	sections.format = FORMATS.map(options => attempt(() => Formatter.format(query, options)));
	sections.buffered = attempt(() => buffered(query));

	return sections;
}

export function runCase(input: DifferentialCase): Sections {
	Context.load(input.context ?? '');
	Context.setMode(input.mode ?? 0);
	try {
		switch (input.kind ?? 'query') {
			case 'returnType': {
				return { result: attempt(() => Routine.getReturnType(input.query)) };
			}
			case 'parameter': {
				return { result: attempt(() => Routine.getParameter(input.query)) };
			}
			case 'escape': {
				return { result: attempt(() => [Context.escape(input.query), Context.escape(input.query, '"'), Context.isKeyword(input.query), Context.isKeyword(input.query, true)]) };
			}
			case 'api': {
				return { result: attempt(() => apiScenario(input.api ?? '', input.query)) };
			}
			default: {
				return querySections(input.query);
			}
		}
	} finally {
		Context.setMode(0);
		Context.load('');
	}
}

/** JSON with sorted class properties (PHP and TypeScript declare them in different orders). */
function canonical(value: Dumped): string {
	if (value === null || typeof value !== 'object') {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(item => canonical(item)).join(',')}]`;
	}
	const keys = Object.keys(value).toSorted((left, right) => (left < right ? -1 : Number(left > right)));
	return `{${keys.map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

export function digest(value: Dumped): string {
	return createHash('sha256').update(canonical(value)).digest('base64')
		.slice(0, 16);
}

// Runs upstream's data-driven tests (tests/data/**, tag 5.11.1) the way its TestCase::runParserTest() does.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import {
	afterEach,
	describe,
	expect,
	it,
} from 'vitest';

import {
	type UpstreamFixture,
	dump,
	firstDifference,
	readUpstreamFixture,
} from './dump.ts';
import { Context, Lexer, Parser } from '../index.ts';

const fixtureFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/upstream.json.gz');
const fixtures = JSON.parse(zlib.gunzipSync(fs.readFileSync(fixtureFile)).toString('utf8')) as Record<string, string>;

function run(name: string, serialized: string): { expected: UpstreamFixture; actual: Omit<UpstreamFixture, 'query'>; } {
	const expected = readUpstreamFixture(serialized);

	Context.load('');
	if (name.includes('/ansi/')) {
		Context.setMode(Context.SQL_MODE_ANSI_QUOTES);
	}
	const mariaDbPos = name.indexOf('_mariadb_');
	if (mariaDbPos !== -1) {
		Context.load(`MariaDb${Number.parseInt(name.slice(mariaDbPos + 9, mariaDbPos + 15), 10)}`);
	}

	const lexer = new Lexer(expected.query);
	const lexerErrors = lexer.errors.map(err => [err.message, err.ch, err.pos, err.code]);
	lexer.errors = [];

	let parser: Parser | null = null;
	let parserErrors: unknown[] = [];
	if (expected.parser !== null) {
		parser = new Parser(lexer.list);
		parserErrors = parser.errors.map(err => [err.message, err.token, err.code]);
		parser.errors = [];
	}

	return {
		expected,
		actual: {
			lexer: dump(lexer),
			parser: dump(parser),
			errors: { lexer: dump(lexerErrors), parser: dump(parserErrors) },
		},
	};
}

describe('upstream sql-parser fixtures', () => {
	afterEach(() => {
		Context.setMode();
		Context.load('');
	});

	it('bundles every upstream data file', () => {
		expect(Object.keys(fixtures).length).toBe(477);
	});

	for (const [name, serialized] of Object.entries(fixtures)) {
		it(name, () => {
			const { expected, actual } = run(name, serialized);
			expect(firstDifference(expected.errors.lexer, actual.errors.lexer, 'errors.lexer')).toBeNull();
			expect(firstDifference(expected.errors.parser, actual.errors.parser, 'errors.parser')).toBeNull();
			expect(firstDifference(expected.lexer, actual.lexer, 'lexer')).toBeNull();
			expect(firstDifference(expected.parser, actual.parser, 'parser')).toBeNull();
		});
	}
});

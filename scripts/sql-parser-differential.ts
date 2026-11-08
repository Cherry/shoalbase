#!/usr/bin/env node
// Differential test of the sql-parser port against the real PHP sql-parser inside the dbadmin-pma container.
// Usage: node scripts/sql-parser-differential.ts [--write] [--details N] [--filter text]
//   --write    stores the cases and PHP's section digests in src/sql-parser/__tests__/fixtures/php-differential.json.gz
//   --details  prints the first difference of up to N failing cases
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import {
	type DifferentialCase,
	type Sections,
	digest,
	runCase,
} from '../src/sql-parser/__tests__/differential.ts';
import { firstDifference, readUpstreamFixture } from '../src/sql-parser/__tests__/dump.ts';
import { Translator } from '../src/sql-parser/index.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const container = 'dbadmin-pma';
const autoload = '/var/www/html/vendor/autoload.php';
const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
};

interface LocalizedCase extends DifferentialCase {
	locale?: string;
}

const LOCALES = ['de', 'fr', 'pt_BR', 'zh_TW', 'ja'];
const MODES: [string, number][] = [['ansi', 2], ['noquotes', 1_073_741_824]];
const CONTEXTS = ['MySql80400', 'MariaDb110400', 'MySql50000'];

function buildCases(): LocalizedCase[] {
	const cases: LocalizedCase[] = [];
	const fixtures = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(root, 'src/sql-parser/__tests__/fixtures/upstream.json.gz'))).toString('utf8')) as Record<string, string>;

	for (const [name, serialized] of Object.entries(fixtures)) {
		const { query } = readUpstreamFixture(serialized);
		const mariaDbPos = name.indexOf('_mariadb_');
		const context = mariaDbPos === -1 ? '' : `MariaDb${Number.parseInt(name.slice(mariaDbPos + 9, mariaDbPos + 15), 10)}`;
		const mode = name.includes('/ansi/') ? 2 : 0;
		cases.push({ id: `fx:${name}`, query, context, mode });

		// Truncated queries exercise the error paths.
		const characters = [...query];
		if (characters.length > 8) {
			for (const fraction of [1, 2]) {
				const cut = Math.floor(characters.length * fraction / 3);
				cases.push({ id: `tr:${name}:${fraction}`, query: characters.slice(0, cut).join(''), context, mode });
			}
		}
	}

	const corpus = JSON.parse(fs.readFileSync(path.join(root, 'scripts/sql-parser/pma-corpus.json'), 'utf8')) as string[];
	for (const [index, query] of corpus.entries()) {
		cases.push({ id: `pma:${index}`, query });
		for (const context of CONTEXTS) {
			cases.push({ id: `pma:${index}:${context}`, query, context });
		}
		for (const [modeName, mode] of MODES) {
			cases.push({ id: `pma:${index}:${modeName}`, query, mode });
		}
		if (index % 5 === 0) {
			for (const locale of LOCALES) {
				cases.push({ id: `pma:${index}:${locale}`, query, locale });
			}
		}
	}

	const helpers: [DifferentialCase['kind'], string][] = [
		['returnType', 'INT(11) UNSIGNED'],
		['returnType', 'VARCHAR(255) CHARSET utf8mb4 COLLATE utf8mb4_bin'],
		['returnType', 'enum(\'a\',\'b\')'],
		['returnType', 'DECIMAL(10,2) ZEROFILL'],
		['returnType', 'nonsense'],
		['returnType', ''],
		['parameter', 'IN `a` INT(11)'],
		['parameter', 'OUT b VARCHAR(10) CHARSET latin1'],
		['parameter', 'INOUT c SET(\'x\',\'y\')'],
		['parameter', 'd TEXT'],
		['parameter', ''],
		['escape', 'name'],
		['escape', 'na`me'],
		['escape', 'select'],
		['escape', 'Order'],
		['escape', 'na"me'],
	];
	for (const [index, [kind, query]] of helpers.entries()) {
		cases.push({ id: `helper:${index}`, kind, query });
		cases.push({ id: `helper:${index}:noquotes`, kind, query, mode: 1_073_741_824 });
		cases.push({ id: `helper:${index}:ansi`, kind, query, mode: 2 });
	}

	const scenarios: Record<string, string[]> = {
		loadClosest: ['MySql80033', 'MySql80400', 'MySql90500', 'MySql50045', 'MySql80', 'MariaDb100512', 'MariaDb110402', 'MariaDb120300', 'MariaDb999999', 'MariaDb', 'MySql', 'Foo123', ''],
		setMode: ['ANSI', 'ANSI_QUOTES,STRICT_TRANS_TABLES', 'TRADITIONAL', '', 'NO_ENCLOSING_QUOTES', 'BOGUS,PIPES_AS_CONCAT'],
		replaceTokens: ['SELECT DISTINCT a FROM t', 'select distinct /* c */ x, y', 'SELECT a, b FROM t', 'SELECT * FROM (SELECT DISTINCT 1) x'],
		strict: ['SELECT \'abc', 'SELECT * FROM t WHERE', 'FOO', 'SELECT 1', 'SELECT @', 'SELECT a FROM t ORDER BY a LIMIT 1 WHERE b'],
		formats: ['SELECT a + 1, b FROM t WHERE c = 2', 'select count(*) from t limit 10'],
		listLocales: ['de', 'pt_BR', 'sr@latin', 'en_US.UTF-8', 'zh_TW.Big5@mod', 'C', '', 'english', 'ckb'],
		tokensList: ['SELECT a, `b` FROM t /* c */ WHERE x = @v', 'X'],
	};
	for (const [api, inputs] of Object.entries(scenarios)) {
		for (const [index, query] of inputs.entries()) {
			cases.push({
				id: `api:${api}:${index}`, kind: 'api', api, query,
			});
		}
	}

	return cases;
}

function docker(...dockerArgs: string[]): string {
	return execFileSync('docker', dockerArgs, { encoding: 'utf8' });
}

/** Runs dump.php over the cases; resolves with the exit code (255 after PHP's time limit fatal error). */
function runPhpProcess(workDir: string, file: string, locale: string, results: Map<string, Sections>): Promise<number> {
	return new Promise((resolve, reject) => {
		const php = spawn('docker', ['exec', container, 'php', `${workDir}/dump.php`, autoload, `${workDir}/${file}`, locale]);
		let buffer = '';
		php.stdout.setEncoding('utf8');
		php.stdout.on('data', (chunk: string) => {
			buffer += chunk;
			let newline: number;
			while ((newline = buffer.indexOf('\n')) !== -1) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				const { id, sections } = JSON.parse(line) as { id: string; sections: Sections; };
				results.set(id, sections);
			}
		});
		php.stderr.pipe(process.stderr);
		php.on('error', reject);
		php.on('close', code => resolve(code ?? 1));
	});
}

/** Ids of cases on which PHP itself never terminates (the port loops the same way, so they are skipped). */
const phpHangs = new Set<string>();

/** Runs dump.php once per locale and returns each case's PHP sections. */
async function runPhp(cases: LocalizedCase[]): Promise<Map<string, Sections>> {
	const results = new Map<string, Sections>();
	const workDir = `/tmp/sqlp-diff-${randomBytes(6).toString('hex')}`;
	const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlp-diff-'));
	try {
		docker('exec', container, 'mkdir', '-p', workDir);
		docker('cp', path.join(root, 'scripts/sql-parser/dump.php'), `${container}:${workDir}/dump.php`);
		const byLocale = new Map<string, LocalizedCase[]>();
		for (const item of cases) {
			const locale = item.locale ?? 'en';
			byLocale.set(locale, [...byLocale.get(locale) ?? [], item]);
		}
		for (const [locale, localeCases] of byLocale) {
			let remaining = localeCases;
			for (let attempt = 0; remaining.length > 0; attempt++) {
				const file = `cases-${locale}-${attempt}.json`;
				fs.writeFileSync(path.join(localDir, file), JSON.stringify(remaining));
				docker('cp', path.join(localDir, file), `${container}:${workDir}/${file}`);
				const code = await runPhpProcess(workDir, file, locale, results);
				const stuck = remaining.findIndex(item => !results.has(item.id));
				if (stuck === -1) {
					break;
				}
				if (code === 0) {
					throw new Error(`php exited with ${code} before ${remaining[stuck].id}`);
				}
				// The first case without a result never finished; the run resumes after it.
				phpHangs.add(remaining[stuck].id);
				remaining = remaining.slice(stuck + 1);
			}
		}
	} finally {
		// The container is shared, so nothing is left behind.
		docker('exec', container, 'rm', '-rf', workDir);
		fs.rmSync(localDir, { recursive: true, force: true });
	}
	return results;
}

function runTs(item: LocalizedCase): Sections {
	Translator.setLocale(item.locale ?? 'en');
	try {
		return runCase(item);
	} finally {
		Translator.setLocale('en');
	}
}

async function main(): Promise<void> {
	const filter = option('--filter') ?? '';
	const details = Number(option('--details') ?? 10);
	const cases = buildCases().filter(item => item.id.includes(filter));
	const casesOut = option('--cases-out');
	if (casesOut !== undefined) {
		fs.writeFileSync(casesOut, JSON.stringify(cases));
		return;
	}
	// --php-cache <file> reuses PHP results between runs while iterating on the port.
	const cacheFile = option('--php-cache');
	let php: Map<string, Sections>;
	if (cacheFile !== undefined && fs.existsSync(cacheFile)) {
		const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as { results: [string, Sections][]; hangs: string[]; };
		php = new Map(cached.results);
		for (const id of cached.hangs) {
			phpHangs.add(id);
		}
	} else {
		console.log(`Running ${cases.length} cases in PHP...`);
		php = await runPhp(cases);
		if (cacheFile !== undefined) {
			fs.writeFileSync(cacheFile, JSON.stringify({ results: [...php], hangs: [...phpHangs] }));
		}
	}

	let passed = 0;
	const failures: string[] = [];
	const failingSections = new Map<string, number>();
	const digests: Record<string, Record<string, string>> = {};
	const compared = cases.filter(item => !phpHangs.has(item.id));
	for (const item of compared) {
		const expected = php.get(item.id);
		if (expected === undefined) {
			failures.push(`${item.id}: no PHP result`);
			continue;
		}
		digests[item.id] = Object.fromEntries(Object.entries(expected).map(([section, value]) => [section, digest(value)]));
		let actual: Sections;
		try {
			actual = runTs(item);
		} catch (error) {
			failures.push(`${item.id}: TypeScript threw ${(error as Error).stack}`);
			continue;
		}
		const sections = new Set([...Object.keys(expected), ...Object.keys(actual)]);
		let failed = false;
		for (const section of sections) {
			const difference = firstDifference(expected[section] ?? null, actual[section] ?? null, section);
			if (difference !== null) {
				failed = true;
				failingSections.set(section, (failingSections.get(section) ?? 0) + 1);
				if (failures.length < details) {
					failures.push(`${item.id} ${JSON.stringify(item.query.slice(0, 120))}\n    ${difference.slice(0, 600)}`);
				}
				break;
			}
		}
		if (!failed) {
			passed++;
		}
	}

	for (const failure of failures) {
		console.log(failure);
	}
	console.log(`Failing sections: ${JSON.stringify(Object.fromEntries(failingSections))}`);
	console.log(`PHP never finished (skipped): ${JSON.stringify([...phpHangs])}`);
	console.log(`Differential: ${passed}/${compared.length} cases identical (${(passed / compared.length * 100).toFixed(2)}%)`);

	if (args.includes('--write')) {
		const output = path.join(root, 'src/sql-parser/__tests__/fixtures/php-differential.json.gz');
		fs.writeFileSync(output, zlib.gzipSync(JSON.stringify({ cases: compared, digests, hangs: [...phpHangs] }), { level: 9 }));
		console.log(`Wrote ${path.relative(root, output)}`);
	}
}

await main();

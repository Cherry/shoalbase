#!/usr/bin/env node
// Bundles upstream phpmyadmin/sql-parser test fixtures (tests/data/**/*.in and .out) into one gzipped JSON file for the TypeScript port.
// Usage: node scripts/sql-parser-fixtures.ts <path to a clone of github.com/phpmyadmin/sql-parser at the vendored tag>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clone = process.argv[2];
if (!clone) {
	console.error('Usage: node scripts/sql-parser-fixtures.ts <sql-parser clone>');
	process.exit(1);
}
const dataDir = path.join(path.resolve(clone), 'tests/data');
const output = path.join(root, 'src/sql-parser/__tests__/fixtures/upstream.json.gz');

const fixtures: Record<string, string> = {};
function walk(dir: string) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true }).toSorted((left, right) => left.name.localeCompare(right.name))) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			walk(full);
		} else if (entry.name.endsWith('.in')) {
			const name = path.relative(dataDir, full).replaceAll('\\', '/').slice(0, -3);
			const outFile = `${full.slice(0, -3)}.out`;
			if (!fs.existsSync(outFile)) {
				continue;
			}
			// The .out file has the query (as generated, so a checkout's line ending conversion cannot alter it) and upstream's serialized lexer, parser and errors.
			fixtures[name] = fs.readFileSync(outFile, 'utf8');
		}
	}
}
walk(dataDir);

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, zlib.gzipSync(JSON.stringify(fixtures), { level: 9 }));
console.log(`Wrote ${Object.keys(fixtures).length} fixtures to ${path.relative(root, output)}`);

// Replays the differential corpus recorded from the real PHP sql-parser (scripts/sql-parser-differential.ts --write).
// A failing case can be inspected against live PHP with: node scripts/sql-parser-differential.ts --filter <case id>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { type DifferentialCase, digest, runCase } from './differential.ts';
import { Translator } from '../index.ts';

interface LocalizedCase extends DifferentialCase {
	locale?: string;
}

interface Recorded {
	cases: LocalizedCase[];
	digests: Record<string, Record<string, string>>;
	hangs: string[];
}

const fixtureFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/php-differential.json.gz');
const recorded = JSON.parse(zlib.gunzipSync(fs.readFileSync(fixtureFile)).toString('utf8')) as Recorded;

function sectionDigests(item: Recorded['cases'][number]): Record<string, string> {
	Translator.setLocale(item.locale ?? 'en');
	try {
		return Object.fromEntries(Object.entries(runCase(item)).map(([section, value]) => [section, digest(value)]));
	} finally {
		Translator.setLocale('en');
	}
}

describe('differential against PHP sql-parser 5.11.1', () => {
	it('covers the fixtures, phpMyAdmin queries, contexts, SQL modes and locales', () => {
		expect(recorded.cases.length).toBeGreaterThan(3000);
		expect(new Set(recorded.cases.map(item => item.locale ?? 'en')).size).toBeGreaterThan(4);
	});

	// Grouped by the id prefix so a failure names the case without thousands of tests.
	const groups = new Map<string, Recorded['cases']>();
	for (const item of recorded.cases) {
		const group = item.id.split(':', 1)[0];
		groups.set(group, [...groups.get(group) ?? [], item]);
	}

	for (const [group, cases] of groups) {
		it(`matches PHP for every ${group} case`, () => {
			const mismatches: string[] = [];
			for (const item of cases) {
				const actual = sectionDigests(item);
				const expected = recorded.digests[item.id];
				for (const section of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
					if (expected[section] !== actual[section]) {
						mismatches.push(`${item.id} (${section})`);
						break;
					}
				}
			}
			expect(mismatches).toEqual([]);
		}, 120000);
	}
});

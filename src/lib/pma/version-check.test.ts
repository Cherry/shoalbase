import { describe, expect, it } from 'vitest';

import {
	PHP_VERSION,
	type Release,
	evaluateVersionCondition,
	latestCompatibleVersion,
	parseVersionData,
	versionCompare,
} from './version-check.ts';

// [left, right, version_compare(left, right)] from PHP 8.3 in the oracle container.
const PHP_RESULTS: [string, string, number][] = [
	['5.2.3', '5.2.3', 0],
	['5.2.3', '5.2.10', -1],
	['5.2.10', '5.2.9', 1],
	['5.2', '5.2.0', -1],
	['5.2.0', '5.2', 1],
	['1.0rc1', '1.0', -1],
	['1.0', '1.0rc1', 1],
	['1.0-dev', '1.0-alpha1', -1],
	['1.0a', '1.0b', -1],
	['1.0pl1', '1.0', 1],
	['1.0', '1.0pl1', -1],
	['1.0.x', '1.0.0', -1],
	['1.0', '1.0.x', 1],
	['', '1', -1],
	['1', '', 1],
	['', '', 0],
	['8.3.36', '7.2', 1],
	['8.3.36', '8.5', -1],
	['1..2', '1.2', 0],
	['1.0beta', '1.0RC', -1],
	['1.0#', '1.0p', -1],
	['1-2', '1.2', 0],
	['1+2', '1_2', 0],
	['.1', '0.1', -1],
	['1.0foo', '1.0', -1],
	['5.2.3-rc1', '5.2.3', -1],
	['10', '9', 1],
	['1.0.0-beta2', '1.0.0-beta10', -1],
	['a', 'b', -1],
	['1x', '1', -1],
	['1.0', '1.a', 1],
	['1.a', '1.0', -1],
	['1.0.0', '1.0.0.1', -1],
];

describe('versionCompare', () => {
	it.each(PHP_RESULTS)('compares %j with %j like PHP', (left, right, result) => {
		expect(versionCompare(left, right, '<')).toBe(result === -1);
		expect(versionCompare(left, right, 'lt')).toBe(result === -1);
		expect(versionCompare(left, right, '<=')).toBe(result !== 1);
		expect(versionCompare(left, right, 'le')).toBe(result !== 1);
		expect(versionCompare(left, right, '>')).toBe(result === 1);
		expect(versionCompare(left, right, 'gt')).toBe(result === 1);
		expect(versionCompare(left, right, '>=')).toBe(result !== -1);
		expect(versionCompare(left, right, 'ge')).toBe(result !== -1);
		expect(versionCompare(left, right, '==')).toBe(result === 0);
		expect(versionCompare(left, right, '=')).toBe(result === 0);
		expect(versionCompare(left, right, 'eq')).toBe(result === 0);
		expect(versionCompare(left, right, '!=')).toBe(result !== 0);
		expect(versionCompare(left, right, '<>')).toBe(result !== 0);
		expect(versionCompare(left, right, 'ne')).toBe(result !== 0);
	});

	it('folds a separator that follows a dot into that dot, as php_canonicalize_version() does', () => {
		expect(versionCompare('1.-2', '1.2', '==')).toBe(true);
		expect(versionCompare('5.2._3', '5.2.3', '==')).toBe(true);
	});

	it('rejects unknown operators', () => {
		expect(versionCompare('1', '1', '~')).toBe(false);
	});
});

describe('evaluateVersionCondition', () => {
	it('reads the longest matching operator first', () => {
		expect(evaluateVersionCondition('8.3.36', '>=7.2')).toBe(true);
		expect(evaluateVersionCondition('8.3.36', '<=8.3.36')).toBe(true);
		expect(evaluateVersionCondition('8.3.36', '<8.3')).toBe(false);
		expect(evaluateVersionCondition('8.3.36', '<>8.3.36')).toBe(false);
		expect(evaluateVersionCondition('8.3.36', '!=8.3.35')).toBe(true);
		expect(evaluateVersionCondition('8.3.36', '=8.3.36')).toBe(true);
	});

	it('fails conditions without an operator or without a known version', () => {
		expect(evaluateVersionCondition('8.3.36', '8.3.36')).toBe(false);
		expect(evaluateVersionCondition(null, '>=5.5')).toBe(false);
	});
});

describe('parseVersionData', () => {
	it('accepts version.json with a version, a date and releases', () => {
		const body = '{"version":"5.2.3","date":"2025-10-08","releases":[{"version":"5.2.3","date":"2025-10-08","php_versions":">=7.2,<8.5","mysql_versions":">=5.5"}]}';
		expect(parseVersionData(body)?.version).toBe('5.2.3');
	});

	it.each([
		[''],
		['not json'],
		['[1]'],
		['null'],
		['{"version":"5.2.3","date":"2025-10-08","releases":[]}'],
		['{"version":"0","date":"2025-10-08","releases":[{}]}'],
		['{"version":"5.2.3","releases":[{}]}'],
		['{"version":"5.2.3","date":false,"releases":[{}]}'],
		['{"version":"5.2.3","date":0,"releases":[{}]}'],
		['{"version":null,"date":"x","releases":[{}]}'],
	])('rejects %j like the empty() checks upstream', (body) => {
		expect(parseVersionData(body)).toBeNull();
	});
});

describe('latestCompatibleVersion', () => {
	const releases: Release[] = [
		{ version: '5.2.2', date: '2025-01-21', php_versions: '>=7.2,<8.5', mysql_versions: '>=5.5' },
		{ version: '5.2.3', date: '2025-10-08', php_versions: '>=7.2,<8.5', mysql_versions: '>=5.5' },
		{ version: '5.1.4', date: '2024-01-01', php_versions: '>=7.1,<8.5', mysql_versions: '>=5.5' },
		{ version: '5.0.0', date: '2020-01-01', php_versions: '>=7.1,<8.0', mysql_versions: '>=5.5' },
		{ version: '6.0.0', date: '2026-01-01', php_versions: '>=8.4', mysql_versions: '>=5.7' },
		{ version: '5.2.4', date: '2026-02-01', php_versions: '>=7.2,<8.5', mysql_versions: '>=9.0' },
	];

	it('picks the newest release whose PHP conditions hold, ignoring MySQL with several servers', () => {
		expect(latestCompatibleVersion(releases, { phpVersion: PHP_VERSION, mysqlVersion: null, serverCount: 2 })).toEqual({ version: '5.2.4', date: '2026-02-01' });
	});

	it('also checks MySQL conditions when there is a single server', () => {
		expect(latestCompatibleVersion(releases, { phpVersion: PHP_VERSION, mysqlVersion: '8.4.13', serverCount: 1 })).toEqual({ version: '5.2.3', date: '2025-10-08' });
		expect(latestCompatibleVersion(releases, { phpVersion: PHP_VERSION, mysqlVersion: null, serverCount: 1 })).toBeNull();
	});
});

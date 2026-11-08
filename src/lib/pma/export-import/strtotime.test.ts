import { describe, expect, it } from 'vitest';

import { mysqlStrtotime, phpDate } from './strtotime.ts';

// 2026-11-07 05:09:39 UTC, as time() returned in the oracle container.
const NOW = 1_794_028_179;

describe('mysqlStrtotime', () => {
	it.each([
		['1000-01-01', -30_610_224_000],
		['0000-00-00', -62_169_984_000],
		['0000-00-00 00:00:00.000', -62_169_984_000],
		['0000-01-01', -62_167_219_200],
		['2024-02-30', 1_709_251_200],
		['2024-00-10', 1_702_166_400],
		['2024-01-00', 1_703_980_800],
		['2024-02-29 12:34:56.789', 1_709_210_096],
		['2024-02-29 24:00:00', 1_709_251_200],
		['9999-12-31 23:59:59', 253_402_300_799],
	])('matches PHP for the date %s', (value, expected) => {
		expect(mysqlStrtotime(value, NOW)).toBe(expected);
	});

	it.each([
		['05:07:09', 1_794_028_029],
		['24:00:01', 1_794_096_001],
		['00:00:60', 1_794_009_660],
		['12:34:56.5', 1_794_054_896],
	])('puts the time %s on today', (value, expected) => {
		expect(mysqlStrtotime(value, NOW)).toBe(expected);
	});

	it('reads a negative time as an offset from now', () => {
		expect(mysqlStrtotime('-01:02:03', NOW)).toBe(NOW + 3723);
		expect(mysqlStrtotime('-24:59:59', NOW)).toBe(NOW + 89999);
	});

	it.each(['838:59:59', '-25:00:00', '100:00:00', '00:60:00', '2024-13-01', '2024-02-29 25:00:00', 'not a date', ''])('returns null where PHP returns false for %j', (value) => {
		expect(mysqlStrtotime(value, NOW)).toBeNull();
	});
});

describe('phpDate', () => {
	it('formats years before 1 with a sign and four digits', () => {
		expect(phpDate('Y-m-d', -62_169_984_000)).toBe('-0001-11-30');
		expect(phpDate('Y-m-d', -62_167_219_200)).toBe('0000-01-01');
	});

	it('keeps backslash-escaped characters and unknown letters literally', () => {
		expect(phpDate(String.raw`\P\TH\Hi\Ms\S`, 1_709_210_096)).toBe('PT12H34M56S');
		expect(phpDate(String.raw`Y-m-d\TH:i:s`, 1_709_210_096)).toBe('2024-02-29T12:34:56');
	});
});

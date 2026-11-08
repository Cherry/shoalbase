import { describe, expect, it } from 'vitest';

import {
	formatByteDown,
	formatNumber,
	getFormattedMaximumUploadSize,
	getScriptNameForOption,
	getTitleForTarget,
	getUrlForOption,
	localisedDate,
	numberFormat,
	phpRound,
	timespanFormat,
} from './util.ts';

describe('formatByteDown', () => {
	it('matches PHP 5.2.3 for bytes and larger units', () => {
		expect(formatByteDown(0)).toEqual(['0', 'B']);
		expect(formatByteDown(1234)).toEqual(['1,234', 'B']);
		expect(formatByteDown(1023.5)).toEqual(['1,024', 'B']);
		expect(formatByteDown('2048')).toEqual(['2,048', 'B']);
		expect(formatByteDown(1_048_576)).toEqual(['1,024', 'KiB']);
		expect(formatByteDown(1_073_741_824 * 3.5)).toEqual(['3,584', 'MiB']);
		expect(formatByteDown(123_456_789_012)).toEqual(['118 k', 'MiB']);
		expect(formatByteDown(5, 6, 2)).toEqual(['5', 'B']);
		expect(formatByteDown(null)).toBeNull();
		expect(formatByteDown('none')).toEqual(['0', 'B']);
		expect(getFormattedMaximumUploadSize(2_097_152)).toBe('(Max: 2,048KiB)');
	});
});

describe('formatNumber', () => {
	it('matches PHP 5.2.3 for SI prefixes, decimals and tiny values', () => {
		expect(formatNumber(0)).toBe('0');
		expect(formatNumber('0.0')).toBe('0');
		expect(formatNumber(1234)).toBe('1 k');
		expect(formatNumber(0.0005, 3, 2)).toBe('500 µ');
		expect(formatNumber(-1_234_567)).toBe('-1 M');
		expect(formatNumber(1234.5678, 0, 2)).toBe('1,234.57');
		expect(formatNumber(0.001, 0, 2)).toBe(' <0.01');
		expect(formatNumber(999999, 3, 0)).toBe('1,000 k');
		expect(formatNumber(1500, 3, 1, true)).toBe('1.5 k');
		expect(formatNumber(12345, 1, 3, false, false)).toBe('12.345 k');
		expect(formatNumber(0.00004, 3, 0, true)).toBe(' <1  ');
	});

	it('rounds halves away from zero like PHP round() and number_format()', () => {
		expect(phpRound(2.5)).toBe(3);
		expect(phpRound(-2.5)).toBe(-3);
		expect(phpRound(1.005, 2)).toBe(1.01);
		expect(numberFormat(1_234_567.891, 2)).toBe('1,234,567.89');
		expect(numberFormat(-0.5)).toBe('-1');
		expect(numberFormat(999.5)).toBe('1,000');
	});
});

describe('dates and timespans', () => {
	it('formats like Util::localisedDate() in the UTC container', () => {
		expect(localisedDate(1_700_000_000)).toBe('Nov 14, 2023 at 10:13 PM');
		expect(localisedDate(1_700_000_000, '%a %A %b %B %d %e %H %I %M %S %y %Y %p %w %% %Q')).toBe('Tue Tue Nov Nov 14 14 22 10 13 20 23 2023 PM 2 % %Q');
		expect(localisedDate(0, '%I %p %m')).toBe('12 AM 01');
		expect(localisedDate(-1, '%Y').length).toBe(4);
	});

	it('formats like Util::timespanFormat()', () => {
		expect(timespanFormat(90061)).toBe('1 days, 1 hours, 1 minutes and 1 seconds');
		expect(timespanFormat(59)).toBe('0 days, 0 hours, 0 minutes and 59 seconds');
		expect(timespanFormat(3600)).toBe('0 days, 1 hours, 0 minutes and 0 seconds');
	});
});

describe('options', () => {
	it('maps DefaultTab settings to routes and titles', () => {
		expect(getUrlForOption('privileges', 'server')).toBe('/server/privileges');
		expect(getTitleForTarget('browse')).toBe('Browse');
		const state = { server: 1, serverDefault: 1, lang: 'en', hasLangCookie: false, token: 't' };
		expect(getScriptNameForOption(state, 'structure', 'database')).toBe('index.php?route=/database/structure&lang=en');
	});
});

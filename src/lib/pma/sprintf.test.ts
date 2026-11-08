import { describe, expect, it } from 'vitest';

import { phpToInt, sprintf } from './sprintf.ts';

// Expected strings were produced by PHP 8.3's sprintf() in the oracle container.
const phpResults: [string, unknown[], string][] = [
	['%1$d row affected.', [1], '1 row affected.'],
	['%s and %s', ['a', 'b'], 'a and b'],
	['%2$s %1$s', ['x', 'y'], 'y x'],
	['%05d', [-3], '-0003'],
	['%05d', [42], '00042'],
	['%-5d|', [42], '42   |'],
	['%-05d|', [3], '3    |'],
	['%+d %+d', [5, -5], '+5 -5'],
	['%+05d', [5], '+0005'],
	['%\'*8s', ['ab'], '******ab'],
	['%-8s|', ['ab'], 'ab      |'],
	['%-\'x6s|', ['ab'], 'abxxxx|'],
	['%.2s', ['abcdef'], 'ab'],
	['%5.1f', [3.25159], '  3.3'],
	['%f', [1.5], '1.500000'],
	['%.0f', [2.5], '2'],
	['%.0f %.0f %.0f %.0f', [1.5, 3.5, 0.5, -2.5], '2 4 0 -2'],
	['%.1f %.1f %.2f', [0.25, 0.35, 1.005], '0.2 0.3 1.00'],
	['%-05.1f|', [1.25], '1.200|'],
	['%F', [-0.5], '-0.500000'],
	['%e', [12345.678], '1.234568e+4'],
	['%.2E', [0.000123], '1.23E-4'],
	['%+.1e', [1], '+1.0e+0'],
	['%08.2f', [-1.5], '-0001.50'],
	['%u', [-1], '18446744073709551615'],
	['%u', [7], '7'],
	['%b', [5], '101'],
	['%o', [8], '10'],
	['%x %X', [255, 255], 'ff FF'],
	['%x', [-1], 'ffffffffffffffff'],
	['%c', [65], 'A'],
	['100%%', [], '100%'],
	['%d', ['12abc'], '12'],
	['%d', ['abc'], '0'],
	['%d', [3.99], '3'],
	['%d', [true], '1'],
	['%d', [null], '0'],
	['%d', [' 1e3'], '1000'],
	['%s', [1.5], '1.5'],
	['%s', [true], '1'],
	['%s', [null], ''],
	['%f', ['2.5x'], '2.500000'],
];

describe('sprintf', () => {
	it.each(phpResults)('formats %j with %j like PHP', (format, args, expected) => {
		expect(sprintf(format, ...args)).toBe(expected);
	});

	it('throws like PHP 8 when arguments or the specifier are missing', () => {
		expect(() => sprintf('%s %s', 'a')).toThrow('Too few arguments');
		expect(() => sprintf('%0$s', 'a')).toThrow('Too few arguments');
		expect(() => sprintf('100%')).toThrow('Unknown format specifier');
		expect(() => sprintf('%5%')).toThrow('Unknown format specifier');
	});
});

describe('phpToInt', () => {
	it('maps values without a finite number to 0', () => {
		expect(phpToInt(NaN)).toBe(0);
		expect(phpToInt(Infinity)).toBe(0);
	});
});

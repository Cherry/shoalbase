import { describe, expect, it } from 'vitest';

import { byTime, runAdvisor } from './advisor.ts';
import {
	ExpressionError,
	evaluateExpression,
	levenshtein,
	phpBool,
	phpSpaceship,
} from './expression.ts';

const evaluate = (expression: string, values: Record<string, string | number | boolean | null> = {}) => evaluateExpression(expression, values, {
	twice: value => Number(value) * 2,
});

describe('evaluateExpression', () => {
	it('follows operator precedence and associativity', () => {
		expect(evaluate('1 + 2 * 3')).toBe(7);
		expect(evaluate('(1 + 2) * 3')).toBe(9);
		expect(evaluate('2 ** 3 ** 2')).toBe(512);
		expect(evaluate('10 - 2 - 3')).toBe(5);
		expect(evaluate('7 % 4')).toBe(3);
		expect(evaluate('-2 + +3')).toBe(1);
		expect(evaluate('\'a\' ~ 1')).toBe('a1');
	});

	it('evaluates names, functions, arrays, constants and conditionals', () => {
		expect(evaluate('x / 4', { x: '10' })).toBe(2.5);
		expect(evaluate('twice(x)', { x: '4' })).toBe(8);
		expect(evaluate(String.raw`[x, "b\tc", 1.5e+1]`, { x: 1 })).toEqual([1, 'b\tc', 15]);
		expect(evaluate('[1, 2, ]')).toEqual([1, 2]);
		expect(evaluate(String.raw`"a\qb"`)).toBe('aqb');
		expect(evaluate('true and not false')).toBe(true);
		expect(evaluate('null or FALSE')).toBe(false);
		expect(evaluate('TRUE ? 1 : 2')).toBe(1);
		expect(evaluate('0 ? 1 : 2')).toBe(2);
		expect(evaluate('1 ? 2')).toBe(2);
		expect(evaluate('0 ? 2')).toBeNull();
		expect(evaluate('x ?: 3', { x: 0 })).toBe(3);
	});

	it('compares with PHP 8 loose semantics', () => {
		expect(evaluate('value == \'OFF\'', { value: 'OFF' })).toBe(true);
		expect(evaluate('value != "YES"', { value: 'YES' })).toBe(false);
		expect(evaluate('value === 0 || value === \'NEVER\'', { value: '0' })).toBe(false);
		expect(evaluate('value !== 0', { value: 0 })).toBe(false);
		expect(evaluate('\'8.\' <= \'5.\'')).toBe(false);
		expect(evaluate('\'4\' < 5')).toBe(true);
		expect(evaluate('\'abc\' > 5')).toBe(true);
		expect(evaluate('5 >= \'abc\'')).toBe(false);
		expect(evaluate('x < 1', { x: null })).toBe(true);
	});

	it('reports PHP and Symfony errors with their messages', () => {
		expect(() => evaluate('x / 0', { x: 1 })).toThrow('Division by zero.');
		expect(() => evaluate('1 % 0')).toThrow('Modulo by zero.');
		expect(() => evaluate('\'abc\' + 1')).toThrow('Unsupported operand types: string + int');
		expect(() => evaluate('[1] * 1.5')).toThrow('Unsupported operand types: array * float');
		expect(() => evaluate('-\'x\'')).toThrow(ExpressionError);
		expect(() => evaluate('true * [1]')).toThrow('Unsupported operand types: bool * array');
		expect(() => evaluate('[1] - null')).toThrow('Unsupported operand types: array - null');
		expect(evaluate('null + true')).toBe(1);
		expect(() => evaluate('Uptme', { Uptime: 1, value: 0 })).toThrow('Variable "Uptme" is not valid around position 1 for expression `Uptme`. Did you mean "Uptime"?');
		expect(() => evaluate('zzzz', { Uptime: 1 })).toThrow(/^Variable "zzzz" is not valid around position 1 for expression `zzzz`\.$/);
		expect(() => evaluate('nope(1)')).toThrow('The function "nope" does not exist around position 1 for expression `nope(1)`.');
		expect(() => evaluate('1 in [1]')).toThrow('The "in" operator is not supported.');
		expect(() => evaluate('(1')).toThrow('Unclosed "(" around position 0');
		expect(() => evaluate('1)')).toThrow('Unexpected ")" around position 1');
		expect(() => evaluate('(1]')).toThrow('Unclosed "("');
		expect(() => evaluate('1 # 2')).toThrow('Unexpected character "#" around position 2');
		expect(() => evaluate('1 2')).toThrow('Unexpected token "number" of value "2" around position 3');
		expect(() => evaluate(',')).toThrow('Unexpected token "punctuation" of value ","');
		expect(() => evaluate('twice(1 2)')).toThrow('Arguments must be separated by a comma. Unexpected token "number" of value "2" ("punctuation" expected with value ",")');
		expect(() => evaluate('[1 2]')).toThrow('An array element must be followed by a comma');
	});

	it('exposes PHP truthiness and comparison', () => {
		expect([phpBool([]), phpBool(['x']), phpBool('0'), phpBool('0.0')]).toEqual([false, true, false, true]);
		expect(phpSpaceship('', null)).toBe(0);
		expect(phpSpaceship('a', null)).toBe(1);
		expect(phpSpaceship(null, 'a')).toBe(-1);
		expect(phpSpaceship(null, '')).toBe(0);
		expect(phpSpaceship(true, 'x')).toBe(0);
		expect(phpSpaceship('10', '9')).toBe(1);
		expect(phpSpaceship('b', 'a')).toBe(1);
		expect(levenshtein('kitten', 'sitting')).toBe(3);
	});
});

describe('byTime', () => {
	it('picks the largest unit with a rate of at least one', () => {
		expect(byTime(2.345, 2)).toBe('2.35 per second');
		expect(byTime(0.5, 1)).toBe('30 per minute');
		expect(byTime(0.001, 2)).toBe('3.6 per hour');
		expect(byTime(0.00001, 2)).toBe('0.86 per day');
		expect(byTime(0, 2)).toBe('<0.01 per day');
	});
});

describe('runAdvisor', () => {
	const url = { server: 1, serverDefault: 1, lang: 'en', hasLangCookie: true, token: 'token' };
	const base = {
		Uptime: '3600',
		Questions: '500',
		Slow_queries: '0',
		long_query_time: '10.000000',
		slow_query_log: 'OFF',
		version: '8.4.7',
		version_comment: 'MySQL Community Server - GPL',
		system_memory: 0,
		Sort_rows: '0',
		Sort_scan: '0',
		Sort_range: '0',
		Sort_merge_passes: '0',
	};

	it('fires matching rules with formatted justifications and variable links', () => {
		const result = runAdvisor({ variables: base, version: 80407, isMariaDB: false, url });
		const fired = result.fired.map(rule => rule.id);
		expect(fired).toContain('Uptime below one day');
		expect(result.fired[0]?.justification).toBe('The uptime is only 0 days, 1 hours, 0 minutes and 0 seconds');
		const slowLog = result.fired.find(rule => rule.id === 'Slow query logging');
		expect(slowLog?.recommendation).toContain('<a href="index.php?route=/server/variables&filter=slow_query_log">slow_query_log</a>');
		expect(result.unchecked.length).toBeGreaterThan(0);
		// Missing variables are reported for their rule only.
		expect(result.errors[0]).toMatch(/^Failed (evaluating precondition|calculating value|running test) for rule '.+'\. Error when evaluating: Variable ".+" is not valid/);
	});

	it('adds the pre-8.0.3 rules for MariaDB and old MySQL, and rewrites external links', () => {
		const mariadb = runAdvisor({ variables: { ...base, version: '10.11.6-MariaDB', query_cache_size: '0', query_cache_type: 'OFF', Com_select: '5', Qcache_hits: '0', innodb_log_file_size: null }, version: 101106, isMariaDB: true, url });
		expect(mariadb.fired.map(rule => rule.id)).toContain('Query cache disabled');
		expect(mariadb.unchecked.map(rule => rule.id)).toContain('Query cache efficiency (%)');
		const old = runAdvisor({ variables: { ...base, version: '5.7.44' }, version: 50744, isMariaDB: false, url });
		const modern = runAdvisor({ variables: base, version: 80407, isMariaDB: false, url });
		const total = (result: ReturnType<typeof runAdvisor>) => result.fired.length + result.notfired.length + result.unchecked.length + result.errors.length;
		expect(total(mariadb)).toBeGreaterThan(total(modern));
		expect(total(old)).toBe(total(mariadb));
		const percona = runAdvisor({ variables: { ...base, version_comment: 'Percona Server' }, version: 80407, isMariaDB: false, url });
		const rule = percona.fired.find(item => item.recommendation.includes('percona.com'));
		expect(rule?.recommendation).toContain('href="./url.php?url=https%3A%2F%2Fwww.percona.com%2Fsoftware%2Fdocumentation%2F" target="_blank" rel="noopener noreferrer"');
	});

	it('reports failing tests and justification formulas', () => {
		const result = runAdvisor({ variables: { ...base, Uptime: 'abc', slow_query_log: ['x'] as never }, version: 80407, isMariaDB: false, url });
		expect(result.errors.some(error => error.startsWith('Failed calculating value for rule'))).toBe(true);
		expect(result.errors.some(error => error.startsWith('Failed running test for rule \'Slow query logging\''))).toBe(false);
		// 'abc' > 3145728 compares as strings and fires, then the byte formatting multiplies a string.
		const failing = runAdvisor({ variables: { ...base, system_memory: 'abc', version_compile_machine: 'x', version_compile_os: 'x' }, version: 80407, isMariaDB: false, url });
		expect(failing.errors).toContain('Failed formatting string for rule \'MySQL Architecture\'. Error when evaluating: Unsupported operand types: string * int');
		expect(failing.fired.some(rule => rule.id === 'MySQL Architecture')).toBe(false);
		const sizes = runAdvisor({ variables: { ...base, tmp_table_size: '16777216', max_heap_table_size: '33554432' }, version: 80407, isMariaDB: false, url });
		expect(sizes.fired.find(rule => rule.id === 'Different tmp_table_size and max_heap_table_size')?.justification).toContain('16.00 MiB');
		const justification = runAdvisor({ variables: { ...base, Uptime: 10 }, version: 80407, isMariaDB: false, url });
		expect(justification.fired[0]?.justification).toBe('The uptime is only 0 days, 0 hours, 0 minutes and 10 seconds');
	});

	it('enforces the strict types of the Advisor helpers', () => {
		const result = runAdvisor({ variables: { ...base, version: 5 as never }, version: 80407, isMariaDB: false, url });
		expect(result.errors.some(error => error.includes('substr(): Argument #1 ($string) must be of type string, int given'))).toBe(true);
		const round = runAdvisor({ variables: { ...base, Questions: '500', Slow_queries: '31' }, version: 80407, isMariaDB: false, url });
		expect(round.fired.find(rule => rule.id === 'Percentage of slow queries')?.justification).toBe('The slow query rate should be below 5%, your value is 6%.');
	});
});

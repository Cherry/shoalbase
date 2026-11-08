import { describe, expect, it } from 'vitest';

import {
	findDelimiter,
	pregReplace,
	previewQuery,
	regexRowsQuery,
	replaceQuery,
} from './find-replace.ts';

describe('findDelimiter', () => {
	it('picks the first delimiter the pattern does not contain', () => {
		expect(findDelimiter('a+')).toBe('/');
		expect(findDelimiter('a/b')).toBe('@');
		expect(findDelimiter('/@#~!$%^&_')).toBeNull();
	});
});

describe('pregReplace', () => {
	// eslint-disable-next-line no-template-curly-in-string -- ${N} is PHP's preg_replace() reference syntax.
	it('replaces every match and expands \\N, $N and ${N} references', () => {
		// eslint-disable-next-line no-template-curly-in-string -- see above.
		expect(pregReplace('/([a-z])a/', '<$1\\1${1}>', 'Grace ada')).toBe('G<rrr>ce a<ddd>');
		expect(pregReplace('/x/', '\\\\', 'x')).toBe('\\');
		expect(pregReplace('/(a)|(b)/', '[$2]', 'ab')).toBe('[][b]');
	});

	it('passes named groups through and reports patterns that do not compile', () => {
		expect(pregReplace('/(?<first>a)/', '$1!', 'a')).toBe('a!');
		expect(pregReplace('/(/', 'x', 'a')).toBeNull();
	});
});

describe('find and replace SQL', () => {
	it('builds the preview and regex queries with a binary collation', () => {
		expect(previewQuery('name', 'db', 't', 'a', 'b', 'utf8mb4')).toBe('SELECT `name`, REPLACE(`name`, \'a\', \'b\'), COUNT(*) FROM `db`.`t` WHERE `name` LIKE \'%a%\' COLLATE utf8mb4_bin GROUP BY `name` ORDER BY `name` ASC');
		expect(regexRowsQuery('name', 'db', 't', 'a\'', 'utf8mb4')).toBe('SELECT `name`, 1, COUNT(*) FROM `db`.`t` WHERE `name` RLIKE \'a\\\'\' COLLATE utf8mb4_bin GROUP BY `name` ORDER BY `name` ASC');
	});

	it('builds the UPDATE for plain and regex replacements', () => {
		const base = { column: 'n', table: 't', find: 'a', replaceWith: 'b', charSet: 'utf8mb4' };
		expect(replaceQuery({ ...base, useRegex: false })).toBe('UPDATE `t` SET `n` = REPLACE(`n`, \'a\', \'b\') WHERE `n` LIKE \'%a%\' COLLATE utf8mb4_bin');
		expect(replaceQuery({ ...base, useRegex: true, toReplace: [['xa', 'xb'], ['a', null]] })).toBe('UPDATE `t` SET `n` = CASE\n WHEN `n` = \'xa\' THEN \'xb\'\n WHEN `n` = \'a\' THEN \'\' END WHERE `n` RLIKE \'a\' COLLATE utf8mb4_bin');
		expect(replaceQuery({ ...base, useRegex: true, toReplace: [] })).toBe('UPDATE `t` SET `n` = `n` WHERE `n` RLIKE \'a\' COLLATE utf8mb4_bin');
		expect(replaceQuery({ ...base, useRegex: true, toReplace: false })).toBe('UPDATE `t` SET `n` WHERE `n` RLIKE \'a\' COLLATE utf8mb4_bin');
	});
});

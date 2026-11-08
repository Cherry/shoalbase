import { describe, expect, it } from 'vitest';

import {
	expandUserString,
	finalFilenameAndMimetype,
	phpContentType,
	sanitizeFilename,
	strftime,
} from './filename.ts';

const vars = { httpHost: 'pma.test', serverName: 'db.host', serverVerbose: '', database: 'shop', table: 'orders' };

describe('strftime', () => {
	it('formats the C locale conversions in UTC and keeps unknown ones', () => {
		const date = new Date(Date.UTC(2024, 0, 5, 0, 7, 9));
		expect(strftime('%a %A %b %B %d %e %H %I %j %m %M %p %S %u %w %y %Y %% %Q', date)).toBe('Fri Friday Jan January 05  5 00 12 005 01 07 AM 09 5 5 24 2024 % %Q');
		expect(strftime('%I %p %u', new Date(Date.UTC(2024, 0, 7, 13)))).toBe('01 PM 7');
	});
});

describe('expandUserString', () => {
	it('replaces each placeholder once, after strftime', () => {
		expect(expandUserString('@SERVER@-__DB__-@TABLE@-%Y', { ...vars, table: '@DATABASE@' }, new Date(Date.UTC(2024, 0, 1)))).toBe('db.host-shop-@DATABASE@-2024');
		expect(expandUserString('@VSERVER@|@VERBOSE@|@HTTP_HOST@|@PHPMYADMIN@', vars, new Date())).toBe('db.host||pma.test|phpMyAdmin 5.2.3');
		expect(expandUserString('@VSERVER@', { ...vars, serverVerbose: 'Main' }, new Date())).toBe('Main');
	});

	it('escapes only the substituted values', () => {
		expect(expandUserString('a_b @TABLE@', { ...vars, table: 'x_y' }, new Date(), value => value.replaceAll('_', String.raw`\_`))).toBe(String.raw`a_b x\_y`);
	});
});

describe('sanitizeFilename', () => {
	it('replaces every UTF-8 byte of other characters, and dots on request', () => {
		expect(sanitizeFilename('a b.sql')).toBe('a_b.sql');
		expect(sanitizeFilename('a.b', true)).toBe('a_b');
		expect(sanitizeFilename('é-1')).toBe('__-1');
	});
});

describe('finalFilenameAndMimetype', () => {
	it('adds the extension unless present and the compression suffix', () => {
		expect(finalFilenameAndMimetype('sql', 'text/x-sql', 'none', 'dump')).toEqual(['dump.sql', 'text/x-sql']);
		expect(finalFilenameAndMimetype('sql', 'text/x-sql', 'gzip', 'dump.SQL')).toEqual(['dump.SQL.gz', 'application/x-gzip']);
		expect(finalFilenameAndMimetype('csv', 'text/csv', 'zip', 'x')).toEqual(['x.csv.zip', 'application/zip']);
	});
});

describe('phpContentType', () => {
	it('adds the default charset to text types only', () => {
		expect(phpContentType('text/x-sql')).toBe('text/x-sql;charset=utf-8');
		expect(phpContentType('text/plain; charset=latin1')).toBe('text/plain; charset=latin1');
		expect(phpContentType('application/zip')).toBe('application/zip');
	});
});

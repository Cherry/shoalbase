import { describe, expect, it } from 'vitest';

import {
	checkClient,
	jsErrorReport,
	nestedParam,
	sanitizeUrl,
} from './error-report.ts';

const environment = { userAgent: 'node', serverSoftware: 'Apache', locale: 'en', phpVersion: '8.3.36' };

describe('nestedParam', () => {
	it('rebuilds PHP arrays from bracketed request keys, with lists for 0..n keys', () => {
		const post = {
			'exception[message]': 'boom',
			'exception[stack][0][func]': 'f',
			'exception[stack][0][context]': ['a', 'b'],
			'exception[stack][1][func]': 'g',
			'other': 'x',
		};
		expect(nestedParam(post, 'exception')).toEqual({ message: 'boom', stack: [{ func: 'f', context: ['a', 'b'] }, { func: 'g' }] });
		expect(nestedParam({ exception: 'plain' }, 'exception')).toBe('plain');
		expect(nestedParam({ 'exception': 'x', 'exception[a]': 'y' }, 'exception')).toEqual({ a: 'y' });
		expect(nestedParam({}, 'exception')).toBeUndefined();
	});
});

describe('checkClient', () => {
	it('detects the platform and browser like Config::checkClient()', () => {
		const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
		expect(checkClient(chrome)).toEqual({ os: 'Win', agent: 'CHROME', version: '120.0.0.0' });
		expect(checkClient('Mozilla/5.0 (Macintosh) Version/17.1 Safari/605.1')).toEqual({ os: 'Mac', agent: 'SAFARI', version: '17.1' });
		expect(checkClient('Mozilla/5.0 (X11; Linux) Safari/533')).toEqual({ os: 'Linux', agent: 'SAFARI', version: '5.0.533' });
		expect(checkClient('Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0')).toEqual({ os: 'Linux', agent: 'FIREFOX', version: '120.0' });
		expect(checkClient('Opera/9.80 (Unix)')).toEqual({ os: 'Unix', agent: 'OPERA', version: '9.80' });
		expect(checkClient('Mozilla/4.0 (compatible; MSIE 8.0; OS/2)')).toEqual({ os: 'OS/2', agent: 'IE', version: '8.0' });
		expect(checkClient('Mozilla/5.0 (Trident/7.0; rv:11.0)')).toEqual({ os: 'Other', agent: 'IE', version: 11 });
		expect(checkClient('OmniWeb/622')).toEqual({ os: 'Other', agent: 'OMNIWEB', version: '622' });
		expect(checkClient('Konqueror/3.5; x')).toEqual({ os: 'Other', agent: 'KONQUEROR', version: '3.5' });
		expect(checkClient('Something rv:1.9.2 Gecko')).toEqual({ os: 'Other', agent: 'GECKO', version: '1.9' });
		expect(checkClient('Mozilla/5.0 (compatible; Firefox/1)')).toEqual({ os: 'Other', agent: 'MOZILLA', version: '5.0' });
		expect(checkClient('curl/8')).toEqual({ os: 'Other', agent: 'OTHER', version: 0 });
	});
});

describe('sanitizeUrl', () => {
	it('keeps the script name and drops deployment details from the query', () => {
		expect(sanitizeUrl('http://h/index.php?route=/sql&db=x&token=t&server=1#PMAURL-3:tbl_sql.php?table=y&eq=1&a=b')).toEqual(['tbl_sql.php?a=b', 'tbl_sql.php']);
		expect(sanitizeUrl('http://h/js/dist/sql.js?v=1')).toEqual(['js/dist/sql.js?v=1', 'js/dist/sql.js']);
		expect(sanitizeUrl('http://h/')).toEqual(['index.php?', 'index.php']);
		expect(sanitizeUrl('http://h/x#top')).toEqual(['index.php?', 'index.php']);
	});
});

describe('jsErrorReport', () => {
	it('is empty without an exception', () => {
		expect(jsErrorReport(undefined, undefined, undefined, environment)).toEqual({});
		expect(jsErrorReport('', undefined, undefined, environment)).toEqual({});
	});

	it('describes the exception, its stack and the page it happened on', () => {
		const long = 'x'.repeat(81);
		const report = jsErrorReport({ message: 'm', stack: [{ url: 'http://h/js/a.js', context: ['ok', long] }, { func: 'f' }] }, 'http://h/index.php?route=/x', 'steps', environment);
		expect(report).toEqual({
			pma_version: '5.2.3',
			browser_name: 'OTHER',
			browser_version: 0,
			user_os: 'Other',
			server_software: 'Apache',
			user_agent_string: 'node',
			locale: 'en',
			configuration_storage: 'disabled',
			php_version: '8.3.36',
			script_name: 'index.php',
			exception_type: 'js',
			exception: {
				message: 'm',
				stack: [
					{ context: ['ok', `${'x'.repeat(75)}//...`], uri: 'js/a.js?', scriptname: 'js/a.js' },
					{ func: 'f', uri: 'index.php?', scriptname: 'index.php' },
				],
				uri: 'index.php?route=%2Fx',
			},
			steps: 'steps',
		});
	});

	it('prefers the exception URL and has no script without any URL', () => {
		expect(jsErrorReport({ url: 'http://h/a.php', stack: 'raw' }, 'http://h/b.php', '', environment)).toMatchObject({ script_name: 'a.php', exception: { stack: 'raw', uri: 'a.php?' } });
		expect(jsErrorReport('text', undefined, undefined, environment)).toMatchObject({ script_name: null, exception: {} });
	});
});

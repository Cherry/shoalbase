import { describe, expect, it } from 'vitest';

import {
	getDocLinkByNameMariaDb,
	getDocLinkByNameMysql,
	getVariableType,
	linkToVarDocumentation,
} from './kbs.ts';
import { mysqlDieHtml } from './mysql-die.ts';
import { groupPlugins, pluginFromRow } from './plugins.ts';
import { deepTwigValue, twigVariables } from './twig-data.ts';
import {
	bytesText,
	formatVariable,
	isNumeric,
	isValidVariableName,
	setVariableValue,
} from './variables.ts';
import { listNavigatorVariables } from '../list-navigator.ts';
import { defaultMessageState } from '../message.ts';
import { numberFormat, phpRound } from '../util.ts';

const url = { server: 1, serverDefault: 1, lang: 'en', hasLangCookie: true, token: 'token' };
const state = { ...defaultMessageState, mysqlVersion: 80400 };

describe('mysqlDieHtml', () => {
	it('shows the query with copy and edit links and the server error', () => {
		const html = mysqlDieHtml({ serverMessage: '#1227 - Access   denied\n\n\n\nx\ty', sqlQuery: ' SHOW BINLOG EVENTS ', db: '', table: '', url, state });
		expect(html).toContain('data-text="SHOW BINLOG EVENTS">Copy</a>\n<a href="index.php?route=/server/sql&sql_query=SHOW+BINLOG+EVENTS&show_query=1">');
		expect(html).toContain('<code class="sql" dir="ltr"><pre>\nSHOW BINLOG EVENTS\n</pre></code>');
		expect(html).toContain('<code>#1227 - Access&nbsp;&nbsp; denied<br />\n<br />\nx&nbsp;&nbsp;&nbsp;&nbsp;y</code><br></div>');
		expect(html).not.toContain('Static analysis');
	});

	it('links the edit button to the table or database SQL page and documents SELECT errors', () => {
		const table = mysqlDieHtml({ serverMessage: '', sqlQuery: 'SELECT 1', db: 'd', table: 't', url, state });
		expect(table).toContain('route=/table/sql&sql_query=SELECT+1&show_query=1&db=d&table=t');
		expect(table).toContain('mysql_doc');
		expect(table).not.toContain('MySQL said');
		const database = mysqlDieHtml({ serverMessage: 'x', sqlQuery: 'DROP DATABASE d', db: 'd', table: '', url, state, isModifyLink: true });
		expect(database).toContain('route=/database/sql&sql_query=DROP+DATABASE+d&show_query=1&db=d');
		expect(mysqlDieHtml({ serverMessage: 'x', sqlQuery: 'DROP DATABASE d', db: '', table: '', url, state, isModifyLink: false })).not.toContain('b_edit');
	});

	it('lists static analysis errors and escapes the unparsable query', () => {
		const html = mysqlDieHtml({ serverMessage: 'x', sqlQuery: 'SELECT * FROM `a', db: '', table: '', url, state });
		expect(html).toContain('<p><strong>Static analysis:</strong></p>');
		expect(html).toMatch(/<p>\d+ errors were found during analysis\.<\/p>/);
		expect(html).toContain('<li>');
	});

	it('hides queries mentioning connect and anything without a query', () => {
		expect(mysqlDieHtml({ serverMessage: 'x', sqlQuery: 'connect', db: '', table: '', url, state })).not.toContain('SQL query');
		expect(mysqlDieHtml({ serverMessage: '', sqlQuery: '', db: '', table: '', url, state })).toBe('<div class="alert alert-danger" role="alert"><h1>Error</h1></div>');
	});
});

describe('plugins', () => {
	it('maps information_schema and SHOW PLUGINS rows', () => {
		expect(pluginFromRow({ PLUGIN_NAME: 'a', PLUGIN_STATUS: 'ACTIVE', PLUGIN_TYPE: 'AUDIT', PLUGIN_LICENSE: 'GPL', PLUGIN_VERSION: '1.0' })).toMatchObject({ name: 'a', version: '1.0', status: 'ACTIVE', type: 'AUDIT', license: 'GPL', library: null });
		expect(pluginFromRow({ Name: 'b', Status: 'ACTIVE', Type: 'STORAGE ENGINE', Library: null, License: 'GPL' })).toMatchObject({ name: 'b', type: 'STORAGE ENGINE', library: null, version: null });
		expect(pluginFromRow({})).toMatchObject({ name: '', status: '', type: '', license: '' });
	});

	it('groups by sorted type with CSS-safe type names', () => {
		const plugins = [pluginFromRow({ Name: 'x', Type: 'STORAGE ENGINE' }), pluginFromRow({ Name: 'y', Type: 'AUDIT' }), pluginFromRow({ Name: 'z', Type: 'AUDIT' })];
		const grouped = groupPlugins(plugins);
		expect(grouped.plugins.keys().toArray()).toEqual(['AUDIT', 'STORAGE ENGINE']);
		expect(grouped.plugins.get('AUDIT')?.map(plugin => plugin.name)).toEqual(['y', 'z']);
		expect(grouped.cleanTypes.get('STORAGE ENGINE')).toBe('storageengine');
	});
});

describe('kbs', () => {
	it('knows variable types and documentation pages per flavour', () => {
		expect(getVariableType('wsrep_received_bytes')).toBe('byte');
		expect(getVariableType('max_allowed_packet')).toBe('integer');
		expect(getVariableType('no_such_variable')).toBeNull();
		expect(getVariableType('Aborted_clients')).toBeNull();
		expect(getDocLinkByNameMysql('auto_increment_increment')).toBe('https://dev.mysql.com/doc/refman/8.0/en/replication-options-source.html#sysvar_auto_increment_increment');
		expect(getDocLinkByNameMariaDb('aria_block_size')).toMatch(/^https:\/\/mariadb\.com\/.*#aria_block_size$/);
		expect(getDocLinkByNameMysql('aria_block_size')).toBeNull();
		expect(getDocLinkByNameMysql('constructor')).toBeNull();
	});

	it('links known variables through url.php and falls back to the generic page', () => {
		expect(linkToVarDocumentation(state, 'auto_increment_increment', false, 'text')).toBe('<a href="./url.php?url=https%3A%2F%2Fdev.mysql.com%2Fdoc%2Frefman%2F8.0%2Fen%2Freplication-options-source.html%23sysvar_auto_increment_increment" target="mysql_doc">text</a>');
		expect(linkToVarDocumentation(state, 'aria_block_size', true)).toContain('mariadb.com');
		expect(linkToVarDocumentation(state, 'no_such_variable')).toContain('no-such-variable.html');
	});
});

describe('server variables', () => {
	it('detects PHP numeric values', () => {
		expect(isNumeric('12.5')).toBe(true);
		expect(isNumeric(3)).toBe(true);
		expect(isNumeric(NaN)).toBe(false);
		expect(isNumeric('ON')).toBe(false);
		expect(isNumeric(null)).toBe(false);
	});

	it('formats byte sizes, numbers and text', () => {
		expect(formatVariable('wsrep_received_bytes', '67108864')).toEqual(['<abbr title="67,108,864">64.000 MiB</abbr>', true]);
		expect(formatVariable('max_allowed_packet', '67108864')).toEqual(['67,108,864', false]);
		expect(formatVariable('max_connections', '151')).toEqual(['151', false]);
		expect(formatVariable('sql_mode', 'A,B')).toEqual(['A,B', false]);
		expect(bytesText('1024', 3, 3)).toBe('1.000 KiB');
		expect(bytesText('999', 3, 3)).toBe('999 B');
	});

	it('turns posted sizes into numbers and quotes text', () => {
		const escape = (value: string) => value.replaceAll('\'', String.raw`\'`);
		expect(setVariableValue('wsrep_received_bytes', '10MB', escape)).toBe('10485760');
		expect(setVariableValue('wsrep_received_bytes', '1.5 kib', escape)).toBe('1536');
		expect(setVariableValue('wsrep_received_bytes', '0.1kb', escape)).toBe('102.4');
		expect(setVariableValue('sql_mode', 'it\'s', escape)).toBe(String.raw`'it\'s'`);
		expect(setVariableValue('max_connections', '200', escape)).toBe('200');
		expect(setVariableValue('wsrep_received_bytes', '1e3 GB', escape)).toBe('\'1e3 GB\'');
		expect(setVariableValue('wsrep_received_bytes', '99999999999 GB', escape)).toBe('1.0737418239893E+20');
	});

	it('accepts only identifier variable names', () => {
		expect(isValidVariableName('max_connections')).toBe(true);
		expect(isValidVariableName('a-b')).toBe(false);
	});
});

describe('listNavigatorVariables', () => {
	const base = { pos: 0, urlParams: {}, script: 'index.php', frame: 'frame_content', name: 'pos', classes: [] };

	it('has no page selector when everything fits', () => {
		expect(listNavigatorVariables({ ...base, count: 3, maxCount: 100 })).toMatchObject({ max_count: 100, classes: [], page_selector: '' });
	});

	it('defaults empty or invalid limits to 250 and adds a page selector when needed', () => {
		const variables = listNavigatorVariables({ ...base, count: 300, maxCount: '', pos: 250 });
		expect(variables.max_count).toBe(250);
		expect(variables.classes).toEqual(['pageselector']);
		expect(variables.page_selector).toContain('<option selected="selected" style="font-weight: bold" value="250">2</option>');
		expect(listNavigatorVariables({ ...base, count: 1, maxCount: -5 }).max_count).toBe(250);
	});
});

describe('twig data', () => {
	it('turns nested maps, arrays and plain objects into Twig arrays but keeps objects with methods', () => {
		const object = { get: () => 1 };
		const converted = deepTwigValue(new Map<string, unknown>([['a', [{ b: 1 }]], ['c', object]])) as Map<string, unknown>;
		expect((converted.get('a') as unknown[])[0]).toEqual(new Map([['b', 1]]));
		expect(converted.get('c')).toBe(object);
		expect(deepTwigValue({ x: new Map([['y', { z: 2 }]]) })).toEqual(new Map([['x', new Map([['y', new Map([['z', 2]])]])]]));
		expect(twigVariables({ list: [1], text: 'a' })).toEqual({ list: [1], text: 'a' });
	});
});

describe('numberFormat of unsigned 64-bit maxima', () => {
	it('keeps floats beyond double precision unrounded, as PHP prints them on the variables page', () => {
		expect(numberFormat(2 ** 64)).toBe('18,446,744,073,709,551,616');
		expect(phpRound(1e15 + 0.5)).toBe(1e15 + 0.5);
	});
});

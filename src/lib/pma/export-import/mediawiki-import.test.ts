import { describe, expect, it } from 'vitest';

import { parseMediawiki } from './mediawiki-import.ts';

describe('parseMediawiki', () => {
	it('reads tables named by the export comments, with header and data rows', () => {
		const text = '<!--\nTable structure for `ignored`\n-->\n<!--\nTable data for `players`\n-->\n\n'
			+ '{| class="wikitable"\n|+\'\'\'players\'\'\'\n|-\n ! id\n ! name\n|-\n | 1\n | Ada\n|-\n | 2\n | \n|}\n';
		expect(parseMediawiki(text)).toEqual({ tables: [{ name: 'players', headers: ['id', 'name'], rows: [['1', 'Ada'], ['2', '']] }], error: false });
	});

	it('splits "||" and "!!" rows, keeps "||" inside quoted tag attributes and reads [[link|text]] cells', () => {
		const text = '{|\n! a !! b\n|-\n| [[Page|label]] || <span title="x||y">z</span> || [[Other|text]]\n|}\n{|\n|-\n| q\n|}\n';
		expect(parseMediawiki(text).tables).toEqual([
			{ name: '', headers: ['a', 'b'], rows: [['[[Page|label]]', '<span title="x||y">z</span>', 'text]]']] },
			// Headers carry over to the next table, as upstream keeps them in the same variable.
			{ name: '', headers: ['a', 'b'], rows: [['q']] },
		]);
	});

	it('flags lines that are not table markup but keeps reading', () => {
		expect(parseMediawiki('{|\n|-\n| 1\nnot markup\n|}\n')).toEqual({ tables: [{ name: '', headers: [], rows: [['1']] }], error: true });
	});

	it('closes a comment only on a line that is exactly "-->"', () => {
		const text = '<!--\nTable data for `t`\n--> trailing\n{|\n|}\n-->\n{|\n|-\n| 1\n|}\n';
		expect(parseMediawiki(text).tables).toEqual([{ name: 't', headers: [], rows: [['1']] }]);
	});

	it('handles quotes inside tags and single quotes', () => {
		const text = '{|\n|-\n| <a href=\'x||y\' title="it\'s|a">t</a> || <b>u</b>\n|}\n';
		expect(parseMediawiki(text).tables[0].rows).toEqual([['<a href=\'x||y\' title="it\'s|a">t</a>', '<b>u</b>']]);
	});

	it('never parses input without a newline', () => {
		expect(parseMediawiki('{| |}')).toEqual({ tables: [], error: false });
	});
});

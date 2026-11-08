import { describe, expect, it } from 'vitest';

import { descriptionAndTitle, foreignRows } from './browse-foreigners.ts';

describe('descriptionAndTitle', () => {
	it('cuts long descriptions by characters and keeps the full text as the title', () => {
		expect(descriptionAndTitle('short', 5)).toEqual(['short', '']);
		expect(descriptionAndTitle('ééééé!', 5)).toEqual(['ééééé...', 'ééééé!']);
	});
});

describe('foreignRows', () => {
	const dispRow = [
		{ id: '1', label: 'One' },
		{ id: '10', label: 'Ten' },
		{ id: '3', label: 'Three' },
		{ id: '2', label: null },
	];

	it('pairs keys sorted numerically on the left with descriptions in query order on the right', () => {
		const rows = foreignRows({ dispRow, foreignField: 'id', foreignDisplay: 'label', currentValue: '2.0', limitChars: 50, repeatCells: 0 });
		expect(rows.map(row => [row.left.keyname, row.right.keyname])).toEqual([['1', '1'], ['2', '10'], ['3', '3'], ['10', '2']]);
		expect(rows[1].left).toEqual({ keyname: '2', description: '', title: '', is_selected: true });
		expect(rows.some(row => row.repeatHeader)).toBe(false);
	});

	it('leaves descriptions empty without a display column, selects nothing for an empty value and repeats headers', () => {
		const rows = foreignRows({ dispRow, foreignField: 'id', foreignDisplay: '', currentValue: '0', limitChars: 50, repeatCells: 2 });
		expect(rows.every(row => row.left.description === '' && !row.left.is_selected)).toBe(true);
		expect(rows.map(row => row.repeatHeader)).toEqual([false, false, true, false]);
		expect(foreignRows({ dispRow: [{ label: 'x' }], foreignField: 'id', foreignDisplay: 'label', currentValue: '', limitChars: 1, repeatCells: 0 })[0].left.keyname).toBe('');
	});
});

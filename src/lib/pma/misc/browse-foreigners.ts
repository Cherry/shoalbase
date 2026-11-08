// BrowseForeigners: the rows of the "browse foreign values" dialog, by key name on the left and by description on the right.
import { phpCompareStrings } from '../php-compare.ts';
import { looseEquals } from '../table-data/relation.ts';

export interface ForeignCell {
	keyname: string;
	description: string;
	title: string;
	is_selected: boolean;
}

export interface ForeignRow {
	left: ForeignCell;
	right: ForeignCell;
	/** The header row is repeated before this row (RepeatCells). */
	repeatHeader: boolean;
}

/** BrowseForeigners::getDescriptionAndTitle(): long descriptions are cut, with the full text as the title. */
export function descriptionAndTitle(description: string, limitChars: number): [string, string] {
	const characters = [...description];
	if (characters.length <= limitChars) {
		return [description, ''];
	}
	return [`${characters.slice(0, limitChars).join('')}...`, description];
}

export interface ForeignRowsInput {
	dispRow: Record<string, string | null>[];
	foreignField: string;
	foreignDisplay: string;
	currentValue: string;
	limitChars: number;
	repeatCells: number;
}

/** BrowseForeigners::getHtmlForRelationalFieldSelection()'s loop: keys sorted with asort(), descriptions in query order. */
export function foreignRows(input: ForeignRowsInput): ForeignRow[] {
	const keys = input.dispRow.map(row => row[input.foreignField] ?? '');
	const descriptions = input.dispRow.map((row) => {
		if (input.foreignDisplay === '') {
			return '';
		}
		return row[input.foreignDisplay] ?? '';
	});
	// asort() is stable and compares numeric strings as numbers.
	const byKeyname = keys.map((_key, index) => index).toSorted((left, right) => phpCompareStrings(keys[left], keys[right]));
	const hasCurrent = input.currentValue !== '' && input.currentValue !== '0';
	const cell = (index: number): ForeignCell => {
		const [description, title] = descriptionAndTitle(descriptions[index], input.limitChars);
		return { keyname: keys[index], description, title, is_selected: hasCurrent && looseEquals(keys[index], input.currentValue) };
	};
	let horizontalCount = 0;
	return byKeyname.map((indexByKeyname, indexByDescription) => {
		horizontalCount++;
		let repeatHeader = false;
		if (input.repeatCells > 0 && horizontalCount > input.repeatCells) {
			repeatHeader = true;
			horizontalCount = 0;
		}
		return { left: cell(indexByKeyname), right: cell(indexByDescription), repeatHeader };
	});
}

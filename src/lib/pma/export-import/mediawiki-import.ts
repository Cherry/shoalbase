// The table markup reader of Plugins\Import\ImportMediawiki.

export interface MediawikiTable {
	/** From a "Table data for `name`" comment, or '' when the table had none. */
	name: string;
	headers: string[];
	rows: string[][];
}

// ImportMediawiki::delimiterReplace(): "||" inside a quoted tag attribute becomes the placeholder.
function delimiterReplace(replace: string, subject: string): string {
	let cleaned = '';
	let insideTag = false;
	let insideAttribute = false;
	let startAttributeCharacter = '';
	let partialSeparator = false;
	for (const character of subject) {
		if (character === '|') {
			if (!insideAttribute) {
				cleaned += character;
				if (partialSeparator) {
					insideTag = false;
					insideAttribute = false;
				}
			} else if (partialSeparator) {
				cleaned += replace;
			}
			partialSeparator = !partialSeparator;
			continue;
		}
		if (partialSeparator && insideAttribute) {
			cleaned += '|';
		}
		partialSeparator = false;
		cleaned += character;
		if (character === '<' && !insideAttribute) {
			insideTag = true;
		} else if (character === '>' && !insideAttribute) {
			insideTag = false;
		} else if ((character === '"' || character === '\'') && insideTag) {
			if (!insideAttribute) {
				insideAttribute = true;
				startAttributeCharacter = character;
			} else if (character === startAttributeCharacter) {
				insideAttribute = false;
				startAttributeCharacter = '';
			}
		}
	}
	return cleaned;
}

// ImportMediawiki::explodeMarkup(): splits a row on "||" outside attributes.
function explodeMarkup(text: string): string[] {
	const placeholder = '\0';
	return delimiterReplace(placeholder, text.replaceAll(placeholder, '')).split('||').map(item => item.replaceAll(placeholder, '||'));
}

// ImportMediawiki::getCellData(): a "[[link|text]]" style cell keeps what follows the first pipe.
function cellData(cell: string): string {
	const parts = cell.split('|');
	if (!parts[0].includes('[[') || parts.length === 1) {
		return cell;
	}
	return parts.slice(1).join('|');
}

// PHP's trim() character set.
const trim = (value: string): string => value.replaceAll(/^[ \t\n\r\0\v]+|[ \t\n\r\0\v]+$/g, '');

/** ImportMediawiki::doImport()'s parsing; `error` is set by unknown lines, which upstream reports without a message. */
export function parseMediawiki(text: string): { tables: MediawikiTable[]; error: boolean; } {
	const tables: MediawikiTable[] = [];
	let error = false;
	// Without a single newline the only chunk is never parsed.
	if (!text.includes('\n')) {
		return { tables, error };
	}
	let insideComment = false;
	let insideStructureComment = false;
	let tableName = '';
	let headers: string[] = [];
	let rows: string[][] = [];
	let line: string[] = [];
	let inHeader = false;
	for (const rawLine of text.split('\n')) {
		let current = trim(rawLine);
		if (current === '') {
			continue;
		}
		if (current.startsWith('<!--')) {
			insideComment = true;
			continue;
		}
		if (insideComment) {
			// strcmp() of a four character prefix with '-->' only matches a line that is exactly '-->'.
			if (current === '-->') {
				if (!insideStructureComment) {
					insideComment = false;
				}
			} else {
				const data = /^Table data for `(.*)`$/.exec(current);
				if (data !== null) {
					tableName = data[1];
					insideStructureComment = false;
				} else if (/^Table structure for `.*`$/.test(current)) {
					insideStructureComment = true;
				}
			}
			continue;
		}
		const start = current.slice(0, 2);
		if (current.startsWith('{|')) {
			rows = [];
			line = [];
			inHeader = false;
		} else if (['|-', '|+', '|}'].includes(start)) {
			if (line.length > 0) {
				if (inHeader) {
					headers = line;
				} else {
					rows.push(line);
				}
			}
			line = [];
			if (start === '|}') {
				tables.push({ name: tableName, headers, rows });
				tableName = '';
			}
		} else if (current[0] === '|' || current[0] === '!') {
			inHeader = current[0] === '!';
			if (inHeader) {
				current = current.replaceAll('!!', '||');
			}
			for (const cell of explodeMarkup(current)) {
				let content = trim(cellData(cell));
				for (const startCharacter of ['|', '!']) {
					if (content.startsWith(startCharacter)) {
						content = trim(content.slice(1));
					}
				}
				line.push(content);
			}
		} else {
			error = true;
		}
	}
	return { tables, error };
}

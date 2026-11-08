// The character state machine of Plugins\Import\ImportCsv::doImport(), run over the whole input at once.

export interface CsvOptions {
	/** Column separator, after strtr() of \n, \t and \r; may be several characters. */
	terminated: string;
	enclosed: string;
	escaped: string;
	/** One character, or 'auto' for \n, \r or \r\n. */
	newLine: string;
	/** $max_lines_constraint, or 0 to read every line. */
	maxLinesConstraint: number;
}

export interface CsvParse {
	/** Each line's values; an unenclosed NULL is null. */
	rows: (string | null)[][];
	/** "Invalid format of CSV input on line %d.": the line where splitting got stuck. */
	formatErrorLine: number | null;
}

/** ImportCsv's strtr() of the escape sequences users type into the form. */
export function unescapeCsvOption(value: string): string {
	return value.replaceAll(/\\[ntr]/g, sequence => ({ '\\n': '\n', '\\t': '\t', '\\r': '\r' })[sequence] as string);
}

/** ImportCsv::buildErrorsForParams(): the label of the first unusable option, or null. */
export function invalidCsvOption(options: Omit<CsvOptions, 'maxLinesConstraint'>): string | null {
	if (options.terminated === '') {
		return 'Columns terminated with';
	}
	const length = (value: string): number => [...value].length;
	if (length(options.enclosed) > 1) {
		return 'Columns enclosed with';
	}
	if (length(options.escaped) > 1) {
		return 'Columns escaped with';
	}
	if (length(options.newLine) !== 1 && options.newLine !== 'auto') {
		return 'Lines terminated with';
	}
	return null;
}

/** Splits CSV text into rows exactly as ImportCsv does, including its odd corners. */
export function parseCsv(text: string, options: CsvOptions): CsvParse {
	const { terminated, enclosed, escaped, newLine, maxLinesConstraint } = options;
	const auto = newLine === 'auto';
	const terminatedLength = [...terminated].length;
	const terminatedFirst = terminated[0];
	const chars = [...text];
	if (chars.length > 0) {
		const last = chars.at(-1);
		if (auto && last !== '\r' && last !== '\n') {
			chars.push('\n');
		} else if (!auto && last !== newLine) {
			chars.push(...newLine);
		}
	}
	const rows: (string | null)[][] = [];
	const hasNewLine = auto ? chars.includes('\r') || chars.includes('\n') : chars.join('').includes(newLine);
	if (!hasNewLine) {
		return { rows, formatErrorLine: null };
	}
	let base = 0;
	const at = (index: number): string => chars[base + index] ?? '';
	const isLineEnd = (ch: string): boolean => ch === newLine || (auto && (ch === '\r' || ch === '\n'));
	let len = chars.length;
	let i = 0;
	let lastI = -1;
	let lastLen: number | null = null;
	let line = 1;
	let values: (string | null)[] = [];
	let csvFinish = false;
	let formatErrorLine: number | null = null;
	// readCsvTerminatedString(): a multi-character separator is compared as a whole.
	const read = (): string => {
		let ch = at(i);
		if (terminatedLength > 1 && ch === terminatedFirst) {
			for (let offset = 1; offset < terminatedLength; offset++) {
				ch += at(i + offset);
			}
			i += terminatedLength - 1;
		}
		return ch;
	};
	// Going back to $fallbacki only moves past a separator's first character.
	const fallback = (index: number): void => {
		i = index;
		if (terminatedLength > 1 && at(i) === terminatedFirst) {
			i += terminatedLength - 1;
		}
	};
	let ch: string;
	let first = true;
	let limitReached = false;
	// Each pass of the chunk loop re-reads the current character, so a pass that stopped without progress trips the guard below.
	while ((first || i < len) && formatErrorLine === null && !limitReached) {
		first = false;
		ch = read();
		while (i < len) {
			if (lastI === i && lastLen === len) {
				formatErrorLine = line;
				break;
			}
			lastI = i;
			lastLen = len;
			if (!csvFinish) {
				if (ch === terminated) {
					if (i === len - 1) {
						break;
					}
					values.push('');
					i++;
					ch = read();
					continue;
				}
				const fallbackI = i;
				let needEnd = false;
				if (ch === enclosed) {
					if (i === len - 1) {
						break;
					}
					needEnd = true;
					i++;
					ch = read();
				}
				let fail = false;
				let value: string | null = '';
				while ((needEnd && (ch !== enclosed || enclosed === escaped)) || (!needEnd && !(ch === terminated || isLineEnd(ch)))) {
					// A separator read past the end leaves PHP spinning until its time limit; this stops with the format error instead.
					if (i >= len) {
						fail = true;
						break;
					}
					if (ch === escaped) {
						if (i === len - 1) {
							fail = true;
							break;
						}
						i++;
						ch = read();
						if (enclosed === escaped && (ch === terminated || isLineEnd(ch))) {
							break;
						}
					}
					value += ch;
					if (i === len - 1) {
					// The whole input is one chunk, so the last character is the end of the data.
						break;
					}
					i++;
					ch = read();
				}
				if (!needEnd && value === 'NULL') {
					value = null;
				}
				if (fail) {
					fallback(fallbackI);
					break;
				}
				if (needEnd && ch === enclosed) {
					if (i === len - 1) {
						ch = '';
					} else {
						i++;
						ch = read();
					}
				}
				if (isLineEnd(ch) || i === len - 1) {
					csvFinish = true;
				}
				if (ch === terminated) {
					if (i === len - 1) {
						fallback(fallbackI);
						break;
					}
					i++;
					ch = read();
				}
				values.push(value);
			}
			if (!csvFinish && !isLineEnd(ch)) {
				continue;
			}
			if (auto && ch === '\r' && at(i + 1) === '\n') {
				i++;
			}
			if (!csvFinish) {
				values.push('');
			}
			rows.push(values);
			line++;
			csvFinish = false;
			values = [];
			base += i + 1;
			len = chars.length - base;
			i = 0;
			lastI = -1;
			ch = read();
			if (maxLinesConstraint > 0 && line === maxLinesConstraint) {
				limitReached = true;
				break;
			}
		}
	}
	// With the whole input in one chunk and a line end appended, no values are ever left over after the last line.
	return { rows, formatErrorLine };
}

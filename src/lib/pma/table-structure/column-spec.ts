// Ports of the Util column-type helpers: extractColumnSpec(), parseEnumSetValues() and convertBitDefaultValue().
import { htmlspecialchars } from '../../twig/php.ts';

export interface ColumnSpec {
	type: string;
	spec_in_brackets: string;
	enum_set_values: string[];
	print_type: string;
	binary: boolean;
	unsigned: boolean;
	zerofill: boolean;
	attribute: string;
	can_contain_collation: boolean;
	displayed_type: string;
}

/** htmlspecialchars($value, ENT_COMPAT): single quotes stay as they are. */
export function escapeCompat(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;');
}

/** str_getcsv($line, ',', "'", '\\'): the escape character is kept, a doubled quote inside quotes is one quote. */
export function strGetCsv(line: string): string[] {
	const fields: string[] = [];
	let index = 0;
	for (;;) {
		let field = '';
		// fgetcsv() drops whitespace before an opening quote, as in "enum('a', 'b')".
		const leading = /^[\t\n\v\f\r ]*/.exec(line.slice(index))?.[0].length ?? 0;
		if (line[index + leading] === '\'') {
			index += leading;
		}
		if (line[index] === '\'') {
			index++;
			while (index < line.length) {
				const character = line[index];
				if (character === '\\' && index + 1 < line.length) {
					field += character + line[index + 1];
					index += 2;
				} else if (character === '\'' && line[index + 1] === '\'') {
					field += '\'';
					index += 2;
				} else if (character === '\'') {
					index++;
					break;
				} else {
					field += character;
					index++;
				}
			}
		}
		const end = line.indexOf(',', index);
		if (end === -1) {
			fields.push(field + line.slice(index));
			return fields;
		}
		fields.push(field + line.slice(index, end));
		index = end + 1;
	}
}

/** Util::parseEnumSetValues(). */
export function parseEnumSetValues(definition: string, escapeHtml = true): string[] {
	const inBrackets = /\((.*)\)/s.exec(definition)?.[1] ?? '';
	return strGetCsv(inBrackets).map((value) => {
		const unescaped = value.replaceAll('\\\\', '\\');
		return escapeHtml ? htmlspecialchars(unescaped) : unescaped;
	});
}

/** Util::convertBitDefaultValue(). */
export function convertBitDefaultValue(value: string | null): string {
	const decoded = (value ?? '').replaceAll('&quot;', '"').replaceAll('&#039;', '\'').replaceAll('&#39;', '\'')
		.replaceAll('&lt;', '<')
		.replaceAll('&gt;', '>')
		.replaceAll('&amp;', '&');
	return decoded.replace(/^b'(\d*)'?$/, '$1');
}

function countAndRemove(text: string, needle: string): [string, boolean] {
	const parts = text.split(needle);
	return [parts.join(''), parts.length > 1];
}

/** Util::extractColumnSpec(); `limitChars` is $cfg['LimitChars']. */
export function extractColumnSpec(columnSpecification: string, limitChars = 50): ColumnSpec {
	const characters = [...columnSpecification];
	const firstBracket = characters.indexOf('(');
	let type: string;
	let specInBrackets: string;
	if (firstBracket > 0) {
		const lastBracket = characters.lastIndexOf(')');
		// Without a closing bracket mb_strrpos() is false, which makes the length negative.
		const end = lastBracket === -1 ? characters.length - firstBracket - 1 : lastBracket;
		specInBrackets = characters.slice(firstBracket + 1, end).join('').trimEnd();
		type = characters.slice(0, firstBracket).join('').trimEnd()
			.toLowerCase();
	} else {
		type = columnSpecification.split(' ', 1)[0].toLowerCase();
		specInBrackets = '';
	}

	let enumSetValues: string[] = [];
	let printType: string;
	let binary = false;
	let unsigned = false;
	let zerofill = false;
	let compressed = false;
	if (type === 'enum' || type === 'set') {
		enumSetValues = parseEnumSetValues(columnSpecification, false);
		printType = `${type}(${specInBrackets.replaceAll('\',\'', '\', \'')})`;
	} else {
		printType = columnSpecification.toLowerCase();
		// BINARY( is the binary or varbinary type itself, not the attribute.
		if (printType.includes('binary') && !printType.includes('binary(')) {
			printType = printType.replaceAll('binary', '');
			binary = true;
		}
		[printType, zerofill] = countAndRemove(printType, 'zerofill');
		[printType, unsigned] = countAndRemove(printType, 'unsigned');
		[printType, compressed] = countAndRemove(printType, '/*!100301 compressed*/');
		printType = printType.replaceAll(/^[\t\n\v\r\0 ]+|[\t\n\v\r\0 ]+$/g, '');
	}

	let attribute = ' ';
	if (binary) {
		attribute = 'BINARY';
	}
	if (unsigned) {
		attribute = 'UNSIGNED';
	}
	if (zerofill) {
		attribute = 'UNSIGNED ZEROFILL';
	}
	if (compressed) {
		attribute = 'COMPRESSED=zlib';
	}

	const canContainCollation = !binary && /^(?:char|varchar|text|tinytext|mediumtext|longtext|set|enum)/.test(type);

	let displayedType = escapeCompat(printType);
	const printCharacters = [...printType];
	if (printCharacters.length > limitChars) {
		displayedType = `<abbr title="${htmlspecialchars(printType)}">${escapeCompat(`${printCharacters.slice(0, limitChars).join('')}...`)}</abbr>`;
	}

	return {
		type,
		spec_in_brackets: specInBrackets,
		enum_set_values: enumSetValues,
		print_type: printType,
		binary,
		unsigned,
		zerofill,
		attribute,
		can_contain_collation: canContainCollation,
		displayed_type: displayedType,
	};
}

/** ForeignKey::isSupported() for every engine except NDB, whose answer depends on the server's NDB version. */
export function isForeignKeySupportedEngine(engine: string): boolean {
	const upper = engine.toUpperCase();
	return upper === 'INNODB' || upper === 'PBXT';
}

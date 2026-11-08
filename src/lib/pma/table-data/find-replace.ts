// Pure parts of Controllers\Table\FindReplaceController: the SQL it runs and its preg_replace() of regex matches.
import { backquote } from '../../twig/sanitize.ts';
import { escapeString } from '../dbi-sql.ts';

const DELIMITERS = ['/', '@', '#', '~', '!', '$', '%', '^', '&', '_'];

/** The first delimiter that does not occur in the pattern, or null when every one does. */
export function findDelimiter(find: string): string | null {
	return DELIMITERS.find(delimiter => !find.includes(delimiter)) ?? null;
}

/** Splits a preg_replace() replacement into literal text and group references (\1, $1, ${1}). */
function replacementParts(replacement: string): (string | number)[] {
	const parts: (string | number)[] = [];
	let literal = '';
	const pattern = /\\(\d{1,2})|\$(\d{1,2})|\$\{(\d{1,2})\}|\\\\|[\s\S]/g;
	for (const match of replacement.matchAll(pattern)) {
		const group = match[1] ?? match[2] ?? match[3];
		if (group === undefined) {
			literal += match[0] === '\\\\' ? '\\' : match[0];
			continue;
		}
		parts.push(literal, Number(group));
		literal = '';
	}
	parts.push(literal);
	return parts;
}

/** preg_replace() with a delimited pattern and no modifiers; null when the pattern does not compile, as PHP returns then. */
export function pregReplace(delimitedPattern: string, replacement: string, subject: string): string | null {
	const delimiter = delimitedPattern[0];
	const body = delimitedPattern.slice(1, delimitedPattern.lastIndexOf(delimiter));
	let regex: RegExp;
	try {
		regex = new RegExp(body, 'g');
	} catch {
		return null;
	}
	const parts = replacementParts(replacement);
	return subject.replace(regex, (...args: unknown[]) => {
		// The replacer gets the match and its captures, then the offset, the subject and, with named groups, a groups object.
		const hasNamedGroups = typeof args.at(-1) === 'object' && args.at(-1) !== undefined;
		const captures = args.slice(0, hasNamedGroups ? -3 : -2) as (string | undefined)[];
		return parts.map(part => (typeof part === 'number' ? captures[part] ?? '' : part)).join('');
	});
}

/** The preview query of a plain (non-regex) find; upstream inserts the find and replace strings unescaped. */
export function previewQuery(column: string, db: string, table: string, find: string, replaceWith: string, charSet: string): string {
	const name = backquote(column);
	return `SELECT ${name}, REPLACE(${name}, '${find}', '${replaceWith}'), COUNT(*) FROM ${backquote(db)}.${backquote(table)} WHERE ${name} LIKE '%${find}%' COLLATE ${charSet}_bin GROUP BY ${name} ORDER BY ${name} ASC`;
}

/** The query listing the distinct values a regex find matches. */
export function regexRowsQuery(column: string, db: string, table: string, find: string, charSet: string): string {
	const name = backquote(column);
	return `SELECT ${name}, 1, COUNT(*) FROM ${backquote(db)}.${backquote(table)} WHERE ${name} RLIKE '${escapeString(find)}' COLLATE ${charSet}_bin GROUP BY ${name} ORDER BY ${name} ASC`;
}

/** FindReplaceController::replace()'s UPDATE; `toReplace` is the regex rows, or false when no delimiter fits the pattern. */
export function replaceQuery(input: { column: string; table: string; find: string; replaceWith: string; useRegex: boolean; charSet: string; toReplace?: [string, string | null][] | false; }): string {
	const name = backquote(input.column);
	if (!input.useRegex) {
		return `UPDATE ${backquote(input.table)} SET ${name} = REPLACE(${name}, '${input.find}', '${input.replaceWith}') WHERE ${name} LIKE '%${input.find}%' COLLATE ${input.charSet}_bin`;
	}
	let sql = `UPDATE ${backquote(input.table)} SET ${name}`;
	if (Array.isArray(input.toReplace)) {
		if (input.toReplace.length > 0) {
			sql += ' = CASE';
			for (const [original, replaced] of input.toReplace) {
				sql += `\n WHEN ${name} = '${escapeString(original)}' THEN '${escapeString(replaced ?? '')}'`;
			}
			sql += ' END';
		} else {
			sql += ` = ${name}`;
		}
	}
	return `${sql} WHERE ${name} RLIKE '${escapeString(input.find)}' COLLATE ${input.charSet}_bin`;
}

// File names and download headers of an export: Util::expandUserString(), Sanitize::sanitizeFilename() and friends.
import { PMA_VERSION } from '../header.ts';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const pad = (value: number, length = 2): string => String(value).padStart(length, '0');

/** strftime() in the C locale and UTC, as the official image runs it; unknown conversions stay as written. */
export function strftime(format: string, date: Date): string {
	const hours = date.getUTCHours();
	const start = Date.UTC(date.getUTCFullYear(), 0, 1);
	const dayOfYear = Math.floor((date.getTime() - start) / 86_400_000) + 1;
	const conversions: Record<string, () => string> = {
		'a': () => DAYS[date.getUTCDay()].slice(0, 3),
		'A': () => DAYS[date.getUTCDay()],
		'b': () => MONTHS[date.getUTCMonth()].slice(0, 3),
		'B': () => MONTHS[date.getUTCMonth()],
		'd': () => pad(date.getUTCDate()),
		'e': () => String(date.getUTCDate()).padStart(2, ' '),
		'H': () => pad(hours),
		'I': () => pad(hours % 12 === 0 ? 12 : hours % 12),
		'j': () => pad(dayOfYear, 3),
		'm': () => pad(date.getUTCMonth() + 1),
		'M': () => pad(date.getUTCMinutes()),
		'p': () => (hours >= 12 ? 'PM' : 'AM'),
		'S': () => pad(date.getUTCSeconds()),
		'u': () => String(date.getUTCDay() === 0 ? 7 : date.getUTCDay()),
		'w': () => String(date.getUTCDay()),
		'y': () => pad(date.getUTCFullYear() % 100),
		'Y': () => String(date.getUTCFullYear()),
		'%': () => '%',
	};
	return format.replaceAll(/%(.)/g, (match, conversion: string) => conversions[conversion]?.() ?? match);
}

export interface UserStringVars {
	httpHost: string;
	serverName: string;
	serverVerbose: string;
	database: string;
	table: string;
}

/** Util::expandUserString() without @COLUMNS@; `escape` is applied to every substituted value. */
export function expandUserString(template: string, vars: UserStringVars, date: Date, escape: (value: string) => string = value => value): string {
	const replacements: Record<string, string> = {
		'@HTTP_HOST@': vars.httpHost,
		'@SERVER@': vars.serverName,
		'__SERVER__': vars.serverName,
		'@VERBOSE@': vars.serverVerbose,
		'@VSERVER@': vars.serverVerbose === '' ? vars.serverName : vars.serverVerbose,
		'@DATABASE@': vars.database,
		'__DB__': vars.database,
		'@TABLE@': vars.table,
		'__TABLE__': vars.table,
		'@PHPMYADMIN@': `phpMyAdmin ${PMA_VERSION}`,
	};
	// strtr(): one pass, so replaced text is never expanded again.
	return strftime(template, date).replaceAll(/@(?:HTTP_HOST|SERVER|VERBOSE|VSERVER|DATABASE|TABLE|PHPMYADMIN)@|__(?:SERVER|DB|TABLE)__/g, token => escape(replacements[token]));
}

/** Sanitize::sanitizeFilename(); preg_replace() without /u replaces each UTF-8 byte of other characters. */
export function sanitizeFilename(filename: string, replaceDots = false): string {
	const encoder = new TextEncoder();
	return filename.replaceAll(replaceDots ? /[^\w-]/gu : /[^\w.-]/gu, character => '_'.repeat(encoder.encode(character).length));
}

/** Export::getFinalFilenameAndMimetypeForFilename(). */
export function finalFilenameAndMimetype(extension: string, mimeType: string, compression: string, filename: string): [string, string] {
	const required = `.${extension}`;
	let name = filename;
	if ([...name].slice(-[...required].length).join('').toLowerCase() !== required) {
		name += required;
	}
	let type = mimeType;
	if (compression === 'gzip') {
		name += '.gz';
		type = 'application/x-gzip';
	} else if (compression === 'zip') {
		name += '.zip';
		type = 'application/zip';
	}
	return [name, type];
}

/** PHP adds its default charset to a text/* Content-Type that has none. */
export function phpContentType(mimeType: string): string {
	if (mimeType.toLowerCase().startsWith('text/') && !mimeType.toLowerCase().includes('charset')) {
		return `${mimeType};charset=utf-8`;
	}
	return mimeType;
}

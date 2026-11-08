// Port of PhpMyAdmin\Linter and LintController's editor prefixes: sql-parser errors as CodeMirror lint markers.
import {
	Lexer,
	Parser,
	ParserError,
	type ParserErrorEntry,
} from '../../../sql-parser/index.ts';
import { htmlspecialchars } from '../../twig/php.ts';

export interface Lint {
	message: string;
	fromLine: number;
	fromColumn: number;
	toLine: number;
	toColumn: number;
	severity: string;
}

/** LintController::EDITOR_SQL_PREFIX: wraps routine, event and trigger bodies so they parse as whole statements. */
export const EDITOR_SQL_PREFIX: Record<string, string> = {
	event: 'DELIMITER $$ CREATE EVENT `a` ON SCHEDULE EVERY MINUTE DO\n',
	routine: 'DELIMITER $$ CREATE PROCEDURE `a`()\n',
	trigger: 'DELIMITER $$ CREATE TRIGGER `a` AFTER INSERT ON `b` FOR EACH ROW\n',
};

// The lexer indexes by code point only when the query has astral characters, like UtfString; positions follow it.
function characters(query: string): string[] {
	if (/[\uD800-\uDFFF]/.test(query)) {
		return [...query];
	}
	return query.split('');
}

/** Linter::getLines(): the start position of each line. */
export function getLines(query: string): number[] {
	const str = characters(query);
	const lines = [0];
	for (const [index, element] of str.entries()) {
		if (element === '\n') {
			lines.push(index + 1);
		}
	}
	return lines;
}

/** Linter::findLineNumberAndColumn(). */
export function findLineNumberAndColumn(lines: number[], pos: number): [number, number] {
	let line = 0;
	for (const [lineNo, lineStart] of lines.entries()) {
		if (lineStart > pos) {
			break;
		}
		line = lineNo;
	}
	return [line, pos - lines[line]];
}

/** One error of Linter::lint(); PHP reads a missing token as "" and a missing position as 0. */
export function lintMarker(lines: number[], [message, , token, position]: ParserErrorEntry): Lint {
	const text = token ?? '';
	const start = position ?? 0;
	const [fromLine, fromColumn] = findLineNumberAndColumn(lines, start);
	const [toLine, toColumn] = findLineNumberAndColumn(lines, start + [...text].length);
	return {
		message: `${htmlspecialchars(message)} (near <code>${htmlspecialchars(text)}</code>)`,
		fromLine,
		fromColumn,
		toLine,
		toColumn,
		severity: 'error',
	};
}

/** Linter::lint(). */
export function lint(query: string): Lint[] {
	if ([...query].length > 10000) {
		return [{
			message: 'Linting is disabled for this query because it exceeds the maximum length.',
			fromLine: 0,
			fromColumn: 0,
			toLine: 0,
			toColumn: 0,
			severity: 'warning',
		}];
	}
	const lexer = new Lexer(query);
	const parser = new Parser(lexer.list);
	const lines = getLines(query);
	return ParserError.get([lexer, parser]).map(entry => lintMarker(lines, entry));
}

/** LintController: lints with the editor's prefix, then moves the markers back to the editor's own lines. */
export function lintForEditor(query: string, editorType: unknown): Lint[] {
	let prefix = '';
	if (typeof editorType === 'string' && Object.hasOwn(EDITOR_SQL_PREFIX, editorType)) {
		prefix = EDITOR_SQL_PREFIX[editorType];
	}
	const lints = lint(prefix + query);
	if (prefix === '') {
		return lints;
	}
	return lints.map((item) => {
		if (item.fromLine === 0) {
			return item;
		}
		return { ...item, fromLine: item.fromLine - 1, toLine: item.toLine - 1 };
	});
}

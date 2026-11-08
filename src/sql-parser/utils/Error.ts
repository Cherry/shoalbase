// Port of PhpMyAdmin\SqlParser\Utils\Error (imported by phpMyAdmin as ParserError): collects and formats lexer and parser errors.
import { sprintf } from '../../lib/pma/sprintf.ts';
import { Lexer } from '../Lexer.ts';
import { Parser } from '../Parser.ts';
import { htmlspecialcharsDefault, phpStr } from '../php.ts';

/** [message, code, token text or character, position]. */
export type ParserErrorEntry = [string, number, string | null, number | null];

export const ParserError = {
	/** The errors of the given lexers and parsers, in order. */
	get(objs: (Lexer | Parser)[]): ParserErrorEntry[] {
		const ret: ParserErrorEntry[] = [];

		for (const obj of objs) {
			if (obj instanceof Lexer) {
				for (const err of obj.errors) {
					ret.push([err.getMessage(), err.getCode(), err.ch, err.pos]);
				}
			} else if (obj instanceof Parser) {
				for (const err of obj.errors) {
					ret.push([err.getMessage(), err.getCode(), err.token === null ? '' : err.token.token, err.token === null ? null : err.token.position]);
				}
			}
		}

		return ret;
	},

	/** One formatted line per error; the format gets the 1-based index, message, code, token and position. */
	format(errors: ParserErrorEntry[], format = '#%1$d: %2$s (near "%4$s" at position %5$d)'): string[] {
		return errors.map((err, i) => sprintf(format, i + 1, err[0], err[1], htmlspecialcharsDefault(phpStr(err[2])), err[3]));
	},
};

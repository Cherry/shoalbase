// Port of PhpMyAdmin\SqlParser\Components\RenameOperation: old_name TO new_name pairs of RENAME TABLE.
import { Component } from '../Component.ts';
import { phpEmpty, phpStr } from '../php.ts';
import { Token } from '../Token.ts';
import { Expression } from './Expression.ts';

import type { Parser } from '../Parser.ts';
import type { TokensList } from '../TokensList.ts';

export class RenameOperation extends Component {
	static parse(parser: Parser, list: TokensList): RenameOperation[] {
		const ret: RenameOperation[] = [];

		let expr = new this();
		let state = 0;

		for (; list.idx < list.count; ++list.idx) {
			const token = list.tokens[list.idx];

			if (token.type === Token.TYPE_DELIMITER) {
				break;
			}

			if (token.type === Token.TYPE_WHITESPACE || token.type === Token.TYPE_COMMENT) {
				continue;
			}

			if (state === 0) {
				expr.old = Expression.parse(parser, list, { breakOnAlias: true, parseField: 'table' });
				if (phpEmpty(expr.old)) {
					parser.error('The old name of the table was expected.', token);
				}
				state = 1;
			} else if (state === 1) {
				if (token.type !== Token.TYPE_KEYWORD || token.keyword !== 'TO') {
					parser.error('Keyword "TO" was expected.', token);
					break;
				}
				state = 2;
			} else if (state === 2) {
				expr.new = Expression.parse(parser, list, { breakOnAlias: true, parseField: 'table' });
				if (phpEmpty(expr.new)) {
					parser.error('The new name of the table was expected.', token);
				}
				state = 3;
			} else if (state === 3) {
				if (token.type !== Token.TYPE_OPERATOR || token.value !== ',') {
					break;
				}
				ret.push(expr);
				expr = new this();
				state = 0;
			}
		}

		if (state !== 3) {
			parser.error('A rename operation was expected.', list.tokens[list.idx - 1] ?? null);
		}

		// The last iteration was not saved.
		if (!phpEmpty(expr.old)) {
			ret.push(expr);
		}

		--list.idx;
		return ret;
	}

	static build(component: RenameOperation | RenameOperation[] | null): string {
		if (Array.isArray(component)) {
			return component.map(item => phpStr(item)).join(', ');
		}
		// A null component reads both properties from null, as PHP does.
		return `${phpStr(component?.old)} TO ${phpStr(component?.new)}`;
	}

	old: Expression | null;

	new: Expression | null;

	constructor(oldName: Expression | null = null, newName: Expression | null = null) {
		super();
		this.old = oldName;
		this.new = newName;
	}
}

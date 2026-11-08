// Port of PhpMyAdmin\SqlParser\Statements\ReplaceStatement.
import { Array2d } from '../components/Array2d.ts';
import { IntoKeyword } from '../components/IntoKeyword.ts';
import { OptionsArray, type OptionsSpec } from '../components/OptionsArray.ts';
import { SetOperation } from '../components/SetOperation.ts';
import { phpStr, phpTrim } from '../php.ts';
import { Statement } from '../Statement.ts';
import { Token } from '../Token.ts';
import { SelectStatement } from './SelectStatement.ts';

import type { ArrayObj } from '../components/ArrayObj.ts';
import type { Parser } from '../Parser.ts';
import type { TokensList } from '../TokensList.ts';

export class ReplaceStatement extends Statement {
	static override OPTIONS: OptionsSpec = {
		LOW_PRIORITY: 1,
		DELAYED: 1,
	};

	declare into: IntoKeyword | null;
	declare values: ArrayObj[] | null;
	declare set: SetOperation[] | null;
	declare select: SelectStatement | null;

	protected override initProperties(): void {
		this.into = null;
		this.values = null;
		this.set = null;
		this.select = null;
	}

	override build(): string {
		let ret = `REPLACE ${phpStr(this.options)}`;
		ret = `${phpTrim(ret)} INTO ${phpStr(this.into)}`;

		if (this.values !== null && this.values.length > 0) {
			ret += ` VALUES ${Array2d.build(this.values)}`;
		} else if (this.set !== null && this.set.length > 0) {
			ret += ` SET ${SetOperation.build(this.set)}`;
		} else if (this.select !== null && phpStr(this.select).length > 0) {
			ret += ` ${this.select.build()}`;
		}

		return ret;
	}

	override parse(parser: Parser, list: TokensList): void {
		// Skipping REPLACE.
		++list.idx;

		this.options = OptionsArray.parse(parser, list, ReplaceStatement.OPTIONS);
		++list.idx;

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
				if (token.type === Token.TYPE_KEYWORD && token.keyword !== 'INTO') {
					parser.error('Unexpected keyword.', token);
					break;
				}

				++list.idx;
				this.into = IntoKeyword.parse(parser, list, { fromReplace: true });

				state = 1;
			} else if (state === 1) {
				if (token.type !== Token.TYPE_KEYWORD) {
					parser.error('Unexpected token.', token);
					break;
				}

				if (token.keyword === 'VALUE' || token.keyword === 'VALUES') {
					++list.idx;
					this.values = Array2d.parse(parser, list);
				} else if (token.keyword === 'SET') {
					++list.idx;
					this.set = SetOperation.parse(parser, list);
				} else if (token.keyword === 'SELECT') {
					this.select = new SelectStatement(parser, list);
				} else {
					parser.error('Unexpected keyword.', token);
					break;
				}

				state = 2;
			}
		}

		--list.idx;
	}
}

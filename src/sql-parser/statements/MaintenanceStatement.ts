// Port of PhpMyAdmin\SqlParser\Statements\MaintenanceStatement: [options] tables [more options].
import { OptionsArray } from '../components/OptionsArray.ts';
import { Statement } from '../Statement.ts';

import type { Expression } from '../components/Expression.ts';
import type { Parser } from '../Parser.ts';
import type { TokensList } from '../TokensList.ts';

export class MaintenanceStatement extends Statement {
	declare tables: Expression[] | null;

	protected override initProperties(): void {
		this.tables = null;
	}

	/** The tables come from Parser::$KEYWORD_PARSERS; the options after them are merged here. */
	override after(parser: Parser, list: TokensList): void {
		++list.idx;
		const more = OptionsArray.parse(parser, list, this.statics().OPTIONS);
		if (this.options === null) {
			// PHP calls merge() on null here, which is a fatal error; keep the parsed options instead.
			this.options = more;
			return;
		}
		this.options.merge(more);
	}
}

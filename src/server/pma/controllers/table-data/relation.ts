// ConfigStorage\Relation without a configuration storage: foreign keys come from SHOW CREATE TABLE only.
import { escapeString } from '../../../../lib/pma/dbi-sql.ts';
import {
	type DropdownConfig,
	type Foreigner,
	type Foreigners,
	searchColumnInForeigners,
} from '../../../../lib/pma/table-data/relation.ts';
import { getTypeClass } from '../../../../lib/pma/table-data/types.ts';
import { backquote } from '../../../../lib/twig/sanitize.ts';
import {
	Context,
	CreateStatement,
	Parser,
	Table as TableUtils,
} from '../../../../sql-parser/index.ts';
import { Table } from '../../core/table.ts';

import type { PmaContext } from '../../core/context.ts';
import type { DbiRow } from '../../core/dbi.ts';

/** DatabaseInterface::postConnect() picks the parser context closest to the server; it is global state, so set it right before parsing. */
export function loadParserContext(context: PmaContext): void {
	const { dbi } = context;
	Context.loadClosest(`${dbi.isMariaDB() ? 'MariaDb' : 'MySql'}${dbi.getVersion()}`);
}

/** Relation::getForeigners($db, $table, '', $source). */
export async function getForeigners(context: PmaContext, db: string, table: string, source = 'both'): Promise<Foreigners> {
	const foreigners: Foreigners = {};
	if ((source === 'both' || source === 'foreign') && table !== '') {
		const showCreate = await Table.get(context, table, db).showCreate();
		if (showCreate !== '') {
			await context.dbi.connect();
			loadParserContext(context);
			const statement = new Parser(showCreate).statements[0];
			foreigners.foreign_keys_data = statement instanceof CreateStatement ? TableUtils.getForeignKeys(statement) : [];
		}
	}
	return foreigners;
}

/** Relation::searchColumnInForeigners() with the current database for keys that name no database. */
export function searchForeigner(context: PmaContext, foreigners: Foreigners, column: string): Foreigner | false {
	return searchColumnInForeigners(foreigners, column, context.db);
}

/** Relation::getDisplayField(): without pmadb, the emulated information_schema fields or the first character column. */
export async function getDisplayField(context: PmaContext, db: string, table: string): Promise<string | false> {
	if (db === 'information_schema') {
		if (table === 'CHARACTER_SETS') {
			return 'DESCRIPTION';
		}
		if (table === 'TABLES') {
			return 'TABLE_COMMENT';
		}
	}
	const columns = await context.dbi.getColumnsFull(db, table);
	for (const column of columns.values()) {
		if (getTypeClass(column.DATA_TYPE) === 'CHAR') {
			return column.COLUMN_NAME ?? '';
		}
	}
	return false;
}

export interface ForeignData {
	foreign_link: boolean;
	the_total: number | string | null;
	foreign_display: string;
	disp_row: DbiRow[] | null;
	foreign_field: string | null;
}

/** Relation::getForeignData(). */
export async function getForeignData(
	context: PmaContext,
	foreigners: Foreigners | null,
	field: string,
	overrideTotal: boolean,
	foreignFilter: string,
	foreignLimit: string,
	getTotal = false,
): Promise<ForeignData> {
	const { dbi, config } = context;
	let foreignLink = false;
	let dispRow: DbiRow[] | null = null;
	let foreignDisplay: string | false = '';
	let theTotal: number | string | null = null;
	let foreignField: string | null = null;
	const foreigner = foreigners === null || Object.keys(foreigners).length === 0 ? false : searchForeigner(context, foreigners, field);
	if (foreigner !== false) {
		foreignField = foreigner.foreign_field;
		const moreThanLimit = await Table.get(context, foreigner.foreign_table, foreigner.foreign_db).checkIfMinRecordsExist(config.ForeignKeyMaxLimit);
		if (overrideTotal || !moreThanLimit) {
			foreignDisplay = await getDisplayField(context, foreigner.foreign_db, foreigner.foreign_table);
			const main = `SELECT ${backquote(foreigner.foreign_field)}${foreignDisplay === false ? '' : `, ${backquote(foreignDisplay)}`}`;
			const from = ` FROM ${backquote(foreigner.foreign_db)}.${backquote(foreigner.foreign_table)}`;
			let filter = '';
			if (foreignFilter !== '') {
				filter = ` WHERE ${backquote(foreigner.foreign_field)} LIKE "%${escapeString(foreignFilter)}%"`;
				if (foreignDisplay !== false) {
					filter += ` OR ${backquote(foreignDisplay)} LIKE "%${escapeString(foreignFilter)}%"`;
				}
			}
			const order = foreignDisplay === false ? '' : ` ORDER BY ${backquote(foreigner.foreign_table)}.${backquote(foreignDisplay)}`;
			if (foreignFilter !== '') {
				const total = await dbi.fetchValue(`SELECT COUNT(*)${from}${filter}`);
				theTotal = total === false ? 0 : total;
			}
			const result = await dbi.tryQuery(main + from + filter + order + foreignLimit);
			if (result !== false && result.numRows() > 0) {
				dispRow = result.fetchAllAssoc();
			} else {
				foreignLink = true;
			}
		} else {
			foreignLink = true;
		}
		if (getTotal) {
			const count = await Table.get(context, foreigner.foreign_table, foreigner.foreign_db).countRecords(true);
			theTotal = count === false ? 0 : count;
		}
	}
	return {
		foreign_link: foreignLink,
		the_total: theTotal,
		foreign_display: foreignDisplay === false ? '' : foreignDisplay,
		disp_row: dispRow,
		foreign_field: foreignField,
	};
}

/** Relation::getComments($db, $table): the native column comments. */
export async function getComments(context: PmaContext, db: string, table: string): Promise<Record<string, string>> {
	const comments: Record<string, string> = {};
	const columns = await context.dbi.getColumns(db, table, true);
	for (const column of columns.values()) {
		const comment = column.Comment;
		if (comment !== undefined && comment !== null && comment !== '' && comment !== '0') {
			comments[column.Field ?? ''] = comment;
		}
	}
	return comments;
}

/** The $cfg entries Relation::foreignDropdown() reads. */
export function dropdownConfig(context: PmaContext): DropdownConfig {
	const { config } = context;
	return {
		NaturalOrder: config.NaturalOrder,
		LimitChars: config.LimitChars,
		ForeignKeyMaxLimit: config.ForeignKeyMaxLimit,
		ForeignKeyDropdownOrder: config.ForeignKeyDropdownOrder,
	};
}

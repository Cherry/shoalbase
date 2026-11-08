// Port of PhpMyAdmin\SqlParser\Utils\Table: foreign keys and column details of a CREATE TABLE statement.
import { member, phpBool, phpStr } from '../php.ts';

import type { CreateStatement } from '../statements/CreateStatement.ts';
import type { TokenValue } from '../Token.ts';

export interface ForeignKey {
	constraint: TokenValue;
	index_list: TokenValue[];
	ref_db_name?: TokenValue;
	ref_table_name?: TokenValue;
	ref_index_list?: string[];
	on_update?: string;
	on_delete?: string;
}

export interface TableField {
	type: string | null;
	timestamp_not_null: boolean;
	default_value?: unknown;
	default_current_timestamp?: boolean;
	on_update_current_timestamp?: boolean;
	generated?: boolean;
	expr?: unknown;
}

/** PHP array keys: null becomes '' and other scalars are cast to strings. */
function key(value: TokenValue): string {
	if (value === null || value === false) {
		return '';
	}
	return value === true ? '1' : phpStr(value);
}

export const Table = {
	getForeignKeys(statement: CreateStatement): ForeignKey[] {
		if (!Array.isArray(statement.fields) || statement.fields.length === 0 || !member(statement.options).has('TABLE')) {
			return [];
		}

		const ret: ForeignKey[] = [];

		for (const field of statement.fields) {
			if (field.key === null || field.key.type !== 'FOREIGN KEY') {
				continue;
			}

			const columns: TokenValue[] = [];
			for (const column of field.key.columns) {
				if (column.name === undefined || column.name === null) {
					continue;
				}
				columns.push(column.name);
			}

			const tmp: ForeignKey = {
				constraint: field.name,
				index_list: columns,
			};

			if (field.references !== null) {
				tmp.ref_db_name = field.references.table?.database ?? null;
				tmp.ref_table_name = field.references.table?.table ?? null;
				tmp.ref_index_list = field.references.columns;

				let opt = member(field.references.options).has('ON UPDATE');
				if (phpBool(opt)) {
					tmp.on_update = phpStr(opt).replaceAll(' ', '_');
				}

				opt = member(field.references.options).has('ON DELETE');
				if (phpBool(opt)) {
					tmp.on_delete = phpStr(opt).replaceAll(' ', '_');
				}
			}

			ret.push(tmp);
		}

		return ret;
	},

	getFields(statement: CreateStatement): Record<string, TableField> {
		if (!Array.isArray(statement.fields) || statement.fields.length === 0 || !member(statement.options).has('TABLE')) {
			return {};
		}

		const ret: Record<string, TableField> = {};

		for (const field of statement.fields) {
			// Skipping keys.
			if (field.type === null) {
				continue;
			}

			const name = key(field.name);
			ret[name] = {
				type: field.type.name,
				timestamp_not_null: false,
			};

			if (!field.options) {
				continue;
			}

			if (field.type.name === 'TIMESTAMP' && field.options.has('NOT NULL')) {
				ret[name].timestamp_not_null = true;
			}

			let option = field.options.has('DEFAULT');

			if (phpBool(option)) {
				ret[name].default_value = option;
				if (option === 'CURRENT_TIMESTAMP') {
					ret[name].default_current_timestamp = true;
				}
			}

			option = field.options.has('ON UPDATE');

			if (option === 'CURRENT_TIMESTAMP') {
				ret[name].on_update_current_timestamp = true;
			}

			option = field.options.has('AS');

			if (!phpBool(option)) {
				continue;
			}

			ret[name].generated = true;
			ret[name].expr = option;
		}

		return ret;
	},
};

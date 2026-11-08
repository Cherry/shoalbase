// Pure parts of PhpMyAdmin\Database\Designer and Designer\Common without configuration storage (no pages, no settings).
import { isForeignKeySupportedEngine } from '../table-structure/column-spec.ts';

/** Database\Designer\DesignerTable; its getters are called from the templates. */
export class DesignerTable {
	constructor(
		private readonly databaseName: string,
		private readonly tableName: string,
		private readonly tableEngine: string,
		private readonly displayField: string | null,
	) {}

	supportsForeignkeys(): boolean {
		return isForeignKeySupportedEngine(this.tableEngine);
	}

	getDatabaseName(): string {
		return this.databaseName;
	}

	getTableName(): string {
		return this.tableName;
	}

	getTableEngine(): string {
		return this.tableEngine;
	}

	getDisplayField(): string | null {
		return this.displayField;
	}

	getDbTableString(): string {
		return `${this.databaseName}.${this.tableName}`;
	}
}

/** Common::getColumnsInfo() for one table: parallel lists by column position. */
export interface TableColumns {
	COLUMN_ID: number[];
	COLUMN_NAME: string[];
	TYPE: string[];
	NULLABLE: string[];
}

/** The column icon of Designer::getHtmlForMain() and getDatabaseTables(), by "db.table.column". */
export function columnsType(tables: DesignerTable[], tabColumn: Map<string, TableColumns>, pkOrUniqueKeys: Map<string, number>): Map<string, string> {
	const types = new Map<string, string>();
	for (const table of tables) {
		const name = table.getDbTableString();
		const columns = tabColumn.get(name);
		// A table without columns, such as a broken view, has no entry.
		if (columns === undefined) {
			continue;
		}
		for (const [index, column] of columns.COLUMN_NAME.entries()) {
			const key = `${name}.${column}`;
			if (pkOrUniqueKeys.has(key)) {
				types.set(key, 'designer/FieldKey_small');
				continue;
			}
			const type = String(columns.TYPE[index]);
			let icon = 'designer/Field_small';
			if (type.includes('char') || type.includes('text')) {
				icon += '_char';
			} else if (['int', 'float', 'double', 'decimal'].some(part => type.includes(part))) {
				icon += '_int';
			} else if (['date', 'time', 'year'].some(part => type.includes(part))) {
				icon += '_date';
			}
			types.set(key, icon);
		}
	}
	return types;
}

/** PHP's rawurlencode(): like encodeURIComponent() but also escaping !*'(). */
export function rawurlencode(value: string): string {
	return encodeURIComponent(value).replaceAll(/[!'()*]/g, character => `%${character.codePointAt(0)?.toString(16).toUpperCase()}`);
}

/** Common::getScriptTabs(); a JSON object (or an empty PHP array) per key. */
export function scriptTabs(tables: DesignerTable[]): { j_tabs: Record<string, number> | []; h_tabs: Record<string, number> | []; } {
	if (tables.length === 0) {
		return { j_tabs: [], h_tabs: [] };
	}
	const jTabs: Record<string, number> = {};
	const hTabs: Record<string, number> = {};
	for (const table of tables) {
		const key = rawurlencode(table.getDbTableString());
		jTabs[key] = table.supportsForeignkeys() ? 1 : 0;
		hTabs[key] = 1;
	}
	return { j_tabs: jTabs, h_tabs: hTabs };
}

/** One foreign key column as Common::getScriptContr() lists it, already rawurlencode()d. */
export interface Constraint {
	name: string;
	sourceTable: string;
	sourceColumn: string;
	targetTable: string;
	targetColumn: string;
}

/** The relation list of Common::getScriptContr(): only constraints between two shown tables keep their columns. */
export function scriptContr(constraints: Constraint[], tables: DesignerTable[]): Record<string, unknown>[] {
	const shown = new Set(tables.map(table => rawurlencode(table.getDbTableString())));
	return constraints.map((constraint) => {
		if (!shown.has(constraint.sourceTable) || !shown.has(constraint.targetTable)) {
			return { [constraint.name]: [] };
		}
		return { [constraint.name]: { [constraint.sourceTable]: { [constraint.sourceColumn]: [constraint.targetTable, constraint.targetColumn] } } };
	});
}

/** Designer::returnClassNamesFromMenuButtons() without stored designer settings. */
export const MENU_BUTTON_CLASSES = {
	angular_direct: 'M_butt',
	snap_to_grid: 'M_butt',
	pin_text: 'M_butt',
	relation_lines: 'M_butt',
	small_big_all: 'M_butt',
	side_menu: 'M_butt',
};

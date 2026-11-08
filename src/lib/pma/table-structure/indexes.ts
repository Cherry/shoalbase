// Pure parts of the index form: Table::getNameAndTypeOfTheColumns() and the add_fields arithmetic of IndexesController.

/** Table::getNameAndTypeOfTheColumns() for SHOW FULL COLUMNS rows: ENUM and SET values are spaced and quote-escaped. */
export function nameAndTypeOfColumns(rows: Iterable<Record<string, string | null>>): Map<string, string> {
	const columns = new Map<string, string>();
	for (const row of rows) {
		const type = row.Type ?? '';
		const match = /^(set|enum)\((.+)\)$/is.exec(type);
		if (match) {
			const values = `,${match[2]}`.replaceAll(/([^,])''/g, String.raw`$1\'`).slice(1);
			columns.set(row.Field ?? '', `${match[1]}(${values.replaceAll(',', ', ')})`);
		} else {
			columns.set(row.Field ?? '', type);
		}
	}
	return columns;
}

// is_numeric() for a request value.
function isNumeric(value: unknown): value is string {
	return typeof value === 'string' && /^[ \t\n\r\v\f]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?[ \t\n\r\v\f]*$/i.test(value);
}

/** The number of empty column rows IndexesController::displayForm() adds when creating an index. */
export function createIndexFieldCount(addedFields: unknown): number {
	if (isNumeric(addedFields) && Number(addedFields) >= 2) {
		return Math.min(Math.trunc(Number(addedFields)), 16);
	}
	return 1;
}

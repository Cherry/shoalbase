// Pure parts of Table\Maintenance and the Dbal value objects its controllers validate with.

// DatabaseName::MAX_LENGTH and TableName::MAX_LENGTH.
const MAX_NAME_LENGTH = 64;

/** Webmozart Assert's typeToString() for the non-string request values it sees: missing ones and lists. */
function typeToString(value: unknown): string {
	if (value === null || value === undefined) {
		return 'NULL';
	}
	return 'array';
}

/** DatabaseName::fromValue() and TableName::fromValue(): the Webmozart message of the first failed assertion, or null. */
export function nameAssertionError(value: unknown): string | null {
	if (typeof value !== 'string') {
		return `Expected a string. Got: ${typeToString(value)}`;
	}
	if (value === '') {
		return 'Expected a different value than "".';
	}
	if ([...value].length > MAX_NAME_LENGTH) {
		return `Expected a value to contain at most ${MAX_NAME_LENGTH} characters. Got: "${value}"`;
	}
	if (value.endsWith(' ')) {
		return `Expected a value not to end with " ". Got: "${value}"`;
	}
	return null;
}

/** Assert::isArray(), notEmpty() and allStringNotEmpty() on the posted selected_tbl. */
export function isSelectedTableList(value: unknown): value is string[] {
	return Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string' && item !== '');
}

export interface MaintenanceMessage {
	table: string;
	operation: string;
	type: string;
	text: string;
}

const field = (row: Record<string, unknown>, key: string): string => (typeof row[key] === 'string' ? row[key] : '');

/** Maintenance\Message::fromArray() for each row, grouped by table like the getXTableRows() methods. */
export function groupMaintenanceRows(rows: Record<string, unknown>[]): Map<string, MaintenanceMessage[]> {
	const grouped = new Map<string, MaintenanceMessage[]>();
	for (const row of rows) {
		const message = { table: field(row, 'Table'), operation: field(row, 'Op'), type: field(row, 'Msg_type'), text: field(row, 'Msg_text') };
		const list = grouped.get(message.table) ?? [];
		list.push(message);
		grouped.set(message.table, list);
	}
	return grouped;
}

/** Dbal\Warning::fromArray() cast to a string. */
export function warningToString(row: Record<string, unknown>): string {
	let level = field(row, 'Level');
	if (!['Note', 'Warning', 'Error'].includes(level)) {
		level = '?';
	}
	const rawCode = row.Code;
	let code = 0;
	if ((typeof rawCode === 'string' || typeof rawCode === 'number') && rawCode !== '' && !Number.isNaN(Number(rawCode))) {
		code = Math.max(Math.trunc(Number(rawCode)), 0);
	}
	const message = field(row, 'Message');
	return `${level}: #${code}${message === '' ? '' : ` ${message}`}`;
}

/** Operations::getWarningMessagesArray(): MariaDB's Aria to MyISAM TRANSACTIONAL error (1478) is not worth reporting. */
export function warningMessages(rows: Record<string, unknown>[], newStorageEngine: unknown): string[] {
	const messages: string[] = [];
	for (const row of rows) {
		if (newStorageEngine === 'MyISAM' && String(row.Code) === '1478' && row.Level === 'Error') {
			continue;
		}
		messages.push(warningToString(row));
	}
	return messages;
}

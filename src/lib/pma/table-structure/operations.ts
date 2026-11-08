// Request-independent parts of PhpMyAdmin\Operations for the table operations page.
import { getCharsetQueryPart } from './field-spec.ts';
import { backquote } from '../../twig/sanitize.ts';
import { escapeString } from '../dbi-sql.ts';

/** Operations::getPossibleRowFormat(); `innodbDynamic` is the Barracuda or file-per-table check. */
export function possibleRowFormats(innodbDynamic: boolean): Record<string, Record<string, string>> {
	const formats: Record<string, Record<string, string>> = {
		ARCHIVE: { COMPRESSED: 'COMPRESSED' },
		ARIA: { FIXED: 'FIXED', DYNAMIC: 'DYNAMIC', PAGE: 'PAGE' },
		MARIA: { FIXED: 'FIXED', DYNAMIC: 'DYNAMIC', PAGE: 'PAGE' },
		MYISAM: { FIXED: 'FIXED', DYNAMIC: 'DYNAMIC' },
		PBXT: { FIXED: 'FIXED', DYNAMIC: 'DYNAMIC' },
		INNODB: { COMPACT: 'COMPACT', REDUNDANT: 'REDUNDANT' },
	};
	if (innodbDynamic) {
		formats.INNODB.DYNAMIC = 'DYNAMIC';
		formats.INNODB.COMPRESSED = 'COMPRESSED';
	}
	return formats;
}

/** Operations::getPartitionMaintenanceChoices() for the table's partition method. */
export function partitionMaintenanceChoices(partitionMethod: string | null): Record<string, string> {
	const choices: Record<string, string> = {
		ANALYZE: 'Analyze',
		CHECK: 'Check',
		OPTIMIZE: 'Optimize',
		REBUILD: 'Rebuild',
		REPAIR: 'Repair',
		TRUNCATE: 'Truncate',
	};
	if (['RANGE', 'RANGE COLUMNS', 'LIST', 'LIST COLUMNS'].includes(partitionMethod ?? '')) {
		choices.DROP = 'Drop';
	} else {
		choices.COALESCE = 'Coalesce';
	}
	return choices;
}

/** QueryGenerator::getQueryForReorderingTable(). */
export function reorderingTableQuery(table: string, orderField: string, order: string | null): string {
	return `ALTER TABLE ${backquote(table)} ORDER BY ${backquote(orderField)}${order === 'desc' ? ' DESC;' : ' ASC;'}`;
}

/** QueryGenerator::getQueryForPartitioningTable(). */
export function partitioningTableQuery(table: string, operation: string, partitionNames: string[]): string {
	const sql = `ALTER TABLE ${backquote(table)} ${operation} PARTITION `;
	if (operation === 'COALESCE') {
		return sql + String(partitionNames.length);
	}
	return `${sql}${partitionNames.join(', ')};`;
}

/** The user comment of a table, without the "InnoDB free" part older servers append. */
export function userTableComment(comment: string | null): string {
	const text = comment === null ? '' : comment;
	if (!text.includes('; InnoDB free')) {
		return text.includes('InnoDB free') ? '' : text;
	}
	return text.replace(/; InnoDB free:.*$/, '');
}

/** ALTER TABLE ... CONVERT TO from Operations::changeAllColumnsCollation(). */
export function convertCollationQuery(table: string, collation: string): string {
	const [charset] = collation.split('_', 1);
	return `ALTER TABLE ${backquote(table)} CONVERT TO CHARACTER SET ${charset}${charset === collation ? '' : ` COLLATE ${collation}`}`;
}

export interface TableAltersInput {
	post: Record<string, unknown>;
	/** Table::isEngine() for the current engine. */
	isEngine: (engines: string[]) => boolean;
	storageEngine: string;
	packKeys: string;
	checksum: string;
	pageChecksum: string;
	delayKeyWrite: string;
	rowFormat: string;
	newStorageEngine: string;
	transactional: string;
	collation: string;
	autoIncrement: string;
}

const isEmpty = (value: unknown): boolean => [undefined, null, '', '0'].includes(value as never);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

// PHP's urldecode(): plus signs become spaces.
function urldecode(value: string): string {
	try {
		return decodeURIComponent(value.replaceAll('+', ' '));
	} catch {
		return value.replaceAll('+', ' ');
	}
}

/** Operations::getTableAltersArray(). */
export function tableAltersArray(input: TableAltersInput): string[] {
	const { post, isEngine } = input;
	const alters: string[] = [];
	if (post.comment !== undefined && urldecode(text(post.prev_comment)) !== post.comment) {
		alters.push(`COMMENT = '${escapeString(text(post.comment))}'`);
	}
	if (input.newStorageEngine !== '' && input.newStorageEngine.toLowerCase() !== input.storageEngine.toLowerCase()) {
		alters.push(`ENGINE = ${input.newStorageEngine}`);
	}
	if (!isEmpty(post.tbl_collation) && post.tbl_collation !== input.collation) {
		alters.push(`DEFAULT ${getCharsetQueryPart(text(post.tbl_collation))}`);
	}
	if (isEngine(['MYISAM', 'ARIA', 'ISAM']) && post.new_pack_keys !== undefined && text(post.new_pack_keys) !== input.packKeys) {
		alters.push(`pack_keys = ${text(post.new_pack_keys)}`);
	}
	const flag = (name: string): string => (isEmpty(post[name]) ? '0' : '1');
	if (isEngine(['MYISAM', 'ARIA']) && flag('new_checksum') !== input.checksum) {
		alters.push(`checksum = ${flag('new_checksum')}`);
	}
	if (isEngine(['ARIA']) && flag('new_transactional') !== input.transactional) {
		alters.push(`TRANSACTIONAL = ${flag('new_transactional')}`);
	}
	if (isEngine(['ARIA']) && flag('new_page_checksum') !== input.pageChecksum) {
		alters.push(`PAGE_CHECKSUM = ${flag('new_page_checksum')}`);
	}
	if (isEngine(['MYISAM', 'ARIA']) && flag('new_delay_key_write') !== input.delayKeyWrite) {
		alters.push(`delay_key_write = ${flag('new_delay_key_write')}`);
	}
	const autoIncrement = text(post.new_auto_increment);
	if (isEngine(['MYISAM', 'ARIA', 'INNODB', 'PBXT', 'ROCKSDB']) && !isEmpty(post.new_auto_increment) && autoIncrement !== input.autoIncrement && post.new_auto_increment !== post.hidden_auto_increment) {
		alters.push(`auto_increment = ${escapeString(autoIncrement)}`);
	}
	if (!isEmpty(post.new_row_format)) {
		const rowFormat = text(post.new_row_format);
		if (isEngine(['MYISAM', 'ARIA', 'INNODB', 'PBXT']) && (input.rowFormat === '' || rowFormat.toLowerCase() !== input.rowFormat.toLowerCase())) {
			alters.push(`ROW_FORMAT = ${escapeString(rowFormat)}`);
		}
	}
	return alters;
}

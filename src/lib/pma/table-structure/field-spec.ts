// Ports of Table::generateFieldSpec() and Table::generateAlter(): the column definition SQL of the column forms.
import { type ServerKind, isIntegersSupportLength } from './types.ts';
import { backquote } from '../../twig/sanitize.ts';
import { escapeString } from '../dbi-sql.ts';

export interface FieldSpec {
	name: string;
	type: string;
	length?: string;
	attribute?: string;
	collation?: string;
	/** 'YES', another string for NOT NULL, or false to leave the nullability out. */
	nullable?: string | false;
	defaultType?: string;
	defaultValue?: string;
	extra?: string | false;
	comment?: string;
	virtuality?: string;
	expression?: string;
	moveTo?: string;
	columnsWithIndex?: string[] | null;
	oldColumnName?: string | null;
}

const NO_LENGTH_TYPES = /^(?:DATE|TINYBLOB|TINYTEXT|BLOB|TEXT|MEDIUMBLOB|MEDIUMTEXT|LONGBLOB|LONGTEXT|SERIAL|BOOLEAN|UUID|JSON)$/i;
const CHARSET_TYPES = /^(?:TINYTEXT|TEXT|MEDIUMTEXT|LONGTEXT|VARCHAR|CHAR|ENUM|SET)$/i;

// PHP's empty() on a string.
const isEmpty = (value: string | false | undefined): boolean => [undefined, false, '', '0'].includes(value);

/** Util::getCharsetQueryPart(). */
export function getCharsetQueryPart(collation: string, override = false): string {
	const [charset] = collation.split('_', 1);
	const keyword = override ? ' CHARACTER SET ' : ' CHARSET=';
	return keyword + charset + (charset === collation ? '' : ` COLLATE ${collation}`);
}

function defaultClause(spec: FieldSpec, isTimestamp: boolean): string {
	const { type } = spec;
	const value = spec.defaultValue ?? '';
	const length = spec.length ?? '';
	const nullable = spec.nullable ?? false;
	switch (spec.defaultType ?? 'USER_DEFINED') {
		case 'USER_DEFINED': {
			if (isTimestamp && value === '0') {
				// A TIMESTAMP accepts DEFAULT 0 but not DEFAULT '0'.
				return ' DEFAULT 0';
			}
			if (isTimestamp && /^'\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d{1,6})?'$/.test(value)) {
				return ` DEFAULT ${value}`;
			}
			if (type === 'BIT') {
				return ` DEFAULT b'${value.replaceAll(/[^01]/g, '0')}'`;
			}
			if (type === 'BOOLEAN') {
				// Upstream's /^1|T|TRUE|YES$/i and its FALSE twin: the alternation is unanchored, so T and F already cover TRUE and FALSE.
				if (/^1|T|YES$/i.test(value)) {
					return ' DEFAULT TRUE';
				}
				if (/^0|F|NO$/i.test(value)) {
					return ' DEFAULT FALSE';
				}
				return ` DEFAULT '${escapeString(value)}'`;
			}
			if (type === 'BINARY' || type === 'VARBINARY') {
				return ` DEFAULT 0x${value}`;
			}
			return ` DEFAULT '${escapeString(value)}'`;
		}
		case 'NULL': {
			// Unticking NULL while the default stays NULL drops the default.
			if (nullable !== false && nullable !== 'YES') {
				return '';
			}
			return ' DEFAULT NULL';
		}
		case 'CURRENT_TIMESTAMP':
		case 'current_timestamp()': {
			const defaultType = spec.defaultType as string;
			let clause = ` DEFAULT ${defaultType}`;
			if (length !== '' && isTimestamp) {
				clause += `(${length})`;
			}
			return clause;
		}
		case 'UUID':
		case 'uuid()': {
			return ' DEFAULT uuid()';
		}
		default: {
			return '';
		}
	}
}

/** Table::generateFieldSpec(). */
export function generateFieldSpec(spec: FieldSpec, server: ServerKind): string {
	const { name, type } = spec;
	const length = spec.length ?? '';
	const attribute = spec.attribute ?? '';
	const collation = spec.collation ?? '';
	const nullable = spec.nullable ?? false;
	const virtuality = spec.virtuality ?? '';
	const comment = spec.comment ?? '';
	const moveTo = spec.moveTo ?? '';
	let extra = spec.extra ?? '';
	const isTimestamp = type.toUpperCase().includes('TIMESTAMP');
	const isVirtual = !isEmpty(virtuality);

	let query = `${backquote(name)} ${type}`;
	if (length !== '' && !NO_LENGTH_TYPES.test(type) && isIntegersSupportLength(type, length, server)) {
		query += `(${length})`;
	}
	if (attribute !== '') {
		query += ` ${attribute}`;
		if (isTimestamp && attribute.toUpperCase().includes('TIMESTAMP') && length !== '') {
			query += `(${length})`;
		}
	}
	const isMariaDb = server.type === 'MariaDB';
	if (!isEmpty(collation) && collation !== 'NULL' && CHARSET_TYPES.test(type)) {
		query += getCharsetQueryPart(isVirtual && isMariaDb ? collation.replace(/_.+/s, '') : collation, true);
	}
	if (isVirtual) {
		query += ` AS (${spec.expression ?? ''}) ${virtuality}`;
	}
	if (!isVirtual || !isMariaDb) {
		if (nullable !== false) {
			query += nullable === 'YES' ? ' NULL' : ' NOT NULL';
		}
		if (!isVirtual) {
			query += defaultClause(spec, isTimestamp);
		}
		if (!isEmpty(extra)) {
			if (isVirtual) {
				extra = (extra as string).replace(/^\s*AUTO_INCREMENT\s*/i, ' ').trim();
			}
			query += ` ${extra as string}`;
		}
	}
	if (!isEmpty(comment)) {
		query += ` COMMENT '${escapeString(comment)}'`;
	}
	if (moveTo === '-first') {
		query += ' FIRST';
	} else if (moveTo !== '') {
		query += ` AFTER ${backquote(moveTo)}`;
	}
	if (!isVirtual && !isEmpty(extra) && Array.isArray(spec.columnsWithIndex)) {
		const indexed = spec.oldColumnName ?? name;
		if (!spec.columnsWithIndex.includes(indexed)) {
			query += `, ADD PRIMARY KEY (${backquote(name)})`;
		}
	}
	return query;
}

/** Table::generateAlter(): the CHANGE clause body for a column. */
export function generateAlter(oldColumn: string, spec: FieldSpec, server: ServerKind): string {
	return `${backquote(oldColumn)} ${generateFieldSpec({ ...spec, oldColumnName: oldColumn }, server)}`;
}

// The request-independent parts of Table\ColumnsDefinition::displayForm(): column defaults, regenerated rows and form parameters.
import { type ColumnSpec, convertBitDefaultValue, extractColumnSpec } from './column-spec.ts';
import { type PhpArray, type PhpValue, phpGet } from '../table-data/php-params.ts';

export type ColumnMeta = Record<string, unknown>;

/** PHP's stripcslashes(). */
export function stripcslashes(value: string): string {
	const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\u{7}', v: '\v', b: '\b', f: '\f' };
	return value.replaceAll(/\\(x[\dA-Fa-f]{1,2}|[0-7]{1,3}|[\s\S])?/g, (match, escape: string | undefined) => {
		if (escape === undefined) {
			return '';
		}
		if (simple[escape] !== undefined) {
			return simple[escape];
		}
		if (escape.startsWith('x') && escape.length > 1) {
			return String.fromCodePoint(Number.parseInt(escape.slice(1), 16));
		}
		if (/^[0-7]+$/.test(escape)) {
			return String.fromCodePoint(Number.parseInt(escape, 8) & 0xFF);
		}
		return escape;
	});
}

/** ColumnsDefinition::decorateColumnMetaDefault(); the switch compares loosely, so an empty default counts as null. */
export function decorateColumnMetaDefault(meta: ColumnMeta): ColumnMeta {
	const result: ColumnMeta = { DefaultType: 'USER_DEFINED', DefaultValue: '' };
	const value = meta.Default as string | null | undefined;
	if (value === null || value === undefined || value.length === 0) {
		result.DefaultType = meta.Null === 'YES' ? 'NULL' : 'NONE';
	} else if (value === 'CURRENT_TIMESTAMP' || value === 'current_timestamp()') {
		result.DefaultType = 'CURRENT_TIMESTAMP';
	} else if (value === 'UUID' || value === 'uuid()') {
		result.DefaultType = 'UUID';
	} else {
		result.DefaultValue = value;
		if (String(meta.Type ?? '').endsWith('text')) {
			result.Default = stripcslashes(value.slice(1, -1));
		}
	}
	return result;
}

/** Util::getValueByKey() on $_POST with a dotted path such as "field_name.0". */
export function valueByKey(post: PhpArray, path: string, defaultValue: PhpValue | null = null): PhpValue | null {
	return phpGet(post, ...path.split('.')) ?? defaultValue;
}

const KEY_NAMES: Record<string, string> = { primary: 'PRI', index: 'MUL', unique: 'UNI', fulltext: 'FULLTEXT', spatial: 'SPATIAL' };

/** A column row rebuilt from the POSTed form when columns are added to it ($regenerate). */
export function regeneratedColumnMeta(post: PhpArray, column: number): ColumnMeta {
	const meta: ColumnMeta = {
		Field: valueByKey(post, `field_name.${column}`),
		Type: valueByKey(post, `field_type.${column}`),
		Collation: valueByKey(post, `field_collation.${column}`, ''),
		Null: valueByKey(post, `field_null.${column}`, ''),
		DefaultType: valueByKey(post, `field_default_type.${column}`, 'NONE'),
		DefaultValue: valueByKey(post, `field_default_value.${column}`, ''),
		Extra: valueByKey(post, `field_extra.${column}`),
		Virtuality: valueByKey(post, `field_virtuality.${column}`, ''),
		Expression: valueByKey(post, `field_expression.${column}`, ''),
	};
	// Twing reads a missing attribute as undefined, which only equals null when both sides are missing, as in PHP.
	if (meta.Field === null) {
		delete meta.Field;
	}
	meta.Key = '';
	const key = valueByKey(post, `field_key.${column}`, '');
	const parts = typeof key === 'string' ? key.split('_') : [];
	if (parts.length >= 2 && parts.slice(1).join('_') === String(column)) {
		meta.Key = KEY_NAMES[parts[0]] ?? '';
	}
	meta.Comment = false;
	switch (meta.DefaultType) {
		case 'NONE': {
			meta.Default = null;
			break;
		}
		case 'USER_DEFINED': {
			meta.Default = meta.DefaultValue;
			break;
		}
		case 'NULL':
		case 'CURRENT_TIMESTAMP':
		case 'current_timestamp()':
		case 'UUID':
		case 'uuid()': {
			meta.Default = meta.DefaultType;
			break;
		}
		default: {
			break;
		}
	}
	return meta;
}

// bin2hex() of a mysqli byte string, where each character is one byte.
function bin2hex(value: string): string {
	return [...new TextEncoder().encode(value)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export interface ContentCellInput {
	columnNumber: number;
	meta: ColumnMeta;
	/** The length typed into a regenerated form, else ''. */
	length: string;
	isBackup: boolean;
	limitChars: number;
}

export interface ContentCell {
	meta: ColumnMeta;
	type: string;
	typeUpper: string;
	length: string;
	defaultValue: string;
	extractedColumnspec: Partial<ColumnSpec>;
	/** The field_*_orig[n] hidden fields of an edited column. */
	backupParams: Record<string, unknown>;
}

const metaString = (meta: ColumnMeta, key: string, defaultValue = ''): unknown => meta[key] ?? defaultValue;

/** The body of the displayForm() column loop after the column meta is known. */
export function contentCell(input: ContentCellInput): ContentCell {
	const meta = { ...input.meta };
	let length = input.length;
	let type = '';
	let extracted: Partial<ColumnSpec> = {};
	if (meta.Type !== undefined && meta.Type !== null) {
		const spec = extractColumnSpec(String(meta.Type), input.limitChars);
		extracted = spec;
		if (spec.type === 'bit') {
			meta.Default = convertBitDefaultValue(meta.Default as string | null);
		}
		type = spec.type;
		if (length === '') {
			length = spec.spec_in_brackets;
		}
	} else {
		meta.Type = '';
	}
	type = type.replaceAll(/\scharacter set\s\S+/g, '').trimEnd();

	const backupParams: Record<string, unknown> = {};
	const column = input.columnNumber;
	if (input.isBackup) {
		backupParams[`field_orig[${column}]`] = meta.Field ?? '';
		backupParams[`field_type_orig[${column}]`] = type.toUpperCase();
		backupParams[`field_length_orig[${column}]`] = length;
		backupParams[`field_default_value_orig[${column}]`] = metaString(meta, 'Default');
		backupParams[`field_default_type_orig[${column}]`] = metaString(meta, 'DefaultType');
		backupParams[`field_collation_orig[${column}]`] = metaString(meta, 'Collation');
		backupParams[`field_attribute_orig[${column}]`] = String(extracted.attribute ?? '').trim();
		backupParams[`field_null_orig[${column}]`] = metaString(meta, 'Null');
		backupParams[`field_extra_orig[${column}]`] = metaString(meta, 'Extra');
		backupParams[`field_comments_orig[${column}]`] = metaString(meta, 'Comment');
		backupParams[`field_virtuality_orig[${column}]`] = metaString(meta, 'Virtuality');
		backupParams[`field_expression_orig[${column}]`] = metaString(meta, 'Expression');
	}

	const typeUpper = type.toUpperCase();
	let defaultValue = '';
	if (meta.DefaultValue !== undefined && meta.DefaultValue !== null) {
		defaultValue = String(meta.DefaultValue);
	}
	if (typeUpper === 'BIT') {
		const value = meta.DefaultValue;
		defaultValue = value !== undefined && value !== null && value !== '' && value !== '0' ? convertBitDefaultValue(String(value)) : '';
	} else if (typeUpper === 'BINARY' || typeUpper === 'VARBINARY') {
		defaultValue = bin2hex(String(meta.DefaultValue ?? ''));
	}
	return { meta, type, typeUpper, length, defaultValue, extractedColumnspec: extracted, backupParams };
}

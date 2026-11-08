import { describe, expect, it } from 'vitest';

import {
	contentCell,
	decorateColumnMetaDefault,
	regeneratedColumnMeta,
	stripcslashes,
	valueByKey,
} from './columns-definition.ts';
import { nestedParams } from '../table-data/php-params.ts';

describe('stripcslashes', () => {
	it('decodes C escapes, hex and octal sequences', () => {
		expect(stripcslashes(String.raw`a\nb\tc\x41\101\q\\`)).toBe('a\nb\tcAAq\\');
		expect(stripcslashes(String.raw`\a\v\b\f\r`)).toBe('\u{7}\v\b\f\r');
	});

	it('wraps octal values above 255 and drops a trailing backslash', () => {
		expect(stripcslashes(String.raw`\501`)).toBe('A');
		expect(stripcslashes('end\\')).toBe('end');
	});

	it('keeps a lone x as the letter', () => {
		expect(stripcslashes(String.raw`\xg`)).toBe('xg');
	});
});

describe('decorateColumnMetaDefault', () => {
	it('maps a missing default to NULL or NONE by nullability', () => {
		expect(decorateColumnMetaDefault({ Default: null, Null: 'YES' })).toEqual({ DefaultType: 'NULL', DefaultValue: '' });
		expect(decorateColumnMetaDefault({ Default: '', Null: 'NO' })).toEqual({ DefaultType: 'NONE', DefaultValue: '' });
	});

	it('recognises the timestamp and uuid function defaults', () => {
		expect(decorateColumnMetaDefault({ Default: 'current_timestamp()' }).DefaultType).toBe('CURRENT_TIMESTAMP');
		expect(decorateColumnMetaDefault({ Default: 'CURRENT_TIMESTAMP' }).DefaultType).toBe('CURRENT_TIMESTAMP');
		expect(decorateColumnMetaDefault({ Default: 'uuid()' }).DefaultType).toBe('UUID');
		expect(decorateColumnMetaDefault({ Default: 'UUID' }).DefaultType).toBe('UUID');
	});

	it('keeps a user default and unquotes MariaDB text defaults', () => {
		expect(decorateColumnMetaDefault({ Default: '5', Type: 'int' })).toEqual({ DefaultType: 'USER_DEFINED', DefaultValue: '5' });
		expect(decorateColumnMetaDefault({ Default: String.raw`'a\nb'`, Type: 'text' })).toEqual({ DefaultType: 'USER_DEFINED', DefaultValue: String.raw`'a\nb'`, Default: 'a\nb' });
	});
});

describe('valueByKey', () => {
	it('follows a dotted path and falls back to the default', () => {
		const post = nestedParams({ 'field_name[0]': 'id' });
		expect(valueByKey(post, 'field_name.0')).toBe('id');
		expect(valueByKey(post, 'field_name.1', 'x')).toBe('x');
		expect(valueByKey(post, 'missing.0')).toBeNull();
	});
});

describe('regeneratedColumnMeta', () => {
	it('keeps an untyped default as it is and ignores a key posted as a list', () => {
		expect(decorateColumnMetaDefault({ Default: '\'q\'' })).toEqual({ DefaultType: 'USER_DEFINED', DefaultValue: '\'q\'' });
		const meta = regeneratedColumnMeta(nestedParams({ 'field_key[0]': ['primary_0'], 'field_default_type[0]': 'NULL' }), 0);
		expect(meta.Key).toBe('');
		expect(meta.Default).toBe('NULL');
	});
	it('rebuilds a column row with its key and default', () => {
		const post = nestedParams({
			'field_name[0]': 'id',
			'field_type[0]': 'INT',
			'field_key[0]': 'primary_0',
			'field_default_type[0]': 'USER_DEFINED',
			'field_default_value[0]': '7',
		});
		expect(regeneratedColumnMeta(post, 0)).toEqual({
			Field: 'id',
			Type: 'INT',
			Collation: '',
			Null: '',
			DefaultType: 'USER_DEFINED',
			DefaultValue: '7',
			Extra: null,
			Virtuality: '',
			Expression: '',
			Key: 'PRI',
			Comment: false,
			Default: '7',
		});
	});

	it('leaves Field out for an unknown column and ignores a key of another column', () => {
		const meta = regeneratedColumnMeta(nestedParams({ 'field_key[1]': 'unique_0' }), 1);
		expect(meta).not.toHaveProperty('Field');
		expect(meta.Key).toBe('');
		expect(meta.Default).toBeNull();
	});

	it('copies function defaults and keeps unknown default types without a default', () => {
		const current = regeneratedColumnMeta(nestedParams({ 'field_default_type[0]': 'CURRENT_TIMESTAMP', 'field_key[0]': 'bogus_0' }), 0);
		expect(current.Default).toBe('CURRENT_TIMESTAMP');
		expect(current.Key).toBe('');
		const other = regeneratedColumnMeta(nestedParams({ 'field_default_type[0]': 'OTHER' }), 0);
		expect(other).not.toHaveProperty('Default');
	});
});

describe('contentCell', () => {
	const base = { columnNumber: 0, length: '', isBackup: false, limitChars: 50 };

	it('reads type and length from the column type', () => {
		const cell = contentCell({ ...base, meta: { Type: 'varchar(20) character set utf8', DefaultValue: 'x' } });
		expect(cell).toMatchObject({ type: 'varchar', typeUpper: 'VARCHAR', length: '20', defaultValue: 'x', backupParams: {} });
	});

	it('keeps a regenerated length and fills the backup fields', () => {
		const cell = contentCell({ ...base, length: '9', isBackup: true, columnNumber: 2, meta: { Field: 'n', Type: 'int(11) unsigned', Default: null, Null: 'NO' } });
		expect(cell.length).toBe('9');
		expect(cell.backupParams).toEqual({
			'field_orig[2]': 'n',
			'field_type_orig[2]': 'INT',
			'field_length_orig[2]': '9',
			'field_default_value_orig[2]': '',
			'field_default_type_orig[2]': '',
			'field_collation_orig[2]': '',
			'field_attribute_orig[2]': 'UNSIGNED',
			'field_null_orig[2]': 'NO',
			'field_extra_orig[2]': '',
			'field_comments_orig[2]': '',
			'field_virtuality_orig[2]': '',
			'field_expression_orig[2]': '',
		});
	});

	it('converts bit defaults and hex-encodes binary defaults', () => {
		const bit = contentCell({ ...base, meta: { Type: 'bit(3)', Default: 'b\'101\'', DefaultValue: 'b\'101\'' } });
		expect(bit.meta.Default).toBe('101');
		expect(bit.defaultValue).toBe('101');
		expect(contentCell({ ...base, meta: { Type: 'bit(1)', DefaultValue: '' } }).defaultValue).toBe('');
		expect(contentCell({ ...base, meta: { Type: 'varbinary(4)', DefaultValue: 'AB' } }).defaultValue).toBe('4142');
		expect(contentCell({ ...base, meta: { Type: 'binary(4)' } }).defaultValue).toBe('');
	});

	it('handles a column without a type', () => {
		const cell = contentCell({ ...base, isBackup: true, meta: {} });
		expect(cell.meta.Type).toBe('');
		expect(cell.type).toBe('');
		expect(cell.backupParams['field_orig[0]']).toBe('');
		expect(cell.backupParams['field_attribute_orig[0]']).toBe('');
	});
});

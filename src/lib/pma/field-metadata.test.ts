import { describe, expect, it } from 'vitest';

import {
	BINARY_CHARSET,
	FieldMetadata,
	FieldType,
	MysqlFlag,
	MysqlType,
} from './field-metadata.ts';

const info = (charsetnr = 255) => {
	return { name: 'id', orgname: 'id', table: 't', orgtable: 't', charsetnr, decimals: 0, length: 11 };
};

describe('FieldMetadata', () => {
	it('reads key and attribute flags', () => {
		const flags = MysqlFlag.NOT_NULL | MysqlFlag.PRI_KEY | MysqlFlag.UNSIGNED | MysqlFlag.ZEROFILL;
		const field = new FieldMetadata(MysqlType.LONG, flags, info(BINARY_CHARSET));

		expect(field).toMatchObject({ isNotNull: true, isPrimaryKey: true, isUnsigned: true, isZerofill: true, isUniqueKey: false, isMultipleKey: false, isNumeric: true });
		expect(field.getMappedType()).toBe('int');
		// Numbers report the binary charset too, but only string and blob types count as binary.
		expect(field.isBinary).toBe(false);
	});

	it('treats BIT as its own type rather than a number', () => {
		const bit = new FieldMetadata(MysqlType.BIT, 0, info(BINARY_CHARSET));
		expect(bit.isMappedTypeBit).toBe(true);
		expect(bit.isNumeric).toBe(false);
		expect(bit.getMappedType()).toBe('bit');
	});

	it('marks binary strings and blobs by the binary charset', () => {
		expect(new FieldMetadata(MysqlType.BLOB, MysqlFlag.BLOB, info(BINARY_CHARSET))).toMatchObject({ isBinary: true, isBlob: true });
		expect(new FieldMetadata(MysqlType.BLOB, MysqlFlag.BLOB, info(255)).isBinary).toBe(false);
		expect(new FieldMetadata(MysqlType.VAR_STRING, 0, info(BINARY_CHARSET)).getMappedType()).toBe('string');
	});

	it('classifies date and time types', () => {
		const date = new FieldMetadata(MysqlType.DATE, 0, info());
		expect(date.isDateTimeType()).toBe(true);
		expect(date.isTimeType()).toBe(false);
		const timestamp = new FieldMetadata(MysqlType.TIMESTAMP, MysqlFlag.TIMESTAMP, info());
		expect(timestamp).toMatchObject({ isMappedTypeTimestamp: true });
		expect(timestamp.isTimeType()).toBe(true);
		expect(new FieldMetadata(MysqlType.STRING, 0, info()).isDateTimeType()).toBe(false);
	});

	it('maps ENUM and SET flags and leaves unmapped types without a name', () => {
		const enumField = new FieldMetadata(MysqlType.STRING, MysqlFlag.ENUM | MysqlFlag.MULTIPLE_KEY, info());
		expect(enumField).toMatchObject({ isEnum: true, isSet: false, isMultipleKey: true });
		expect(new FieldMetadata(MysqlType.STRING, MysqlFlag.SET | MysqlFlag.UNIQUE_KEY, info())).toMatchObject({ isSet: true, isUniqueKey: true });
		expect(new FieldMetadata(MysqlType.ENUM, 0, info()).getMappedType()).toBe('unknown');

		const varchar = new FieldMetadata(MysqlType.VARCHAR, 0, info());
		expect(varchar.getMappedType()).toBe('');
		expect(varchar.isNotType(FieldType.STRING)).toBe(true);
		expect(new FieldMetadata(MysqlType.GEOMETRY, 0, info(BINARY_CHARSET)).isMappedTypeGeometry).toBe(true);
	});
});

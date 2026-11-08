// Port of PhpMyAdmin\FieldMetadata: result column metadata as mysqli's fetch_fields() reports it.

/** MYSQLI_TYPE_* wire types. */
export const MysqlType = {
	DECIMAL: 0,
	TINY: 1,
	SHORT: 2,
	LONG: 3,
	FLOAT: 4,
	DOUBLE: 5,
	NULL: 6,
	TIMESTAMP: 7,
	LONGLONG: 8,
	INT24: 9,
	DATE: 10,
	TIME: 11,
	DATETIME: 12,
	YEAR: 13,
	NEWDATE: 14,
	VARCHAR: 15,
	BIT: 16,
	JSON: 245,
	NEWDECIMAL: 246,
	ENUM: 247,
	SET: 248,
	TINY_BLOB: 249,
	MEDIUM_BLOB: 250,
	LONG_BLOB: 251,
	BLOB: 252,
	VAR_STRING: 253,
	STRING: 254,
	GEOMETRY: 255,
} as const;

/** MYSQLI_*_FLAG column flags. */
export const MysqlFlag = {
	NOT_NULL: 1,
	PRI_KEY: 2,
	UNIQUE_KEY: 4,
	MULTIPLE_KEY: 8,
	BLOB: 16,
	UNSIGNED: 32,
	ZEROFILL: 64,
	BINARY: 128,
	ENUM: 256,
	AUTO_INCREMENT: 512,
	TIMESTAMP: 1024,
	SET: 2048,
} as const;

/** FieldMetadata::TYPE_* mapped types. */
export const FieldType = {
	GEOMETRY: 1,
	BIT: 2,
	JSON: 3,
	REAL: 4,
	INT: 5,
	BLOB: 6,
	UNKNOWN: -1,
	NULL: 7,
	STRING: 8,
	DATE: 9,
	TIME: 10,
	TIMESTAMP: 11,
	DATETIME: 12,
	YEAR: 13,
} as const;

/** MySQL's charset number for "binary". */
export const BINARY_CHARSET = 63;

const typeMap = new Map<number, number>([
	[MysqlType.DECIMAL, FieldType.REAL],
	[MysqlType.NEWDECIMAL, FieldType.REAL],
	[MysqlType.TINY, FieldType.INT],
	[MysqlType.SHORT, FieldType.INT],
	[MysqlType.LONG, FieldType.INT],
	[MysqlType.FLOAT, FieldType.REAL],
	[MysqlType.DOUBLE, FieldType.REAL],
	[MysqlType.NULL, FieldType.NULL],
	[MysqlType.TIMESTAMP, FieldType.TIMESTAMP],
	[MysqlType.LONGLONG, FieldType.INT],
	[MysqlType.INT24, FieldType.INT],
	[MysqlType.DATE, FieldType.DATE],
	[MysqlType.TIME, FieldType.TIME],
	[MysqlType.DATETIME, FieldType.DATETIME],
	[MysqlType.YEAR, FieldType.YEAR],
	[MysqlType.NEWDATE, FieldType.DATE],
	[MysqlType.ENUM, FieldType.UNKNOWN],
	[MysqlType.SET, FieldType.UNKNOWN],
	[MysqlType.TINY_BLOB, FieldType.BLOB],
	[MysqlType.MEDIUM_BLOB, FieldType.BLOB],
	[MysqlType.LONG_BLOB, FieldType.BLOB],
	[MysqlType.BLOB, FieldType.BLOB],
	[MysqlType.VAR_STRING, FieldType.STRING],
	[MysqlType.STRING, FieldType.STRING],
	[MysqlType.GEOMETRY, FieldType.GEOMETRY],
	[MysqlType.BIT, FieldType.BIT],
	[MysqlType.JSON, FieldType.JSON],
]);

const mappedTypeNames = new Map<number, string>([
	[FieldType.GEOMETRY, 'geometry'],
	[FieldType.BIT, 'bit'],
	[FieldType.JSON, 'json'],
	[FieldType.REAL, 'real'],
	[FieldType.INT, 'int'],
	[FieldType.BLOB, 'blob'],
	[FieldType.UNKNOWN, 'unknown'],
	[FieldType.NULL, 'null'],
	[FieldType.STRING, 'string'],
	[FieldType.DATE, 'date'],
	[FieldType.TIME, 'time'],
	[FieldType.TIMESTAMP, 'timestamp'],
	[FieldType.DATETIME, 'datetime'],
	[FieldType.YEAR, 'year'],
]);

const binaryTypes = new Set<number>([
	MysqlType.TINY_BLOB,
	MysqlType.BLOB,
	MysqlType.MEDIUM_BLOB,
	MysqlType.LONG_BLOB,
	MysqlType.VAR_STRING,
	MysqlType.STRING,
]);

/** The mysqli field object properties FieldMetadata copies. */
export interface FieldInfo {
	name: string;
	orgname: string;
	table: string;
	orgtable: string;
	charsetnr: number;
	decimals: number;
	length: number;
}

export class FieldMetadata {
	private readonly mappedType: number | null;
	readonly isMultipleKey: boolean;
	readonly isPrimaryKey: boolean;
	readonly isUniqueKey: boolean;
	readonly isNotNull: boolean;
	readonly isUnsigned: boolean;
	readonly isZerofill: boolean;
	readonly isNumeric: boolean;
	readonly isBlob: boolean;
	readonly isBinary: boolean;
	readonly isEnum: boolean;
	readonly isSet: boolean;
	readonly isMappedTypeBit: boolean;
	readonly isMappedTypeGeometry: boolean;
	readonly isMappedTypeTimestamp: boolean;
	name: string;
	orgname: string;
	table: string;
	/** Mutable because DatabaseInterface::getFieldsMeta() fixes its case for lower_case_table_names = 2. */
	orgtable: string;
	readonly charsetnr: number;
	readonly decimals: number;
	readonly length: number;
	/** Set by the SQL results display for transformations. */
	internalMediaType: string | null = null;

	constructor(fieldType: number, fieldFlags: number, field: FieldInfo) {
		this.mappedType = typeMap.get(fieldType) ?? null;
		this.isMultipleKey = (fieldFlags & MysqlFlag.MULTIPLE_KEY) !== 0;
		this.isPrimaryKey = (fieldFlags & MysqlFlag.PRI_KEY) !== 0;
		this.isUniqueKey = (fieldFlags & MysqlFlag.UNIQUE_KEY) !== 0;
		this.isNotNull = (fieldFlags & MysqlFlag.NOT_NULL) !== 0;
		this.isUnsigned = (fieldFlags & MysqlFlag.UNSIGNED) !== 0;
		this.isZerofill = (fieldFlags & MysqlFlag.ZEROFILL) !== 0;
		this.isBlob = (fieldFlags & MysqlFlag.BLOB) !== 0;
		this.isEnum = (fieldFlags & MysqlFlag.ENUM) !== 0;
		this.isSet = (fieldFlags & MysqlFlag.SET) !== 0;
		// Flag 32768 is both NUM_FLAG and GROUP_FLAG, so upstream decides by type instead.
		this.isNumeric = this.isType(FieldType.INT) || this.isType(FieldType.REAL);
		this.isMappedTypeBit = this.isType(FieldType.BIT);
		this.isMappedTypeGeometry = this.isType(FieldType.GEOMETRY);
		this.isMappedTypeTimestamp = this.isType(FieldType.TIMESTAMP);
		this.name = field.name;
		this.orgname = field.orgname;
		this.table = field.table;
		this.orgtable = field.orgtable;
		this.charsetnr = field.charsetnr;
		this.decimals = field.decimals;
		this.length = field.length;
		this.isBinary = binaryTypes.has(fieldType) && this.charsetnr === BINARY_CHARSET;
	}

	isDateTimeType(): boolean {
		return this.isType(FieldType.DATE) || this.isTimeType();
	}

	isTimeType(): boolean {
		return this.isType(FieldType.TIME) || this.isType(FieldType.TIMESTAMP) || this.isType(FieldType.DATETIME);
	}

	getMappedType(): string {
		return mappedTypeNames.get(this.mappedType ?? 0) ?? '';
	}

	isType(type: number): boolean {
		return this.mappedType === type;
	}

	isNotType(type: number): boolean {
		return this.mappedType !== type;
	}
}

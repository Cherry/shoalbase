// Port of PhpMyAdmin\Types: type classes, insert/edit function lists and search operators for MySQL and MariaDB.
import { htmlspecialchars } from '../../twig/php.ts';

export interface ServerFlavor {
	isMariaDB: boolean;
	version: number;
}

const NUMBER_TYPES = new Set(['TINYINT', 'SMALLINT', 'MEDIUMINT', 'INT', 'BIGINT', 'DECIMAL', 'FLOAT', 'DOUBLE', 'REAL', 'BIT', 'BOOLEAN', 'SERIAL']);
const DATE_TYPES = new Set(['DATE', 'DATETIME', 'TIMESTAMP', 'TIME', 'YEAR']);
const CHAR_TYPES = new Set(['CHAR', 'VARCHAR', 'TINYTEXT', 'TEXT', 'MEDIUMTEXT', 'LONGTEXT', 'BINARY', 'VARBINARY', 'TINYBLOB', 'MEDIUMBLOB', 'BLOB', 'LONGBLOB', 'ENUM', 'SET', 'INET6']);
const SPATIAL_TYPES = new Set(['GEOMETRY', 'POINT', 'LINESTRING', 'POLYGON', 'MULTIPOINT', 'MULTILINESTRING', 'MULTIPOLYGON', 'GEOMETRYCOLLECTION']);

/** Types::getTypeClass(). */
export function getTypeClass(type: string | null | undefined): string {
	const upper = (type ?? '').toUpperCase();
	if (NUMBER_TYPES.has(upper)) {
		return 'NUMBER';
	}
	if (DATE_TYPES.has(upper)) {
		return 'DATE';
	}
	if (CHAR_TYPES.has(upper)) {
		return 'CHAR';
	}
	if (SPATIAL_TYPES.has(upper)) {
		return 'SPATIAL';
	}
	if (upper === 'JSON' || upper === 'UUID') {
		return upper;
	}
	return '';
}

const CHAR_FUNCTIONS = ['AES_DECRYPT', 'AES_ENCRYPT', 'BIN', 'CHAR', 'COMPRESS', 'CURRENT_USER', 'DATABASE', 'DAYNAME', 'DES_DECRYPT', 'DES_ENCRYPT', 'ENCRYPT', 'HEX', 'INET6_NTOA', 'INET_NTOA', 'LOAD_FILE', 'LOWER', 'LTRIM', 'MD5', 'MONTHNAME', 'OLD_PASSWORD', 'PASSWORD', 'QUOTE', 'REVERSE', 'RTRIM', 'SHA1', 'SOUNDEX', 'SPACE', 'TRIM', 'UNCOMPRESS', 'UNHEX', 'UPPER', 'USER', 'UUID', 'VERSION'];
const DATE_FUNCTIONS = ['CURRENT_DATE', 'CURRENT_TIME', 'DATE', 'FROM_DAYS', 'FROM_UNIXTIME', 'LAST_DAY', 'NOW', 'SEC_TO_TIME', 'SYSDATE', 'TIME', 'TIMESTAMP', 'UTC_DATE', 'UTC_TIME', 'UTC_TIMESTAMP', 'YEAR'];
// eslint-disable-next-line unicorn/text-encoding-identifier-case -- ASCII is the MySQL function name, not an encoding.
const NUMBER_FUNCTIONS = ['ABS', 'ACOS', 'ASCII', 'ASIN', 'ATAN', 'BIT_LENGTH', 'BIT_COUNT', 'CEILING', 'CHAR_LENGTH', 'CONNECTION_ID', 'COS', 'COT', 'CRC32', 'DAYOFMONTH', 'DAYOFWEEK', 'DAYOFYEAR', 'DEGREES', 'EXP', 'FLOOR', 'HOUR', 'INET6_ATON', 'INET_ATON', 'LENGTH', 'LN', 'LOG', 'LOG2', 'LOG10', 'MICROSECOND', 'MINUTE', 'MONTH', 'OCT', 'ORD', 'PI', 'QUARTER', 'RADIANS', 'RAND', 'ROUND', 'SECOND', 'SIGN', 'SIN', 'SQRT', 'TAN', 'TO_DAYS', 'TO_SECONDS', 'TIME_TO_SEC', 'UNCOMPRESSED_LENGTH', 'UNIX_TIMESTAMP', 'UUID_SHORT', 'WEEK', 'WEEKDAY', 'WEEKOFYEAR', 'YEARWEEK'];
const SPATIAL_FUNCTIONS = ['GeomFromText', 'GeomFromWKB', 'GeomCollFromText', 'LineFromText', 'MLineFromText', 'PointFromText', 'MPointFromText', 'PolyFromText', 'MPolyFromText', 'GeomCollFromWKB', 'LineFromWKB', 'MLineFromWKB', 'PointFromWKB', 'MPointFromWKB', 'PolyFromWKB', 'MPolyFromWKB'];

function lacksInet6(server: ServerFlavor): boolean {
	return (server.isMariaDB && server.version < 100012) || server.version < 50603;
}

/** Types::getFunctionsClass(). */
export function getFunctionsClass(typeClass: string, server: ServerFlavor): string[] {
	if (typeClass === 'CHAR') {
		return lacksInet6(server) ? CHAR_FUNCTIONS.filter(name => name !== 'INET6_NTOA') : [...CHAR_FUNCTIONS];
	}
	if (typeClass === 'DATE') {
		return [...DATE_FUNCTIONS];
	}
	if (typeClass === 'NUMBER') {
		return lacksInet6(server) ? NUMBER_FUNCTIONS.filter(name => name !== 'INET6_ATON') : [...NUMBER_FUNCTIONS];
	}
	if (typeClass === 'SPATIAL') {
		if (server.version >= 50600) {
			return SPATIAL_FUNCTIONS.map(name => `ST_${name}`);
		}
		return [...SPATIAL_FUNCTIONS];
	}
	return [];
}

/** Types::getFunctions(). */
export function getFunctions(type: string, server: ServerFlavor): string[] {
	return getFunctionsClass(getTypeClass(type), server);
}

/** Types::getAllFunctions(): every class's functions in PHP sort() order (plain byte order for these names). */
export function getAllFunctions(server: ServerFlavor): string[] {
	const all = [...getFunctionsClass('CHAR', server), ...getFunctionsClass('NUMBER', server), ...getFunctionsClass('DATE', server), ...getFunctionsClass('SPATIAL', server)];
	return all.toSorted((left, right) => {
		if (left < right) {
			return -1;
		}
		return Number(left > right);
	});
}

/** Types::getIntegerTypes(). */
export const INTEGER_TYPES = ['tinyint', 'smallint', 'mediumint', 'int', 'bigint'];

const INTEGER_RANGES: Record<'signed' | 'unsigned', Record<string, [string, string]>> = {
	unsigned: {
		tinyint: ['0', '255'],
		smallint: ['0', '65535'],
		mediumint: ['0', '16777215'],
		int: ['0', '4294967295'],
		bigint: ['0', '18446744073709551615'],
	},
	signed: {
		tinyint: ['-128', '127'],
		smallint: ['-32768', '32767'],
		mediumint: ['-8388608', '8388607'],
		int: ['-2147483648', '2147483647'],
		bigint: ['-9223372036854775808', '9223372036854775807'],
	},
};

/** Types::getIntegerRange(). */
export function getIntegerRange(type: string, signed = true): [string, string] {
	const ranges = signed ? INTEGER_RANGES.signed : INTEGER_RANGES.unsigned;
	return Object.hasOwn(ranges, type) ? ranges[type] : ['', ''];
}

export const UNARY_OPERATORS = ['IS NULL', 'IS NOT NULL', '= \'\'', '!= \'\''];
const NULL_OPERATORS = ['IS NULL', 'IS NOT NULL'];
const ENUM_OPERATORS = ['=', '!='];
const TEXT_OPERATORS = ['LIKE', 'LIKE %...%', 'NOT LIKE', 'NOT LIKE %...%', '=', '!=', 'REGEXP', 'REGEXP ^...$', 'NOT REGEXP', '= \'\'', '!= \'\'', 'IN (...)', 'NOT IN (...)', 'BETWEEN', 'NOT BETWEEN'];
const NUMBER_OPERATORS = ['=', '>', '>=', '<', '<=', '!=', 'LIKE', 'LIKE %...%', 'NOT LIKE', 'NOT LIKE %...%', 'IN (...)', 'NOT IN (...)', 'BETWEEN', 'NOT BETWEEN'];
const UUID_OPERATORS = ['=', '!=', 'LIKE', 'LIKE %...%', 'NOT LIKE', 'NOT LIKE %...%', 'IN (...)', 'NOT IN (...)'];

/** Types::isUnaryOperator(). */
export function isUnaryOperator(operator: string): boolean {
	return UNARY_OPERATORS.includes(operator);
}

/** Types::getTypeOperators(). */
export function getTypeOperators(type: string, nullable: boolean): string[] {
	const typeClass = getTypeClass(type);
	let operators: string[];
	if (type.slice(0, 4).toLowerCase() === 'enum') {
		operators = ENUM_OPERATORS;
	} else if (typeClass === 'CHAR') {
		operators = TEXT_OPERATORS;
	} else if (typeClass === 'UUID') {
		operators = UUID_OPERATORS;
	} else {
		operators = NUMBER_OPERATORS;
	}
	if (nullable) {
		return [...operators, ...NULL_OPERATORS];
	}
	return [...operators];
}

/** Types::getTypeOperatorsHtml(). */
export function getTypeOperatorsHtml(type: string, nullable: boolean, selectedOperator: string | null = null): string {
	let html = '';
	for (const operator of getTypeOperators(type, nullable)) {
		const selected = selectedOperator !== null && selectedOperator === operator ? ' selected="selected"' : '';
		html += `<option value="${htmlspecialchars(operator)}"${selected}>${htmlspecialchars(operator)}</option>`;
	}
	return html;
}

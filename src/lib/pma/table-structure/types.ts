// Column type lists of PhpMyAdmin\Types and the Query\Compatibility checks the column forms use.
import { htmlspecialchars } from '../../twig/php.ts';
import { sprintf } from '../sprintf.ts';

/** Util::getServerType() plus DatabaseInterface::getVersion(). */
export interface ServerKind {
	type: 'MySQL' | 'MariaDB' | 'Percona Server';
	version: number;
}

const isMariaDb = (server: ServerKind): boolean => server.type === 'MariaDB';

/** Compatibility::isUUIDSupported(). */
export function isUUIDSupported(server: ServerKind): boolean {
	return isMariaDb(server) && server.version >= 100700;
}

/** Compatibility::isIntegersLengthRestricted(). */
export function isIntegersLengthRestricted(server: ServerKind): boolean {
	return server.type === 'MySQL' && server.version >= 80018;
}

/** Compatibility::isIntegersSupportLength(). */
export function isIntegersSupportLength(type: string, length: string, server: ServerKind): boolean {
	const notAllowed = ['SMALLINT', 'MEDIUMINT', 'INT', 'BIGINT'].includes(type) || (type === 'TINYINT' && length !== '1');
	return !(isIntegersLengthRestricted(server) && notAllowed);
}

/** Compatibility::isVirtualColumnsSupported(). */
export function isVirtualColumnsSupported(server: ServerKind): boolean {
	if (isMariaDb(server)) {
		return server.version >= 50200;
	}
	return server.version >= 50706;
}

/** Compatibility::supportsStoredKeywordForVirtualColumns(). */
export function supportsStoredKeywordForVirtualColumns(server: ServerKind): boolean {
	if (isMariaDb(server)) {
		return server.version >= 100201;
	}
	return server.version >= 50706;
}

/** Compatibility::isCompatibleRenameIndex(). */
export function isCompatibleRenameIndex(server: ServerKind): boolean {
	if (isMariaDb(server)) {
		return server.version >= 100502;
	}
	return server.version >= 50700;
}

/** Types::getAttributes(). */
export function getAttributes(server: ServerKind): string[] {
	const attributes = ['', 'BINARY', 'UNSIGNED', 'UNSIGNED ZEROFILL', 'on update CURRENT_TIMESTAMP'];
	if (isMariaDb(server) && server.version >= 100100) {
		attributes.push('COMPRESSED=zlib');
	}
	return attributes;
}

/** Types::getColumns(): single types, then [group label, types] pairs, in upstream order. */
export function getColumnTypes(server: ServerKind): (string | [string, string[]])[] {
	const uuid = isUUIDSupported(server);
	const types: (string | [string, string[]])[] = ['INT', 'VARCHAR', 'TEXT', 'DATE'];
	if (uuid) {
		types.push('UUID');
	}
	types.push(
		['Numeric', ['TINYINT', 'SMALLINT', 'MEDIUMINT', 'INT', 'BIGINT', '-', 'DECIMAL', 'FLOAT', 'DOUBLE', 'REAL', '-', 'BIT', 'BOOLEAN', 'SERIAL']],
		['Date and time', ['DATE', 'DATETIME', 'TIMESTAMP', 'TIME', 'YEAR']],
	);
	const strings = ['CHAR', 'VARCHAR', '-', 'TINYTEXT', 'TEXT', 'MEDIUMTEXT', 'LONGTEXT', '-', 'BINARY', 'VARBINARY', '-', 'TINYBLOB', 'BLOB', 'MEDIUMBLOB', 'LONGBLOB', '-', 'ENUM', 'SET'];
	if (isMariaDb(server) && server.version >= 100500) {
		strings.push('-', 'INET6');
	}
	types.push(['String', strings], ['Spatial', ['GEOMETRY', 'POINT', 'LINESTRING', 'POLYGON', 'MULTIPOINT', 'MULTILINESTRING', 'MULTIPOLYGON', 'GEOMETRYCOLLECTION']]);
	if ((isMariaDb(server) && server.version > 100207) || (!isMariaDb(server) && server.version >= 50708)) {
		types.push(['JSON', ['JSON']]);
	}
	if (uuid) {
		types.push(['UUID', ['UUID']]);
	}
	return types;
}

const DESCRIPTIONS: Record<string, string> = {
	TINYINT: 'A 1-byte integer, signed range is -128 to 127, unsigned range is 0 to 255',
	SMALLINT: 'A 2-byte integer, signed range is -32,768 to 32,767, unsigned range is 0 to 65,535',
	MEDIUMINT: 'A 3-byte integer, signed range is -8,388,608 to 8,388,607, unsigned range is 0 to 16,777,215',
	INT: 'A 4-byte integer, signed range is -2,147,483,648 to 2,147,483,647, unsigned range is 0 to 4,294,967,295',
	BIGINT: 'An 8-byte integer, signed range is -9,223,372,036,854,775,808 to 9,223,372,036,854,775,807, unsigned range is 0 to 18,446,744,073,709,551,615',
	DECIMAL: 'A fixed-point number (M, D) - the maximum number of digits (M) is 65 (default 10), the maximum number of decimals (D) is 30 (default 0)',
	FLOAT: 'A small floating-point number, allowable values are -3.402823466E+38 to -1.175494351E-38, 0, and 1.175494351E-38 to 3.402823466E+38',
	DOUBLE: 'A double-precision floating-point number, allowable values are -1.7976931348623157E+308 to -2.2250738585072014E-308, 0, and 2.2250738585072014E-308 to 1.7976931348623157E+308',
	REAL: 'Synonym for DOUBLE (exception: in REAL_AS_FLOAT SQL mode it is a synonym for FLOAT)',
	BIT: 'A bit-field type (M), storing M of bits per value (default is 1, maximum is 64)',
	BOOLEAN: 'A synonym for TINYINT(1), a value of zero is considered false, nonzero values are considered true',
	SERIAL: 'An alias for BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE',
	DATE: sprintf('A date, supported range is %1$s to %2$s', '1000-01-01', '9999-12-31'),
	DATETIME: sprintf('A date and time combination, supported range is %1$s to %2$s', '1000-01-01 00:00:00', '9999-12-31 23:59:59'),
	TIMESTAMP: 'A timestamp, range is 1970-01-01 00:00:01 UTC to 2038-01-19 03:14:07 UTC on 32-bit platforms (MariaDB 11.3 and earlier), and up to 2106-02-07 06:28:15 UTC on 64-bit platforms (MariaDB 11.5 and later), stored as the number of seconds since the epoch (1970-01-01 00:00:00 UTC)',
	TIME: sprintf('A time, range is %1$s to %2$s', '-838:59:59', '838:59:59'),
	YEAR: 'A year in four-digit (4, default) or two-digit (2) format, the allowable values are 70 (1970) to 69 (2069) or 1901 to 2155 and 0000',
	CHAR: 'A fixed-length (0-255, default 1) string that is always right-padded with spaces to the specified length when stored',
	VARCHAR: sprintf('A variable-length (%s) string, the effective maximum length is subject to the maximum row size', '0-65,535'),
	TINYTEXT: 'A TEXT column with a maximum length of 255 (2^8 - 1) characters, stored with a one-byte prefix indicating the length of the value in bytes',
	TEXT: 'A TEXT column with a maximum length of 65,535 (2^16 - 1) characters, stored with a two-byte prefix indicating the length of the value in bytes',
	MEDIUMTEXT: 'A TEXT column with a maximum length of 16,777,215 (2^24 - 1) characters, stored with a three-byte prefix indicating the length of the value in bytes',
	LONGTEXT: 'A TEXT column with a maximum length of 4,294,967,295 or 4GiB (2^32 - 1) characters, stored with a four-byte prefix indicating the length of the value in bytes',
	BINARY: 'Similar to the CHAR type, but stores binary byte strings rather than non-binary character strings',
	VARBINARY: 'Similar to the VARCHAR type, but stores binary byte strings rather than non-binary character strings',
	TINYBLOB: 'A BLOB column with a maximum length of 255 (2^8 - 1) bytes, stored with a one-byte prefix indicating the length of the value',
	MEDIUMBLOB: 'A BLOB column with a maximum length of 16,777,215 (2^24 - 1) bytes, stored with a three-byte prefix indicating the length of the value',
	BLOB: 'A BLOB column with a maximum length of 65,535 (2^16 - 1) bytes, stored with a two-byte prefix indicating the length of the value',
	LONGBLOB: 'A BLOB column with a maximum length of 4,294,967,295 or 4GiB (2^32 - 1) bytes, stored with a four-byte prefix indicating the length of the value',
	ENUM: 'An enumeration, chosen from the list of up to 65,535 values or the special \'\' error value',
	SET: 'A single value chosen from a set of up to 64 members',
	GEOMETRY: 'A type that can store a geometry of any type',
	POINT: 'A point in 2-dimensional space',
	LINESTRING: 'A curve with linear interpolation between points',
	POLYGON: 'A polygon',
	MULTIPOINT: 'A collection of points',
	MULTILINESTRING: 'A collection of curves with linear interpolation between points',
	MULTIPOLYGON: 'A collection of polygons',
	GEOMETRYCOLLECTION: 'A collection of geometry objects of any type',
	JSON: 'Stores and enables efficient access to data in JSON (JavaScript Object Notation) documents',
	INET6: 'Intended for storage of IPv6 addresses, as well as IPv4 addresses assuming conventional mapping of IPv4 addresses into IPv6 addresses',
	UUID: '128-bit UUID (Universally Unique Identifier)',
};

/** Types::getTypeDescription(). */
export function getTypeDescription(type: string): string {
	return DESCRIPTIONS[type.toUpperCase()] ?? '';
}

function typeOption(type: string, selected: string, server: ServerKind): string {
	const restricted = isIntegersSupportLength(type, '2', server) ? 0 : 1;
	const selectedAttribute = selected === type ? 'selected="selected"' : '';
	return `<option data-length-restricted="${restricted}" ${selectedAttribute} title="${getTypeDescription(type)}">${type}</option>`;
}

/** Generator::getSupportedDatatypes(): the options of a column type select. */
export function getSupportedDatatypesHtml(server: ServerKind, selected: string): string {
	let html = '';
	for (const entry of getColumnTypes(server)) {
		if (typeof entry === 'string') {
			html += typeOption(entry, selected, server);
			continue;
		}
		const [label, types] = entry;
		html += `<optgroup label="${htmlspecialchars(label)}">`;
		for (const type of types) {
			if (type === '-') {
				html += '<option disabled="disabled">-</option>';
			} else {
				html += typeOption(type, selected, server);
			}
		}
		html += '</optgroup>';
	}
	return html;
}

/** Util::getSupportedDatatypes(false): every type once per group, without separators. */
export function getSupportedDatatypesList(server: ServerKind): string[] {
	return getColumnTypes(server).flatMap((entry) => {
		if (typeof entry === 'string') {
			return [entry];
		}
		return entry[1].filter(type => type !== '-');
	});
}

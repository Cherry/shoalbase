// PHP's string comparisons, which work on UTF-8 bytes and decide the order of database, table and column lists.

const encoder = new TextEncoder();

const isDigit = (byte: number): boolean => byte >= 0x30 && byte <= 0x39;

// C isspace(): space, \t, \n, \v, \f and \r.
const isSpace = (byte: number): boolean => byte === 0x20 || (byte >= 0x09 && byte <= 0x0D);

const asciiUpper = (byte: number): number => (byte >= 0x61 && byte <= 0x7A ? byte - 0x20 : byte);

const asciiLower = (byte: number): number => (byte >= 0x41 && byte <= 0x5A ? byte + 0x20 : byte);

// Reads past the end as NUL, like the C original reading a zend_string's terminator.
const at = (bytes: Uint8Array, index: number): number => bytes[index] ?? 0;

interface Cursor {
	bytes: Uint8Array;
	pos: number;
}

const digitAt = (cursor: Cursor): boolean => cursor.pos < cursor.bytes.length && isDigit(cursor.bytes[cursor.pos]);

// compare_right(): the longer run of digits wins, otherwise the first differing digit decides.
function compareRight(left: Cursor, right: Cursor): number {
	let bias = 0;
	for (;; left.pos++, right.pos++) {
		const leftDigit = digitAt(left);
		const rightDigit = digitAt(right);
		if (!leftDigit && !rightDigit) {
			return bias;
		}
		if (!leftDigit) {
			return -1;
		}
		if (!rightDigit) {
			return 1;
		}
		if (bias === 0) {
			bias = Math.sign(left.bytes[left.pos] - right.bytes[right.pos]);
		}
	}
}

// compare_left(): runs with a leading zero compare digit by digit, like fractions.
function compareLeft(left: Cursor, right: Cursor): number {
	for (;; left.pos++, right.pos++) {
		const leftDigit = digitAt(left);
		const rightDigit = digitAt(right);
		if (!leftDigit && !rightDigit) {
			return 0;
		}
		if (!leftDigit) {
			return -1;
		}
		if (!rightDigit) {
			return 1;
		}
		const difference = Math.sign(left.bytes[left.pos] - right.bytes[right.pos]);
		if (difference !== 0) {
			return difference;
		}
	}
}

function skipLeadingZeros(cursor: Cursor): void {
	while (at(cursor.bytes, cursor.pos) === 0x30 && cursor.pos + 1 < cursor.bytes.length && isDigit(cursor.bytes[cursor.pos + 1])) {
		cursor.pos++;
	}
}

function compareDigitRuns(left: Cursor, right: Cursor): number | null {
	const fractional = at(left.bytes, left.pos) === 0x30 || at(right.bytes, right.pos) === 0x30;
	const result = fractional ? compareLeft(left, right) : compareRight(left, right);
	if (result !== 0) {
		return result;
	}
	const leftEnded = left.pos === left.bytes.length;
	const rightEnded = right.pos === right.bytes.length;
	if (leftEnded || rightEnded) {
		return Number(rightEnded) - Number(leftEnded);
	}
	return null;
}

/** strnatcmp_ex() from ext/standard/strnatcmp.c (PHP 8.2+, ASCII-only case folding). */
function naturalCompare(leftText: string, rightText: string, foldCase: boolean): number {
	const leftCursor: Cursor = { bytes: encoder.encode(leftText), pos: 0 };
	const rightCursor: Cursor = { bytes: encoder.encode(rightText), pos: 0 };
	if (leftCursor.bytes.length === 0 || rightCursor.bytes.length === 0) {
		return Math.sign(leftCursor.bytes.length - rightCursor.bytes.length);
	}
	skipLeadingZeros(leftCursor);
	skipLeadingZeros(rightCursor);
	for (;;) {
		while (isSpace(at(leftCursor.bytes, leftCursor.pos))) {
			leftCursor.pos++;
		}
		while (isSpace(at(rightCursor.bytes, rightCursor.pos))) {
			rightCursor.pos++;
		}
		if (isDigit(at(leftCursor.bytes, leftCursor.pos)) && isDigit(at(rightCursor.bytes, rightCursor.pos))) {
			const result = compareDigitRuns(leftCursor, rightCursor);
			if (result !== null) {
				return result;
			}
		}
		let leftByte = at(leftCursor.bytes, leftCursor.pos);
		let rightByte = at(rightCursor.bytes, rightCursor.pos);
		if (foldCase) {
			leftByte = asciiUpper(leftByte);
			rightByte = asciiUpper(rightByte);
		}
		if (leftByte !== rightByte) {
			return Math.sign(leftByte - rightByte);
		}
		leftCursor.pos++;
		rightCursor.pos++;
		const leftEnded = leftCursor.pos >= leftCursor.bytes.length;
		const rightEnded = rightCursor.pos >= rightCursor.bytes.length;
		if (leftEnded || rightEnded) {
			return Number(rightEnded) - Number(leftEnded);
		}
	}
}

/** strnatcmp(). */
export function strnatcmp(left: string, right: string): number {
	return naturalCompare(left, right, false);
}

/** strnatcasecmp(), the comparison behind $cfg['NaturalOrder']. */
export function strnatcasecmp(left: string, right: string): number {
	return naturalCompare(left, right, true);
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
	const length = Math.min(left.length, right.length);
	for (let index = 0; index < length; index++) {
		if (left[index] !== right[index]) {
			return Math.sign(left[index] - right[index]);
		}
	}
	return Math.sign(left.length - right.length);
}

/** strcmp(), normalised to -1, 0 or 1. */
export function strcmp(left: string, right: string): number {
	return compareBytes(encoder.encode(left), encoder.encode(right));
}

/** strcasecmp(): ASCII-only case folding, as in PHP 8.2+. */
export function strcasecmp(left: string, right: string): number {
	return compareBytes(encoder.encode(left).map(byte => asciiLower(byte)), encoder.encode(right).map(byte => asciiLower(byte)));
}

// PHP 8 numeric strings allow surrounding whitespace, a sign, a fraction and an exponent.
const NUMERIC_STRING = /^[\t\n\v\f\r ]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?[\t\n\v\f\r ]*$/i;

/** Whether PHP treats the string as numeric (is_numeric() for strings). */
export function isNumericString(value: string): boolean {
	return NUMERIC_STRING.test(value);
}

/** `$a <=> $b` for two strings, which sort() uses by default: numeric strings compare as numbers. */
export function phpCompareStrings(left: string, right: string): number {
	if (isNumericString(left) && isNumericString(right)) {
		return Math.sign(Number(left) - Number(right));
	}
	return strcmp(left, right);
}

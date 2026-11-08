// Port of PhpMyAdmin\VersionInformation: picks the newest phpMyAdmin release this installation could run.

/** PHP_VERSION of the official phpmyadmin:5.2 image that production mirrors; release conditions are checked against it. */
export const PHP_VERSION = '8.3.36';

const SPECIAL_FORMS: [string, number][] = [
	['dev', 0],
	['alpha', 1],
	['a', 1],
	['beta', 2],
	['b', 2],
	['RC', 3],
	['rc', 3],
	['#', 4],
	['pl', 5],
	['p', 5],
];

const isDigit = (character: string): boolean => character >= '0' && character <= '9';
const isAlphanumeric = (character: string): boolean => isDigit(character) || /[A-Z]/i.test(character);
const startsWithDigit = (part: string): boolean => isDigit(part.charAt(0));

/** php_canonicalize_version(): separators become dots, and digit/non-digit boundaries get one. */
function canonicalize(version: string): string {
	let result = version[0];
	let previous = version[0];
	for (const character of version.slice(1)) {
		const lastIsDot = result.endsWith('.');
		if (['-', '_', '+'].includes(character)) {
			if (!lastIsDot) {
				result += '.';
			}
		} else if (previous !== '.' && character !== '.' && isDigit(previous) !== isDigit(character)) {
			if (!lastIsDot) {
				result += '.';
			}
			result += character;
		} else if (isAlphanumeric(character)) {
			result += character;
		} else if (!lastIsDot) {
			result += '.';
		}
		previous = character;
	}
	return result;
}

function specialFormOrder(form: string): number {
	const match = SPECIAL_FORMS.find(([name]) => form.startsWith(name));
	return match ? match[1] : -6;
}

const sign = (value: number): number => Math.sign(value);

function comparePart(left: string, right: string): number {
	if (startsWithDigit(left) && startsWithDigit(right)) {
		return sign(Number.parseInt(left, 10) - Number.parseInt(right, 10));
	}
	if (!startsWithDigit(left) && !startsWithDigit(right)) {
		return sign(specialFormOrder(left) - specialFormOrder(right));
	}
	if (startsWithDigit(left)) {
		return sign(specialFormOrder('#N#') - specialFormOrder(right));
	}
	return sign(specialFormOrder(left) - specialFormOrder('#N#'));
}

/** php_version_compare(): -1, 0 or 1. */
function compareVersions(left: string, right: string): number {
	if (left === '' || right === '') {
		if (left === right) {
			return 0;
		}
		return left === '' ? -1 : 1;
	}
	const leftParts = canonicalize(left).split('.');
	const rightParts = canonicalize(right).split('.');
	const shared = Math.min(leftParts.length, rightParts.length);
	for (let index = 0; index < shared; index += 1) {
		const result = comparePart(leftParts[index], rightParts[index]);
		if (result !== 0) {
			return result;
		}
	}
	if (leftParts.length > shared) {
		return startsWithDigit(leftParts[shared]) ? 1 : compareVersions(leftParts.slice(shared).join('.'), '#N#');
	}
	if (rightParts.length > shared) {
		return startsWithDigit(rightParts[shared]) ? -1 : compareVersions('#N#', rightParts.slice(shared).join('.'));
	}
	return 0;
}

/** PHP's version_compare() with an operator; an unknown operator is false here, where PHP would throw. */
export function versionCompare(left: string, right: string, operator: string): boolean {
	const result = compareVersions(left, right);
	switch (operator) {
		case '<':
		case 'lt': {
			return result === -1;
		}
		case '<=':
		case 'le': {
			return result !== 1;
		}
		case '>':
		case 'gt': {
			return result === 1;
		}
		case '>=':
		case 'ge': {
			return result !== -1;
		}
		case '==':
		case '=':
		case 'eq': {
			return result === 0;
		}
		case '!=':
		case '<>':
		case 'ne': {
			return result !== 0;
		}
		default: {
			return false;
		}
	}
}

// VersionInformation::evaluateVersionCondition()'s operators, longest first so "<=" is not read as "<".
const CONDITION_OPERATORS = ['<=', '>=', '!=', '<>', '<', '>', '='];

/** VersionInformation::evaluateVersionCondition() against a known version; null means the version is unknown. */
export function evaluateVersionCondition(myVersion: string | null, condition: string): boolean {
	const operator = CONDITION_OPERATORS.find(candidate => condition.startsWith(candidate));
	if (myVersion === null || operator === undefined) {
		return false;
	}
	return versionCompare(myVersion, condition.slice(operator.length), operator);
}

export interface Release {
	version: string;
	date: string;
	php_versions: string;
	mysql_versions: string;
}

export interface VersionData {
	version: string;
	date: string;
	releases: Release[];
}

const nonEmpty = (value: unknown): boolean => value !== undefined && value !== null && value !== '' && value !== '0' && value !== 0 && value !== false
	&& !(Array.isArray(value) && value.length === 0);

/** VersionInformation::getLatestVersion()'s sanity check of version.json; null when it is not usable. */
export function parseVersionData(response: string): VersionData | null {
	let data: unknown;
	try {
		data = JSON.parse(response === '' ? '{}' : response);
	} catch {
		return null;
	}
	if (typeof data !== 'object' || data === null || Array.isArray(data)) {
		return null;
	}
	const { version, releases, date } = data as Record<string, unknown>;
	if (!nonEmpty(version) || !nonEmpty(releases) || !nonEmpty(date)) {
		return null;
	}
	return data as VersionData;
}

export interface CompatibilityInput {
	phpVersion: string;
	/** DatabaseInterface::getVersionString(), only consulted when a single server is configured. */
	mysqlVersion: string | null;
	serverCount: number;
}

/** VersionInformation::getLatestCompatibleVersion(). */
export function latestCompatibleVersion(releases: Release[], input: CompatibilityInput): { version: string; date: string; } | null {
	let latest: { version: string; date: string; } | null = null;
	for (const release of releases) {
		if (!release.php_versions.split(',').every(condition => evaluateVersionCondition(input.phpVersion, condition))) {
			continue;
		}
		if (input.serverCount === 1 && !release.mysql_versions.split(',').every(condition => evaluateVersionCondition(input.mysqlVersion, condition))) {
			continue;
		}
		if (latest !== null && !versionCompare(latest.version, release.version, '<')) {
			continue;
		}
		latest = { version: release.version, date: release.date };
	}
	return latest;
}

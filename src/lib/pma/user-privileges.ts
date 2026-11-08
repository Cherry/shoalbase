// Port of PhpMyAdmin\CheckUserPrivileges: what the signed-in account may create, read from SHOW GRANTS.
import { getSystemSchemas } from './dbi-sql.ts';
import { backquote } from '../twig/sanitize.ts';

export interface UserPrivileges {
	/** $GLOBALS['is_create_db_priv']. */
	isCreateDbPriv: boolean;
	isReloadPriv: boolean;
	/** A database name the account may create, with wildcards removed. */
	dbToCreate: string;
	/** Database patterns (possibly with wildcards) where CREATE TABLE is allowed; "*" means everywhere. */
	dbsWhereCreateTableAllowed: string[];
	/** Databases to list when information_schema is disabled; false means all. */
	dbsToTest: string[] | false;
	dbPriv: boolean;
	colPriv: boolean;
	tablePriv: boolean;
	procPriv: boolean;
}

/** mb_strpos() with PHP's false, which arithmetic treats as 0. */
const position = (haystack: string, needle: string, offset = 0): number | false => {
	const index = haystack.indexOf(needle, offset);
	return index === -1 ? false : index;
};

/** mb_substr() for a non-negative start, including negative lengths counted from the end. */
const substring = (value: string, start: number, length: number): string => {
	let end = start + length;
	if (length < 0) {
		end = value.length + length;
	}
	return value.slice(start, Math.max(start, end));
};

/** Util::unQuote() for one quote character. */
const unQuote = (value: string, quote: string): string => {
	if (value.length >= 2 && value.startsWith(quote) && value.endsWith(quote)) {
		return value.slice(1, -1).split(quote + quote).join(quote);
	}
	return value;
};

/** CheckUserPrivileges::getItemsFromShowGrantsRow(): the privileges, database and table of one grant. */
export function getItemsFromShowGrantsRow(row: string): [string, string, string] {
	const onOffset = Number(position(row, ' ON '));
	const dbNameOffset = onOffset + 4;
	const tableNameEndOffset = Number(position(row, ' TO '));
	let tableNameStartOffset: number | false = false;
	const quotedEnd = position(row, '`.', dbNameOffset);
	if (quotedEnd !== false && quotedEnd > 0 && quotedEnd < tableNameEndOffset) {
		tableNameStartOffset = quotedEnd + 1;
	}
	if (tableNameStartOffset === false) {
		tableNameStartOffset = Number(position(row, '.', dbNameOffset));
	}
	const dbName = unQuote(substring(row, dbNameOffset, tableNameStartOffset - dbNameOffset), '`');
	const privileges = substring(row, 6, onOffset - 6);
	const tableName = unQuote(substring(row, tableNameStartOffset + 1, tableNameEndOffset - tableNameStartOffset - 1), '`');
	return [privileges, dbName, tableName];
}

const isAllPrivileges = (privileges: string): boolean => privileges === 'ALL' || privileges === 'ALL PRIVILEGES';

/** CheckUserPrivileges::checkRequiredPrivilegesForAdjust(). */
export function checkRequiredPrivilegesForAdjust(state: UserPrivileges, privileges: string, dbName: string, tableName: string): void {
	if (!isAllPrivileges(privileges) && !privileges.includes('SELECT, INSERT, UPDATE, DELETE')) {
		return;
	}
	if (dbName === '*' && tableName === '*') {
		state.colPriv = true;
		state.dbPriv = true;
		state.procPriv = true;
		state.tablePriv = true;
		if (isAllPrivileges(privileges)) {
			state.isReloadPriv = true;
		}
	}
	if (dbName !== 'mysql') {
		return;
	}
	if (tableName === 'columns_priv' || tableName === '*') {
		state.colPriv = true;
	}
	if (tableName === 'db' || tableName === '*') {
		state.dbPriv = true;
	}
	if (tableName === 'procs_priv' || tableName === '*') {
		state.procPriv = true;
	}
	if (tableName === 'tables_priv' || tableName === '*') {
		state.tablePriv = true;
	}
}

// Wildcards not escaped by a backslash, and backslash-escaped wildcards, as upstream's $re0 and $re1.
const RE0 = String.raw`(^|(\\\\)+|[^\\])`;
const RE1 = String.raw`(^|[^\\])(\\)+`;
const HAS_WILDCARD = /(?:^|(?:\\\\)+|[^\\])%|_/;
const HAS_ESCAPED_WILDCARD = /\\%|\\_/;
const UNESCAPE_WILDCARDS = new RegExp(`${RE1}(%|_)`, 'g');
const STRIP_PERCENT = new RegExp(`${RE0}%`, 'g');

/** The privileges when MySQL runs with --skip-grant-tables and CURRENT_USER() has no user part. */
export function unrestrictedPrivileges(): UserPrivileges {
	return {
		isCreateDbPriv: true,
		isReloadPriv: true,
		dbToCreate: '',
		dbsWhereCreateTableAllowed: ['*'],
		dbsToTest: false,
		dbPriv: true,
		colPriv: true,
		tablePriv: true,
		procPriv: true,
	};
}

/**
 * CheckUserPrivileges::analyseShowGrant(). `grants` is the first column of SHOW GRANTS (null when it failed), and
 * `useDatabase` runs a USE statement, returning null on success or DatabaseInterface::getError() on failure.
 */
export async function analyseShowGrants(grants: string[] | null, useDatabase: (sql: string) => Promise<string | null>): Promise<UserPrivileges> {
	const state: UserPrivileges = {
		isCreateDbPriv: false,
		isReloadPriv: false,
		dbToCreate: '',
		dbsWhereCreateTableAllowed: [],
		dbsToTest: getSystemSchemas(),
		dbPriv: false,
		colPriv: false,
		tablePriv: false,
		procPriv: false,
	};
	for (const row of grants ?? []) {
		const [privileges, dbName, tableName] = getItemsFromShowGrantsRow(row);
		if (dbName === '*') {
			if (privileges !== 'USAGE') {
				state.dbsToTest = false;
			}
		} else if (state.dbsToTest !== false) {
			state.dbsToTest.push(dbName);
		}
		if (privileges.includes('RELOAD')) {
			state.isReloadPriv = true;
		}
		checkRequiredPrivilegesForAdjust(state, privileges, dbName, tableName);
		if (!isAllPrivileges(privileges) && privileges !== 'CREATE' && !privileges.includes('CREATE,')) {
			continue;
		}
		if (dbName === '*') {
			state.isCreateDbPriv = true;
			state.isReloadPriv = true;
			state.dbToCreate = '';
			state.dbsWhereCreateTableAllowed.push('*');
			break;
		}
		state.dbsWhereCreateTableAllowed.push(dbName);
		if (state.isCreateDbPriv) {
			continue;
		}
		// A grant without wildcards (or with escaped ones) names one database; if it exists, there is nothing to create.
		if (!HAS_WILDCARD.test(dbName) || HAS_ESCAPED_WILDCARD.test(dbName)) {
			const error = await useDatabase(`USE ${backquote(dbName).replaceAll(UNESCAPE_WILDCARDS, '$1$3')}`);
			if (error === null || error.slice(1, 5) === '1044') {
				continue;
			}
		}
		state.dbToCreate = dbName.replaceAll(STRIP_PERCENT, '$1').replaceAll(UNESCAPE_WILDCARDS, '$1$3');
		state.isCreateDbPriv = true;
	}
	return state;
}

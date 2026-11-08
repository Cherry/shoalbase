// DatabaseInterface::getTriggers(), getEvents() and getRoutines() with information_schema, as the database pages use them.
import { phpCompareStrings } from '../../../../lib/pma/php-compare.ts';
import { backquote } from '../../../../lib/twig/sanitize.ts';

import type { PmaContext } from '../../core/context.ts';

export interface TriggerInfo {
	name: string;
	table: string;
	action_timing: string;
	event_manipulation: string;
	definition: string;
	definer: string;
	full_trigger_name: string;
	drop: string;
	create: string;
}

export interface EventInfo {
	name: string;
	type: string;
	status: string;
}

export interface RoutineInfo {
	db: string;
	name: string;
	type: string;
	definer: string;
	returns: string;
}

// array_multisort($names, SORT_ASC, $rows) orders by name first.
function byName<T extends { name: string; }>(rows: T[]): T[] {
	return rows.toSorted((left, right) => phpCompareStrings(left.name, right.name));
}

/** DatabaseInterface::getTriggers(). */
export async function getTriggers(context: PmaContext, db: string, table = '', delimiter = '//'): Promise<TriggerInfo[]> {
	const { dbi } = context;
	const collate = await dbi.getCollateForIS();
	let query = 'SELECT TRIGGER_SCHEMA, TRIGGER_NAME, EVENT_MANIPULATION, EVENT_OBJECT_TABLE, ACTION_TIMING, ACTION_STATEMENT, EVENT_OBJECT_SCHEMA, EVENT_OBJECT_TABLE, DEFINER'
		+ ` FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA ${collate}= '${dbi.escapeString(db)}'`;
	if (table !== '') {
		query += ` AND EVENT_OBJECT_TABLE ${collate} = '${dbi.escapeString(table)}';`;
	}
	const rows = await dbi.fetchResult(query);
	return byName(rows.map((row) => {
		const name = String(row.TRIGGER_NAME ?? '');
		const fullName = backquote(name);
		const statement = String(row.ACTION_STATEMENT ?? '');
		return {
			name,
			table: String(row.EVENT_OBJECT_TABLE ?? ''),
			action_timing: String(row.ACTION_TIMING ?? ''),
			event_manipulation: String(row.EVENT_MANIPULATION ?? ''),
			definition: statement,
			definer: String(row.DEFINER ?? ''),
			full_trigger_name: fullName,
			drop: `DROP TRIGGER IF EXISTS ${fullName}`,
			create: `CREATE TRIGGER ${fullName} ${row.ACTION_TIMING ?? ''} ${row.EVENT_MANIPULATION ?? ''} ON ${backquote(row.EVENT_OBJECT_TABLE ?? '')}\n FOR EACH ROW ${statement}\n${delimiter}\n`,
		};
	}));
}

/** QueryGenerator::getInformationSchemaEventsRequest(). */
export function eventsQuery(escapedDb: string, collate: string, escapedName: string | null): string {
	let query = 'SELECT `EVENT_SCHEMA` AS `Db`, `EVENT_NAME` AS `Name`, `DEFINER` AS `Definer`, `TIME_ZONE` AS `Time zone`,'
		+ ' `EVENT_TYPE` AS `Type`, `EXECUTE_AT` AS `Execute at`, `INTERVAL_VALUE` AS `Interval value`,'
		+ ' `INTERVAL_FIELD` AS `Interval field`, `STARTS` AS `Starts`, `ENDS` AS `Ends`, `STATUS` AS `Status`,'
		+ ' `ORIGINATOR` AS `Originator`, `CHARACTER_SET_CLIENT` AS `character_set_client`,'
		+ ' `COLLATION_CONNECTION` AS `collation_connection`, `DATABASE_COLLATION` AS `Database Collation`'
		+ ` FROM \`information_schema\`.\`EVENTS\` WHERE \`EVENT_SCHEMA\` ${collate} = '${escapedDb}'`;
	if (escapedName !== null) {
		query += ` AND \`EVENT_NAME\` = '${escapedName}'`;
	}
	return query;
}

/** DatabaseInterface::getEvents(). */
export async function getEvents(context: PmaContext, db: string, name = ''): Promise<EventInfo[]> {
	const { dbi } = context;
	const query = eventsQuery(dbi.escapeString(db), await dbi.getCollateForIS(), name === '' ? null : dbi.escapeString(name));
	const rows = await dbi.fetchResult(query);
	return byName(rows.map((row) => {
		return { name: String(row.Name ?? ''), type: String(row.Type ?? ''), status: String(row.Status ?? '') };
	}));
}

/** QueryGenerator::getInformationSchemaRoutinesRequest(). */
export function routinesQuery(escapedDb: string, collate: string, type: string | null, escapedName: string | null): string {
	let query = 'SELECT `ROUTINE_SCHEMA` AS `Db`, `SPECIFIC_NAME` AS `Name`, `ROUTINE_TYPE` AS `Type`, `DEFINER` AS `Definer`,'
		+ ' `LAST_ALTERED` AS `Modified`, `CREATED` AS `Created`, `SECURITY_TYPE` AS `Security_type`,'
		+ ' `ROUTINE_COMMENT` AS `Comment`, `CHARACTER_SET_CLIENT` AS `character_set_client`,'
		+ ' `COLLATION_CONNECTION` AS `collation_connection`, `DATABASE_COLLATION` AS `Database Collation`, `DTD_IDENTIFIER`'
		+ ` FROM \`information_schema\`.\`ROUTINES\` WHERE \`ROUTINE_SCHEMA\` ${collate} = '${escapedDb}'`;
	if (type !== null) {
		query += ` AND \`ROUTINE_TYPE\` = '${type}'`;
	}
	if (escapedName !== null) {
		query += ` AND \`SPECIFIC_NAME\` = '${escapedName}'`;
	}
	return query;
}

/** DatabaseInterface::getRoutines(). */
export async function getRoutines(context: PmaContext, db: string, which: string | null = null, name = ''): Promise<RoutineInfo[]> {
	const { dbi } = context;
	let type: string | null = null;
	if (which === 'FUNCTION' || which === 'PROCEDURE') {
		type = which;
	}
	const query = routinesQuery(dbi.escapeString(db), await dbi.getCollateForIS(), type, name === '' ? null : dbi.escapeString(name));
	const rows = await dbi.fetchResult(query);
	return byName(rows.map((row) => {
		return {
			db: String(row.Db ?? ''),
			name: String(row.Name ?? ''),
			type: String(row.Type ?? ''),
			definer: String(row.Definer ?? ''),
			returns: String(row.DTD_IDENTIFIER ?? ''),
		};
	}));
}

/** DatabaseInterface::getProceduresOrFunctions(). */
export async function getProceduresOrFunctions(context: PmaContext, db: string, which: 'FUNCTION' | 'PROCEDURE'): Promise<string[]> {
	const rows = await context.dbi.fetchResult(`SHOW ${which} STATUS;`);
	return rows.filter(row => row.Db === db && row.Type === which).map(row => String(row.Name));
}

const DEFINITION_FIELDS = { PROCEDURE: 'Create Procedure', FUNCTION: 'Create Function', EVENT: 'Create Event', VIEW: 'Create View' };

/** DatabaseInterface::getDefinition(). */
export async function getDefinition(context: PmaContext, db: string, which: keyof typeof DEFINITION_FIELDS, name: string): Promise<string | null> {
	const value = await context.dbi.fetchValue(`SHOW CREATE ${which} ${backquote(db)}.${backquote(name)}`, DEFINITION_FIELDS[which]);
	return typeof value === 'string' ? value : null;
}

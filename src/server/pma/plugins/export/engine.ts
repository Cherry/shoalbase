// The state one export shares between Export.php and its plugin: posted options as $GLOBALS, the output buffers and aliases.
import { escapeBinary, validUtf8OrEmpty } from '../../../../lib/pma/export-import/bytes.ts';
import { BINARY_CHARSET, type FieldMetadata, FieldType } from '../../../../lib/pma/field-metadata.ts';
import { phpCompareStrings } from '../../../../lib/pma/php-compare.ts';
import { htmlspecialchars } from '../../../../lib/twig/php.ts';
import { backquote } from '../../../../lib/twig/sanitize.ts';
import { Context } from '../../../../sql-parser/index.ts';

import type { PluginProperties } from '../../../../lib/pma/export-import/properties.ts';
import type { PmaContext } from '../../core/context.ts';

/** $aliases: [db => [alias, tables => [table => [alias, columns => [column => alias]]]]]. */
export type ExportAliases = Record<string, {
	alias?: string;
	tables?: Record<string, { alias?: string; columns?: Record<string, string>; }>;
}>;

/** A PHP Error (TypeError and the like) the plugin hits, which upstream reports through the bare "Internal error" page. */
export class PhpError extends Error {
	constructor(readonly errorClass = 'TypeError') {
		super(errorClass);
	}
}

/** Export::outputHandler() and the buffers it fills. */
export class ExportOutput {
	/** What PHP echoes straight away: the file body, or HTML-escaped text for "View output as text". */
	readonly echoed: string[] = [];
	dumpBuffer = '';
	readonly dumpBufferObjects = new Map<string, string>();

	constructor(private readonly bufferNeeded: boolean, private readonly asfile: boolean) {}

	write(line: string): boolean {
		if (this.bufferNeeded) {
			this.dumpBuffer += line;
		} else if (this.asfile) {
			this.echoed.push(line);
		} else {
			// htmlspecialchars($line, ENT_COMPAT) keeps single quotes and returns '' for invalid UTF-8.
			this.echoed.push(htmlspecialchars(validUtf8OrEmpty(line)).replaceAll('&#039;', '\''));
		}
		return true;
	}

	/** Export::saveObjectInBuffer(). */
	saveObjectInBuffer(name: string, append = false): void {
		if (this.dumpBuffer !== '') {
			const existing = this.dumpBufferObjects.get(name);
			if (append && existing !== undefined) {
				this.dumpBufferObjects.set(name, existing + this.dumpBuffer);
			} else {
				this.dumpBufferObjects.set(name, this.dumpBuffer);
			}
		}
		this.dumpBuffer = '';
	}
}

/** Context::loadClosest() for the connected server with no SQL mode; call it right before parsing, since the parser state is global. */
export function loadParserContext(context: PmaContext): void {
	const { dbi } = context;
	Context.loadClosest(`${dbi.isMariaDB() ? 'MariaDb' : 'MySql'}${dbi.getVersion()}`);
	Context.setMode();
}

/** One export request. */
export class ExportRun {
	/** The posted options copied into $GLOBALS by ExportController, plus the ones the plugins set themselves. */
	readonly globals: Record<string, unknown>;

	constructor(
		readonly context: PmaContext,
		globals: Record<string, unknown>,
		readonly out: ExportOutput,
		readonly crlf: string,
		readonly properties: PluginProperties,
	) {
		this.globals = globals;
	}

	/** isset($GLOBALS[$name]). */
	has(name: string): boolean {
		return this.globals[name] !== undefined && this.globals[name] !== null;
	}

	/** $GLOBALS[$name] as a string, '' when unset or an array. */
	str(name: string): string {
		const value = this.globals[name];
		return typeof value === 'string' ? value : '';
	}

	/** isset($GLOBALS[$name]) && $GLOBALS[$name]: set and truthy. */
	flag(name: string): boolean {
		const value = this.globals[name];
		return value !== undefined && value !== null && value !== '' && value !== '0' && value !== false && value !== 0;
	}

	write(line: string): boolean {
		return this.out.write(line);
	}

	/** Loads the parser context of the connected server, as DatabaseInterface::postConnect() does once per request. */
	loadParserContext(): void {
		loadParserContext(this.context);
	}
}

/** ExportPlugin's shared behaviour; each format overrides what it supports. */
export abstract class ExportPlugin {
	/** Formats without their own exportRawQuery() keep ExportPlugin's, which refuses raw queries. */
	protected readonly supportsRawQuery: boolean = true;

	constructor(protected readonly run: ExportRun) {}

	protected get dbi() {
		return this.run.context.dbi;
	}

	protected get crlf(): string {
		return this.run.crlf;
	}

	abstract exportHeader(): Promise<boolean>;

	async exportFooter(): Promise<boolean> {
		return true;
	}

	// The hooks below are optional, as in PHP where a plugin without them does nothing at that step.
	exportDBHeader?(db: string, dbAlias?: string): Promise<boolean>;

	exportDBFooter?(db: string): Promise<boolean>;

	exportDBCreate?(db: string, exportType: string, dbAlias?: string): Promise<boolean>;

	abstract exportData(db: string, table: string, sqlQuery: string, aliases: ExportAliases): Promise<boolean>;

	exportRoutines?(db: string, aliases: ExportAliases): Promise<boolean>;

	exportEvents?(db: string): Promise<boolean>;

	/** ExportPlugin::exportRawQuery(): most formats re-run exportData() with the raw query. */
	async exportRawQuery(db: string | null, sqlQuery: string): Promise<boolean> {
		if (!this.supportsRawQuery) {
			return false;
		}
		if (db !== null) {
			await this.dbi.selectDb(db);
		}
		return this.exportData(db ?? '', '', sqlQuery, {});
	}

	exportStructure?(db: string, table: string, exportMode: string, exportType: string, options: StructureOptions, aliases: ExportAliases): Promise<boolean>;

	/** ExportPlugin::initAlias(): [dbAlias, tableAlias]. */
	protected initAlias(aliases: ExportAliases, db: string, table = ''): [string, string] {
		let dbAlias = db;
		let tableAlias = table;
		const tableEntry = aliases[db]?.tables?.[table]?.alias;
		if (tableEntry) {
			tableAlias = tableEntry;
		}
		const dbEntry = aliases[db]?.alias;
		if (dbEntry) {
			dbAlias = dbEntry;
		}
		return [dbAlias, tableAlias];
	}

	/** $aliases[$db]['tables'][$table]['columns'][$column] when not empty. */
	protected columnAlias(aliases: ExportAliases, db: string, table: string, column: string): string {
		return aliases[db]?.tables?.[table]?.columns?.[column] || column;
	}

	/** ExportPlugin::getAlias(). */
	protected getAlias(aliases: ExportAliases, id: string, type = 'dbtblcol', db = '', table = ''): string {
		let databases = aliases;
		if (db !== '' && aliases[db] !== undefined) {
			databases = { [db]: aliases[db] };
		}
		for (const [dbKey, dbEntry] of Object.entries(databases)) {
			if (type.toLowerCase().includes('db') && dbKey === id && dbEntry.alias) {
				return dbEntry.alias;
			}
			let tables = dbEntry.tables ?? {};
			if (table !== '' && tables[table] !== undefined) {
				tables = { [table]: tables[table] };
			}
			for (const [tableKey, tableEntry] of Object.entries(tables)) {
				if (type.toLowerCase().includes('tbl') && tableKey === id && tableEntry.alias) {
					return tableEntry.alias;
				}
				for (const [columnKey, column] of Object.entries(tableEntry.columns ?? {})) {
					if (type.toLowerCase().includes('col') && columnKey === id && column) {
						return column;
					}
				}
			}
		}
		return '';
	}
}

/** The relation, comments, mime and dates switches Export.php passes to exportStructure(). */
export interface StructureOptions {
	relation: boolean;
	comments: boolean;
	mime: boolean;
	dates: boolean;
}

/** Whether the DBI handed this column over as bytes (the binary charset), which PHP writes out unchanged. */
export function isBinaryField(meta: FieldMetadata): boolean {
	return meta.charsetnr === BINARY_CHARSET && !meta.isType(FieldType.JSON);
}

/** A column value ready to write raw into a file: binary columns keep their bytes. */
export function rawValue(value: string, meta: FieldMetadata): string {
	return isBinaryField(meta) ? escapeBinary(value) : value;
}

/** stripslashes(). */
export function stripslashes(value: string): string {
	return value.replaceAll(/\\(.?)/gs, (_, next: string) => (next === '0' ? '\0' : next));
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

export interface Trigger {
	name: string;
	table: string;
	actionTiming: string;
	event: string;
	definition: string;
	drop: string;
	create: string;
}

/** DatabaseInterface::getTriggers() through information_schema, sorted by name. */
export async function getTriggers(context: PmaContext, db: string, table = '', delimiter = '//'): Promise<Trigger[]> {
	const { dbi } = context;
	const collate = await dbi.getCollateForIS();
	let query = 'SELECT TRIGGER_SCHEMA, TRIGGER_NAME, EVENT_MANIPULATION, EVENT_OBJECT_TABLE, ACTION_TIMING, ACTION_STATEMENT, EVENT_OBJECT_SCHEMA, EVENT_OBJECT_TABLE, DEFINER'
		+ ` FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA ${collate}= '${dbi.escapeString(db)}'`;
	if (table !== '') {
		query += ` AND EVENT_OBJECT_TABLE ${collate} = '${dbi.escapeString(table)}';`;
	}
	const rows = await dbi.fetchResult(query);
	const triggers = rows.map((row) => {
		const fullName = backquote(row.TRIGGER_NAME);
		return {
			name: String(row.TRIGGER_NAME),
			table: String(row.EVENT_OBJECT_TABLE),
			actionTiming: String(row.ACTION_TIMING),
			event: String(row.EVENT_MANIPULATION),
			definition: String(row.ACTION_STATEMENT),
			drop: `DROP TRIGGER IF EXISTS ${fullName}`,
			create: `CREATE TRIGGER ${fullName} ${row.ACTION_TIMING} ${row.EVENT_MANIPULATION} ON ${backquote(row.EVENT_OBJECT_TABLE)}\n FOR EACH ROW ${row.ACTION_STATEMENT}\n${delimiter}\n`,
		};
	});
	return triggers.toSorted((left, right) => phpCompareStrings(left.name, right.name));
}

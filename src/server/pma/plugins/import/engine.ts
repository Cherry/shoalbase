// Port of PhpMyAdmin\Import: the globals one import shares with its plugin, and how statements are queued, run and reported.
import { unQuote } from '../../../../lib/pma/database/routines.ts';
import {
	type ImportTable,
	type TableAnalysis,
	createTableSql,
	insertSql,
} from '../../../../lib/pma/export-import/import-analysis.ts';
import { Message } from '../../../../lib/pma/message.ts';
import { sprintf } from '../../../../lib/pma/sprintf.ts';
import { htmlspecialchars } from '../../../../lib/twig/php.ts';
import { backquote } from '../../../../lib/twig/sanitize.ts';
import { getFromRoute } from '../../../../lib/twig/url.ts';
import { Table } from '../../core/table.ts';

import type { PmaContext } from '../../core/context.ts';
import type { DbiResult } from '../../core/dbi.ts';

/** $sql_data: the statements handed to /sql afterwards. */
export interface SqlData {
	valid_sql: string[];
	valid_full?: string[];
	valid_queries: number;
}

/** The file being imported, already decompressed: Import::getNextChunk() reads it. */
export interface ImportSource {
	/** The content as text (charset converted, byte order mark removed). */
	text: string;
	/** The decompressed bytes, for the binary formats. */
	bytes: Uint8Array;
	/** The upload as sent, which the Shapefile import searches when it is a zip. */
	raw: Uint8Array;
}

/** Generator::mysqlDie() with exit inside a plugin: the controller prints the error and stops. */
export class ImportDie extends Error {
	constructor(readonly serverMessage: string, readonly sqlQuery: string, readonly backUrl: string, readonly pageMessage?: Message) {
		super(serverMessage);
	}
}

/** What the controller tells the plugin about this import. */
export interface ImportOptions {
	/** server, database, table or query. */
	importType: string;
	/** $import_file_name, the uploaded file's name. */
	fileName: string;
	/** $errorUrl. */
	errorUrl: string;
	/** File::getCompression() of the upload. */
	compression: string;
	/** $charset_conversion. */
	charsetConversion: boolean;
}

/** The globals of ImportController and Import. */
export class ImportRun {
	private runBuffer: { sql: string; full: string; } | null = null;
	private chunkRead = false;
	/** The global $message a plugin leaves for the page. */
	message: Message | undefined;
	/** What a plugin echoed, which becomes the page when nothing else was added to it. */
	echoed = '';
	sqlQuery = '';
	completeQuery = '';
	displayQuery = '';
	goSql = false;
	error = false;
	result: DbiResult | false = false;
	msg = 'Sorry an unexpected error happened!';
	readonly myDie: { sql: string; error: string; }[] = [];
	sqlQueryDisabled = false;
	executedQueries = 0;
	maxSqlLen = 0;
	runQueryEnabled = true;
	skipQueries = 0;
	importNotice: string | null = null;
	finished = false;
	offset = 0;
	readonly sqlData: SqlData = { valid_sql: [], valid_queries: 0 };

	constructor(
		readonly context: PmaContext,
		/** The upload, or null for the query box text. */
		readonly source: ImportSource | null,
		/** $import_text. */
		private readonly importText: string,
		readonly options: ImportOptions,
	) {}

	// Import::runQueryPost(): an empty call clears the queue.
	private runQueryPost(sql: string, full: string): { sql: string; full: string; } | null {
		const empty = (value: string): boolean => value === '' || value === '0';
		if (!empty(sql) || !empty(full)) {
			return { sql: `${sql};`, full: `${full};` };
		}
		return null;
	}

	echo(text: string): void {
		this.echoed += text;
	}

	get dbi() {
		return this.context.dbi;
	}

	/** isset($_POST['rollback_query']). */
	get rollbackRequested(): boolean {
		return this.context.request.post.rollback_query !== undefined;
	}

	/**
	 * Import::getNextChunk(): everything is in memory, so the whole content comes as one chunk and then true.
	 * There is no timeout: a Worker request cannot be resumed the way a PHP import can.
	 */
	getNextChunk(): string | true {
		if (this.finished || this.chunkRead) {
			return true;
		}
		this.chunkRead = true;
		this.finished = true;
		if (this.source === null) {
			return this.importText;
		}
		this.offset += this.source.bytes.length;
		return this.source.text;
	}

	/** Import::executeQuery(). */
	async executeQuery(sql: string, full: string): Promise<void> {
		const { dbi, context } = this;
		this.result = await dbi.tryQuery(sql);
		const isUseQuery = sql.toLowerCase().includes('use ');
		this.msg = '# ';
		if (this.result === false) {
			this.myDie.push({ sql: full, error: dbi.getError() });
			this.msg += 'Error';
			if (!context.config.IgnoreMultiSubmitErrors) {
				this.error = true;
				return;
			}
		} else {
			const numRows = this.result.numRows();
			const affectedRows = dbi.affectedRows();
			if (numRows > 0) {
				this.msg += `Rows: ${numRows}`;
			} else if (affectedRows > 0) {
				this.msg += Message.getMessageForAffectedRows(affectedRows).getMessage();
			} else {
				this.msg += 'MySQL returned an empty result set (i.e. zero rows).';
			}
			if (numRows > 0 || isUseQuery) {
				this.sqlData.valid_sql.push(sql);
				this.sqlData.valid_queries++;
			}
		}
		if (!this.sqlQueryDisabled) {
			this.sqlQuery += `${this.msg}\n`;
		}
		if (this.result !== false) {
			this.lookForUse(sql);
		}
		if (this.result === false || !/^\s*(?:DROP|CREATE)\s+(?:IF EXISTS\s+)?(?:TABLE|DATABASE)\s+.+/im.test(sql)) {
			return;
		}
		context.response.globals.reload = true;
	}

	/** Import::runQuery(): queues one statement and runs the previous one. */
	async runQuery(sql = '', full = ''): Promise<void> {
		const buffer = this.runBuffer;
		if (buffer === null) {
			this.runBuffer = this.runQueryPost(sql, full);
			return;
		}
		if (this.skipQueries > 0) {
			this.skipQueries--;
			this.runBuffer = this.runQueryPost(sql, full);
			return;
		}
		// The queued statement always ends with ';', so it is never empty.
		this.maxSqlLen = Math.max(this.maxSqlLen, [...buffer.sql].length);
		if (!this.sqlQueryDisabled) {
			this.sqlQuery += buffer.full;
		}
		this.executedQueries++;
		if (this.runQueryEnabled && this.executedQueries < 50) {
			this.goSql = true;
			if (this.sqlQueryDisabled) {
				this.completeQuery = '';
				this.displayQuery = '';
			} else {
				this.completeQuery = this.sqlQuery;
				this.displayQuery = this.sqlQuery;
			}
			this.sqlQuery = buffer.sql;
			this.sqlData.valid_sql.push(buffer.sql);
			(this.sqlData.valid_full ??= []).push(buffer.full);
			this.sqlData.valid_queries++;
		} else if (this.runQueryEnabled) {
			// The first 49 statements were left for /sql; past that they all run here.
			if (this.goSql && this.sqlData.valid_full !== undefined) {
				const queries = this.sqlData.valid_sql;
				const fulls = this.sqlData.valid_full;
				const count = this.sqlData.valid_queries;
				this.goSql = false;
				this.sqlData.valid_sql = [];
				this.sqlData.valid_queries = 0;
				delete this.sqlData.valid_full;
				for (let index = 0; index < count; index++) {
					await this.executeQuery(queries[index], fulls[index]);
					if (this.error) {
						break;
					}
				}
			}
			if (!this.error) {
				await this.executeQuery(buffer.sql, buffer.full);
			}
		}
		if (!this.goSql && this.runQueryEnabled && this.sqlQuery !== '' && this.sqlQuery !== '0' && ([...this.sqlQuery].length > 50000 || this.executedQueries > 50 || this.maxSqlLen > 1000)) {
			this.sqlQuery = '';
			this.sqlQueryDisabled = true;
		}
		this.runBuffer = this.runQueryPost(sql, full);
		if (this.rollbackRequested) {
			this.msg += '[ROLLBACK occurred.]';
		}
	}

	/** Import::lookForUse(): a USE statement switches the current database. */
	lookForUse(buffer: string): void {
		const match = /^\s*USE\s+(\S+)/i.exec(buffer);
		if (match === null) {
			return;
		}
		this.context.db = unQuote(match[1].trim().replaceAll(/^;+|;+$/g, ''));
		this.context.response.globals.reload = true;
	}

	/** Import::buildSql(): creates the database and tables when asked, inserts the rows and builds $import_notice. */
	async buildSql(dbName: string, tables: ImportTable[], analyses: TableAnalysis[] | null, additionalSql: string[] | null, createDb = true): Promise<void> {
		const { dbi, context } = this;
		this.importNotice = null;
		if (createDb) {
			const sql = `CREATE DATABASE IF NOT EXISTS ${backquote(dbName)} DEFAULT CHARACTER SET utf8 COLLATE utf8_general_ci;`;
			await this.runQuery(sql, sql);
		}
		const cleaned = (additionalSql ?? []).map(sql => sql.replace(/CREATE [^`]*(TABLE)/, 'CREATE $1 IF NOT EXISTS'));
		for (const sql of cleaned) {
			await this.runQuery(sql, sql);
		}
		if (analyses !== null) {
			for (const [index, table] of tables.entries()) {
				const sql = createTableSql(dbName, table, analyses[index], backquote);
				await this.runQuery(sql, sql);
			}
		}
		for (const [index, table] of tables.entries()) {
			const sql = insertSql(dbName, table, analyses?.[index] ?? null, backquote, value => dbi.escapeString(value));
			if (sql === null) {
				break;
			}
			await this.runQuery(sql, sql);
		}

		const names = tables.map(table => table.name);
		for (const sql of cleaned) {
			const match = /VIEW `[^`]+`\.`([^`]+)/.exec(sql) ?? /CREATE TABLE IF NOT EXISTS `([^`]+)`/.exec(sql);
			if (match !== null && !names.includes(match[1])) {
				names.push(match[1]);
			}
		}
		const url = context.urlState();
		const dbParams = { db: dbName };
		let message = '<br><br><strong>The following structures have either been created or altered. Here you can:</strong><br>';
		message += '<ul><li>View a structure\'s contents by clicking on its name.</li>';
		message += '<li>Change any of its settings by clicking the corresponding "Options" link.</li>';
		message += '<li>Edit structure by following the "Structure" link.</li>';
		message += sprintf(
			'<br><li><a href="%s" title="%s">%s</a> (<a href="%s" title="%s">Options</a>)</li>',
			getFromRoute(url, '/database/structure', dbParams),
			sprintf('Go to database: %s', htmlspecialchars(backquote(dbName))),
			htmlspecialchars(dbName),
			getFromRoute(url, '/database/operations', dbParams),
			sprintf('Edit settings for %s', htmlspecialchars(backquote(dbName))),
		);
		message += '<ul>';
		for (const name of names) {
			const params = { db: dbName, table: name };
			const quoted = htmlspecialchars(backquote(name));
			if (await Table.get(context, name, dbName).isView()) {
				message += sprintf('<li><a href="%s" title="%s">%s</a></li>', getFromRoute(url, '/sql', params), sprintf('Go to view: %s', quoted), htmlspecialchars(name));
			} else {
				message += sprintf(
					'<li><a href="%s" title="%s">%s</a> (<a href="%s" title="%s">Structure</a>) (<a href="%s" title="%s">Options</a>)</li>',
					getFromRoute(url, '/sql', params),
					sprintf('Go to table: %s', quoted),
					htmlspecialchars(name),
					getFromRoute(url, '/table/structure', params),
					sprintf('Structure of %s', quoted),
					getFromRoute(url, '/table/operations', params),
					sprintf('Edit settings for %s', quoted),
				);
			}
		}
		this.importNotice = `${message}</ul></ul>`;
	}
}

/** The ImportPlugin interface: doImport() reads the source and feeds statements to the run. */
export interface ImportPlugin {
	doImport(run: ImportRun): Promise<void>;
}

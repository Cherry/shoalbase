// Ports of Plugins\Import\ImportCsv and ImportLdi.
import { ImportDie, type ImportPlugin, type ImportRun } from './engine.ts';
import { invalidCsvOption, parseCsv, unescapeCsvOption } from '../../../../lib/pma/export-import/csv-import.ts';
import { analyzeTable } from '../../../../lib/pma/export-import/import-analysis.ts';
import { Message } from '../../../../lib/pma/message.ts';
import { isNumericString } from '../../../../lib/pma/php-compare.ts';
import { backquote } from '../../../../lib/twig/sanitize.ts';

import type { DbiRow } from '../../core/dbi.ts';

// PHP's trim() set plus the backquote users may type around column names.
const trimColumn = (value: string): string => value.replaceAll(/^[ \t\r\n\0\v`]+|[ \t\r\n\0\v`]+$/g, '');

/** A $_POST value the plugin reads through Core::setPostAsGlobal(), or '' when it is absent. */
function postValue(run: ImportRun, name: string): string {
	const value = run.context.request.post[name];
	return typeof value === 'string' ? value : '';
}

/** $_REQUEST['csv_partial_import'] when it is a positive number, else 0 for every line. */
function partialImport(run: ImportRun): number {
	const value = run.context.request.params.csv_partial_import;
	if (typeof value !== 'string' || !isNumericString(value)) {
		return 0;
	}
	return Math.max(0, Math.trunc(Number(value)));
}

export class ImportCsv implements ImportPlugin {
	private formatError(run: ImportRun, line: number): void {
		run.message = Message.error('Invalid format of CSV input on line %d.');
		run.message.addParam(line);
		run.error = true;
	}

	// ImportCsv::getSqlTemplateAndRequiredFields(); null when a listed column does not exist.
	private async sqlTemplate(run: ImportRun, columns: string): Promise<[string, DbiRow[]] | null> {
		const { context } = run;
		let template = 'INSERT';
		if (context.request.post.csv_ignore !== undefined) {
			template += ' IGNORE';
		}
		template += ` INTO ${backquote(context.table)}`;
		const columnMap = await context.dbi.getColumns(context.db, context.table);
		const tableFields = columnMap.values().toArray();
		if (columns === '' || columns === '0') {
			return [`${template} VALUES (`, tableFields];
		}
		const fields: DbiRow[] = [];
		const names: string[] = [];
		for (const rawName of columns.split(/, ?/)) {
			const name = trimColumn(rawName);
			const field = tableFields.find(candidate => candidate.Field === name);
			if (field === undefined) {
				run.message = Message.error('Invalid column (%s) specified! Ensure that columns names are spelled correctly, separated by commas, and not enclosed in quotes.');
				run.message.addParam(name);
				run.error = true;
				return null;
			}
			fields.push(field);
			names.push(backquote(name));
		}
		return [`${template} (${names.join(', ')})  VALUES (`, fields];
	}

	// The analysing branch: guess the column types and create a new table, in a new database outside a database.
	private async buildTable(run: ImportRun, parsedRows: (string | null)[][]): Promise<void> {
		const { context } = run;
		const { dbi, request } = context;
		const maxCols = Math.max(0, ...parsedRows.map(row => row.length));
		const rows = parsedRows.map(row => [...row, ...Array.from({ length: maxCols - row.length }, () => 'NULL')]);
		let columnNames: string[] = [];
		if (request.params.csv_col_names !== undefined && rows.length > 0) {
			columnNames = (rows.shift() as (string | null)[]).map(name => (name ?? '').trimEnd());
		}
		if (columnNames.length !== maxCols) {
			columnNames.push(...Array.from({ length: maxCols }, (_, index) => `COL ${index + 1}`));
		}
		const table = { name: await this.tableName(run), columns: columnNames, rows };
		const analysis = analyzeTable(table);
		let newDb = typeof request.params.csv_new_db_name === 'string' ? request.params.csv_new_db_name : '';
		if (newDb === '') {
			const databases = await dbi.fetchResult('SHOW DATABASES') as unknown[];
			newDb = `CSV_DB ${databases.length + 1}`;
		}
		// ImportPlugin::getDbnameAndOptions(): inside a database the table goes there and no database is created.
		if (context.db !== '') {
			await run.buildSql(context.db, [table], [analysis], null, false);
			return;
		}
		await run.buildSql(newDb, [table], [analysis], null);
	}

	// ImportCsv::getTableNameFromImport().
	private async tableName(run: ImportRun): Promise<string> {
		const { context } = run;
		const requested = context.request.params.csv_new_tbl_name;
		if (typeof requested === 'string' && requested !== '') {
			return requested;
		}
		const base = run.options.fileName.replace(/^.*[/\\]/, '');
		const encoder = new TextEncoder();
		const fileName = (base.endsWith('.csv') && base !== '.csv' ? base.slice(0, -4) : base).toLowerCase()
			.replaceAll(/\W/gu, character => '_'.repeat(encoder.encode(character).length));
		if (context.db === '') {
			return fileName;
		}
		const tables = (await context.dbi.fetchResult('SHOW TABLES') as unknown[]).map(String);
		if (tables.length === 0 || !tables.some(name => name.toLowerCase() === fileName.toLowerCase())) {
			return fileName;
		}
		const prefixed = tables.filter(name => name.toLowerCase().startsWith(`${fileName.toLowerCase()}_`));
		return `${fileName}_${prefixed.length + 1}`;
	}

	async doImport(run: ImportRun): Promise<void> {
		const { context } = run;
		const { dbi, request } = context;
		const options = {
			terminated: unescapeCsvOption(postValue(run, 'csv_terminated')),
			enclosed: unescapeCsvOption(postValue(run, 'csv_enclosed')),
			escaped: unescapeCsvOption(postValue(run, 'csv_escaped')),
			newLine: unescapeCsvOption(postValue(run, 'csv_new_line')),
		};
		const invalid = invalidCsvOption(options);
		if (invalid !== null) {
			const message = Message.error('Invalid parameter for CSV import: %s');
			message.addParam(invalid);
			throw new ImportDie(message.getMessage(), '', run.options.errorUrl, message);
		}
		const analyze = run.options.importType !== 'table';
		let sqlTemplate = '';
		let fields: DbiRow[] = [];
		if (!analyze) {
			const template = await this.sqlTemplate(run, postValue(run, 'csv_columns'));
			if (template === null) {
				await run.runQuery('', '');
				return;
			}
			[sqlTemplate, fields] = template;
		}
		const maxLines = partialImport(run);
		let maxLinesConstraint = 0;
		if (maxLines > 0) {
			maxLinesConstraint = maxLines + 1 + (request.params.csv_col_names === undefined ? 0 : 1);
		}
		const data = run.getNextChunk();
		const parsed = parseCsv(data === true ? '' : data, { ...options, maxLinesConstraint });
		let line = 1;
		for (const values of analyze ? [] : parsed.rows) {
			if (values.length !== fields.length) {
				if (values.at(-1) !== ';') {
					run.message = Message.error('Invalid column count in CSV input on line %d.');
					run.message.addParam(line);
					run.error = true;
					break;
				}
				values.pop();
			}
			let sql = sqlTemplate + values.map(value => (value === null ? 'NULL' : `'${dbi.escapeString(value)}'`)).join(', ');
			sql += ')';
			if (request.post.csv_replace !== undefined) {
				sql += ' ON DUPLICATE KEY UPDATE ';
				sql += fields.map(field => `${backquote(field.Field)} = VALUES(${backquote(field.Field)})`).join(', ');
			}
			await run.runQuery(sql, sql);
			line++;
		}
		// Splitting got stuck after the rows before it were already queued.
		if (parsed.formatErrorLine !== null && !run.error) {
			this.formatError(run, parsed.formatErrorLine);
		}
		if (analyze) {
			await this.buildTable(run, parsed.rows);
		}
		await run.runQuery('', '');
	}
}

// The shape of PHP's upload temporary names, /tmp/php followed by six letters and digits.
function temporaryName(): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	const random = crypto.getRandomValues(new Uint8Array(6));
	return `/tmp/php${[...random].map(byte => alphabet[byte % alphabet.length]).join('')}`;
}

export class ImportLdi implements ImportPlugin {
	async doImport(run: ImportRun): Promise<void> {
		const { context } = run;
		const { dbi, request } = context;
		if (run.source === null || run.options.compression !== 'none' || run.options.charsetConversion) {
			run.message = Message.error('This plugin does not support compressed imports!');
			run.error = true;
			return;
		}
		const post = request.post;
		let sql = 'LOAD DATA';
		if (post.ldi_local_option !== undefined) {
			sql += ' LOCAL';
		}
		// PHP names the upload's temporary file; there is none here, so the statement gets a name of the same shape.
		sql += ` INFILE '${dbi.escapeString(temporaryName())}'`;
		if (post.ldi_replace !== undefined) {
			sql += ' REPLACE';
		} else if (post.ldi_ignore !== undefined) {
			sql += ' IGNORE';
		}
		sql += ` INTO TABLE ${backquote(context.table)}`;
		const terminated = postValue(run, 'ldi_terminated');
		const enclosed = postValue(run, 'ldi_enclosed');
		const escaped = postValue(run, 'ldi_escaped');
		let newLine = postValue(run, 'ldi_new_line');
		if (terminated !== '') {
			sql += ` FIELDS TERMINATED BY '${terminated}'`;
		}
		if (enclosed !== '') {
			sql += ` ENCLOSED BY '${dbi.escapeString(enclosed)}'`;
		}
		if (escaped !== '') {
			sql += ` ESCAPED BY '${dbi.escapeString(escaped)}'`;
		}
		if (newLine !== '') {
			if (newLine === 'auto') {
				newLine = String.raw`\n`;
			}
			sql += ` LINES TERMINATED BY '${newLine}'`;
		}
		if (run.skipQueries > 0) {
			sql += ` IGNORE ${run.skipQueries} LINES`;
			run.skipQueries = 0;
		}
		const columns = postValue(run, 'ldi_columns');
		if (columns !== '') {
			sql += ` (${columns.split(/, ?/).map(name => backquote(trimColumn(name))).join(', ')})`;
		}
		await run.runQuery(sql, sql);
		await run.runQuery('', '');
		run.finished = true;
	}
}


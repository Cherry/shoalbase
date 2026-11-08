// Ports of Plugins\Import\ImportOds, ImportXml and ImportMediawiki, which turn documents into new tables.
import {
	type ImportTable,
	type TableAnalysis,
	analyzeTable,
	getColumnAlphaName,
	phpFloatString,
	phpFloatval,
} from '../../../../lib/pma/export-import/import-analysis.ts';
import { parseMediawiki } from '../../../../lib/pma/export-import/mediawiki-import.ts';
import {
	type XmlElement,
	attributeOf,
	childNamed,
	childrenOf,
	directText,
	parseXml,
	usesPrefix,
} from '../../../../lib/pma/export-import/xml.ts';
import { Message } from '../../../../lib/pma/message.ts';
import { phpEmpty } from '../../../../lib/pma/server/php.ts';
import { backquote } from '../../../../lib/twig/sanitize.ts';

import type { ImportPlugin, ImportRun } from './engine.ts';

const MALFORMED = 'The XML file specified was either malformed or incomplete. Please correct the issue and try again.';

/** The whole input, which these plugins read before parsing. */
function readAll(run: ImportRun): string {
	let buffer = '';
	for (let data = run.getNextChunk(); data !== true; data = run.getNextChunk()) {
		buffer += data;
	}
	return buffer;
}

/** ImportPlugin::getDbnameAndOptions() followed by Import::buildSql(). */
async function buildInDatabase(run: ImportRun, defaultDb: string, tables: ImportTable[], analyses: TableAnalysis[] | null, create: string[] | null): Promise<void> {
	const current = run.context.db;
	if (current !== '') {
		await run.buildSql(current, tables, analyses, create, false);
		return;
	}
	await run.buildSql(defaultDb, tables, analyses, create);
}

/** Pairs each table with its rows the way the ODS and XML imports do: the first match gives the columns. */
function mergeTables(names: string[], sheets: { name: string; columns: string[]; rows: (string | null)[][]; }[], appendRows: boolean): ImportTable[] {
	return names.map((name) => {
		const table: ImportTable = { name, columns: [], rows: [] };
		let columns: string[] | undefined;
		for (const sheet of sheets) {
			if (sheet.name !== name) {
				continue;
			}
			columns ??= sheet.columns;
			if (appendRows) {
				table.rows.push(...sheet.rows);
			} else {
				table.rows = sheet.rows;
			}
		}
		table.columns = columns ?? [];
		return table;
	});
}

export class ImportOds implements ImportPlugin {
	// ImportOds::getValue(): recognised percentages and currencies become numbers, other cells join their paragraphs.
	private value(run: ImportRun, cell: XmlElement, paragraphs: XmlElement[]): string {
		const params = run.context.request.params;
		const type = attributeOf(cell, 'office', 'value-type');
		if ((!phpEmpty(params.ods_recognize_percentages) && type === 'percentage') || (!phpEmpty(params.ods_recognize_currency) && type === 'currency')) {
			return phpFloatString(phpFloatval(attributeOf(cell, 'office', 'value')));
		}
		return paragraphs.map((paragraph) => {
			const text = directText(paragraph);
			const link = childNamed(paragraph, 'text', 'a');
			if (text === '' && link !== undefined) {
				return directText(link);
			}
			return text;
		}).join('\n');
	}

	// ImportOds::iterateOverTables() with its row and column loops.
	private readSheets(run: ImportRun, sheets: XmlElement[]): { name: string; columns: string[]; rows: string[][]; }[] {
		const params = run.context.request.params;
		const result: { name: string; columns: string[]; rows: string[][]; }[] = [];
		for (const sheet of sheets) {
			let namesInFirstRow = params.ods_col_names !== undefined;
			let columnNames: string[] = [];
			let rows: string[][] = [];
			let maxCols = 0;
			for (const row of childrenOf(sheet, 'table')) {
				if (row.localName !== 'table-row') {
					continue;
				}
				const cells = childrenOf(row, 'table');
				const values: string[] = [];
				const add = (value: string, name: string): void => {
					if (namesInFirstRow) {
						columnNames.push(name);
					} else {
						values.push(value);
					}
				};
				let count = 0;
				for (const [index, cell] of cells.entries()) {
					const paragraphs = childrenOf(cell, 'text');
					const repeated = Math.trunc(phpFloatval(attributeOf(cell, 'table', 'number-columns-repeated')));
					if (paragraphs.length > 0) {
						for (let repeat = 0; repeat < (repeated || 1); repeat++) {
							const value = this.value(run, cell, paragraphs);
							add(value, value.trimEnd());
							count++;
						}
						continue;
					}
					// An empty last cell is the end of the row, however many columns it spans.
					if (index === cells.length - 1) {
						continue;
					}
					for (let repeat = 0; repeat < (repeated || 1); repeat++) {
						add('NULL', getColumnAlphaName(count + 1));
						count++;
					}
				}
				maxCols = Math.max(maxCols, count);
				if (!namesInFirstRow && (phpEmpty(params.ods_empty_rows) || values.some(cell => cell !== 'NULL'))) {
					rows.push(values);
				}
				namesInFirstRow = false;
			}
			if (rows.length === 0 || rows[0].length === 0) {
				continue;
			}
			for (let index = columnNames.length; index < maxCols; index++) {
				columnNames.push(getColumnAlphaName(index + 1));
			}
			rows = rows.map(row => [...row, ...Array.from({ length: Math.max(0, maxCols - row.length) }, () => 'NULL')]);
			result.push({ name: attributeOf(sheet, 'table', 'name'), columns: columnNames, rows });
			columnNames = [];
		}
		return result;
	}

	async doImport(run: ImportRun): Promise<void> {
		const xml = parseXml(readAll(run));
		let sheets: XmlElement[] = [];
		if (xml === null) {
			run.message = Message.error(MALFORMED);
			run.error = true;
		} else {
			const body = childNamed(xml, 'office', 'body');
			const spreadsheet = body === undefined ? undefined : childNamed(body, 'office', 'spreadsheet');
			if (spreadsheet === undefined) {
				run.message = Message.error('Could not parse OpenDocument Spreadsheet!');
				run.error = true;
			} else {
				sheets = childrenOf(spreadsheet, 'table');
			}
		}
		const found = this.readSheets(run, sheets);
		const tables = mergeTables(found.map(sheet => sheet.name), found, false);
		await buildInDatabase(run, 'ODS_DB', tables, tables.map(table => analyzeTable(table)), null);
		await run.runQuery('', '');
	}
}

export class ImportXml implements ImportPlugin {
	// The plugin echoes this error instead of setting $message, and clears $finished.
	private malformed(run: ImportRun): void {
		run.echo(Message.error(MALFORMED).getDisplay());
		run.finished = false;
	}

	async doImport(run: ImportRun): Promise<void> {
		const xml = parseXml(readAll(run));
		if (xml === null) {
			this.malformed(run);
			return;
		}
		const hasPma = usesPrefix(xml, 'pma');
		const schemas = childNamed(xml, hasPma ? 'pma' : null, 'structure_schemas');
		const database = schemas === undefined ? undefined : childNamed(schemas, hasPma ? 'pma' : null, 'database');
		let dbName: string;
		if (database === undefined) {
			const first = childrenOf(xml, null)[0];
			dbName = first === undefined ? '' : attributeOf(first, null, 'name');
		} else {
			dbName = attributeOf(database, null, 'name');
		}
		if (dbName === '') {
			this.malformed(run);
			return;
		}
		let create: string[] | null = null;
		if (hasPma) {
			create = [];
			for (const group of childrenOf(xml, 'pma')) {
				for (const db of childrenOf(group, 'pma')) {
					create.push(`USE ${backquote(attributeOf(db, null, 'name'))}`);
					for (const statement of childrenOf(db, 'pma')) {
						create.push(directText(statement).replaceAll(' '.repeat(16), ''));
					}
				}
			}
		}
		const names: string[] = [];
		const sheets: { name: string; columns: string[]; rows: (string | null)[][]; }[] = [];
		const firstDatabase = childrenOf(xml, null)[0];
		const tableElements = firstDatabase === undefined ? [] : childrenOf(firstDatabase, null);
		let analyses: TableAnalysis[] | null = null;
		if (tableElements.length > 0 && childrenOf(tableElements[0], null).length > 0) {
			for (const table of tableElements) {
				const name = attributeOf(table, null, 'name');
				if (!names.includes(name)) {
					names.push(name);
				}
				const columns: string[] = [];
				const cells: string[] = [];
				for (const column of childrenOf(table, null)) {
					const columnName = attributeOf(column, null, 'name');
					if (!columns.includes(columnName)) {
						columns.push(columnName);
					}
					cells.push(directText(column));
				}
				sheets.push({ name, columns, rows: [cells] });
			}
		}
		const tables = mergeTables(names, sheets, true);
		if (!hasPma && tables.length > 0) {
			analyses = tables.map(table => analyzeTable(table));
		}
		await buildInDatabase(run, dbName, tables, analyses, create);
		await run.runQuery('', '');
	}
}

export class ImportMediawiki implements ImportPlugin {
	async doImport(run: ImportRun): Promise<void> {
		const { context } = run;
		const parsed = parseMediawiki(readAll(run));
		const analyze = run.options.importType !== 'table';
		for (const found of parsed.tables) {
			if (analyze) {
				let name = found.name;
				if (name === '' || name === '0') {
					const tables = await context.dbi.fetchResult('SHOW TABLES') as unknown[];
					name = `TABLE ${tables.length + 1}`;
				}
				let headers = found.headers;
				if (found.rows.length > 0 && headers.length === 0) {
					headers = found.rows[0].map((_, index) => `COL ${index + 1}`);
				}
				const table: ImportTable = { name, columns: headers, rows: found.rows };
				await buildInDatabase(run, 'mediawiki_DB', [table], [analyzeTable(table)], null);
			}
			await run.runQuery('', '');
		}
		// The parse error message is a local variable upstream, so only the error flag survives.
		run.error ||= parsed.error;
	}
}

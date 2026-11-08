// Ports of the row-oriented export plugins: CSV, CSV for MS Excel, JSON, YAML, PHP array and XML.
import {
	type ExportAliases,
	ExportPlugin,
	getDefinition,
	getProceduresOrFunctions,
	getTriggers,
	isBinaryField,
	rawValue,
	stripslashes,
} from './engine.ts';
import { PHP_VERSION } from './sql.ts';
import { substituteInvalid } from '../../../../lib/pma/export-import/bytes.ts';
import { BINARY_CHARSET, FieldType } from '../../../../lib/pma/field-metadata.ts';
import { PMA_VERSION } from '../../../../lib/pma/header.ts';
import { isNumericString } from '../../../../lib/pma/php-compare.ts';
import { bin2hex } from '../../../../lib/pma/sql/results.ts';
import { localisedDate } from '../../../../lib/pma/util.ts';
import { htmlspecialchars } from '../../../../lib/twig/php.ts';
import { backquote } from '../../../../lib/twig/sanitize.ts';
import { Table } from '../../core/table.ts';

import type { FieldMetadata } from '../../../../lib/pma/field-metadata.ts';
import type { DbiRow } from '../../core/dbi.ts';

// PHP's trim() character set.
const phpTrim = (value: string): string => value.replaceAll(/^[ \t\n\r\0\v]+|[ \t\n\r\0\v]+$/g, '');

/** Port of ExportCsv, which ExportExcel extends with fixed separators. */
export class ExportCsv extends ExportPlugin {
	private terminated = '';
	private separator = '';
	private enclosed = '';
	private escaped = '';
	protected what = 'csv';

	private enclose(value: string): string {
		const { enclosed, escaped } = this;
		if (enclosed === '') {
			return value;
		}
		if (escaped !== enclosed) {
			return enclosed + value.replaceAll(escaped, () => escaped + escaped).replaceAll(enclosed, () => escaped + enclosed) + enclosed;
		}
		return enclosed + value.replaceAll(enclosed, () => escaped + enclosed) + enclosed;
	}

	async exportHeader(): Promise<boolean> {
		const { run } = this;
		if (this.what === 'excel') {
			this.terminated = '\r\n';
			const edition = run.str('excel_edition');
			this.separator = run.str('csv_separator');
			if (edition === 'win' || edition === 'mac_excel2003') {
				this.separator = ';';
			} else if (edition === 'mac_excel2008') {
				this.separator = ',';
			}
			this.enclosed = '"';
			this.escaped = '"';
			if (run.has('excel_columns')) {
				run.globals.csv_columns = true;
			}
		} else {
			const terminated = run.str('csv_terminated');
			if (terminated === '' || terminated === '0' || terminated.toLowerCase() === 'auto') {
				this.terminated = this.crlf;
			} else {
				this.terminated = terminated.replaceAll(String.raw`\r`, '\r').replaceAll(String.raw`\n`, '\n').replaceAll(String.raw`\t`, '\t');
			}
			this.separator = run.str('csv_separator').replaceAll(String.raw`\t`, '\t');
			this.enclosed = run.str('csv_enclosed');
			this.escaped = run.str('csv_escaped');
		}
		return true;
	}

	async exportData(db: string, table: string, sqlQuery: string, aliases: ExportAliases): Promise<boolean> {
		const { run, what } = this;
		const result = await this.dbi.query(sqlQuery);
		if (run.flag('csv_columns')) {
			let header = '';
			for (const name of result.getFieldNames()) {
				const column = stripslashes(this.columnAlias(aliases, db, table, name));
				header += this.enclosed === '' ? column : this.enclosed + column.replaceAll(this.enclosed, () => this.escaped + this.enclosed) + this.enclosed;
				header += this.separator;
			}
			run.write(phpTrim([...header].slice(0, -1).join('')) + this.terminated);
		}
		const nullText = run.str(`${what}_null`);
		const removeCrlf = run.flag(`${what}_removeCRLF`);
		const fieldsMeta = result.getFieldsMeta();
		for (let row = result.fetchRow(); row !== null; row = result.fetchRow()) {
			const cells = row.map((cell, index) => {
				if (cell === null) {
					return nullText;
				}
				if (cell === '') {
					return '';
				}
				let value = rawValue(cell, fieldsMeta[index]);
				if (what === 'excel') {
					value = value.replaceAll(/\r\n?/g, '\n');
				}
				if (removeCrlf) {
					value = value.replaceAll(/[\r\n]/g, '');
				}
				return this.enclose(value);
			});
			run.write(cells.join(this.separator) + this.terminated);
		}
		return true;
	}
}

export class ExportExcel extends ExportCsv {
	protected override what = 'excel';
}

/** PHP's json_encode() with JSON_PRETTY_PRINT and JSON_UNESCAPED_UNICODE as the plugin options ask. */
function jsonEncode(value: unknown, pretty: boolean, unicode: boolean): string {
	let encoded = '';
	for (const character of JSON.stringify(value, null, pretty ? 4 : undefined)) {
		const codePoint = character.codePointAt(0) as number;
		if (character === '/') {
			encoded += String.raw`\/`;
		} else if (codePoint < 0x80 || (unicode && codePoint !== 0x20_28 && codePoint !== 0x20_29)) {
			encoded += character;
		} else if (codePoint < 0x1_00_00) {
			encoded += String.raw`\u${codePoint.toString(16).padStart(4, '0')}`;
		} else {
			const offset = codePoint - 0x1_00_00;
			encoded += String.raw`\u${(0xD8_00 + Math.floor(offset / 0x4_00)).toString(16)}\u${(0xDC_00 + (offset % 0x4_00)).toString(16)}`;
		}
	}
	return encoded;
}

// PHP arrays with keys 0..n-1 in order encode as JSON lists.
function jsonValue(row: Map<string, string | null>): unknown {
	const keys = row.keys().toArray();
	if (keys.every((key, index) => key === String(index))) {
		return row.values().toArray();
	}
	return Object.fromEntries(row);
}

export class ExportJson extends ExportPlugin {
	private first = true;

	private encode(data: unknown): string {
		return jsonEncode(data, this.run.flag('json_pretty_print'), this.run.flag('json_unicode'));
	}

	private async exportForQuery(sqlQuery: string, buffer: string, aliases: ExportAliases | null, db: string | null, table: string | null): Promise<boolean> {
		const { crlf, run } = this;
		const [header, footer] = buffer.split('"@@DATA@@"', 2);
		run.write(`${header}${crlf}[${crlf}`);
		const result = await this.dbi.query(sqlQuery);
		const fieldsMeta = result.getFieldsMeta();
		const columns = fieldsMeta.map((field) => {
			let name = field.name;
			if (db !== null && table !== null && aliases !== null) {
				name = this.columnAlias(aliases, db, table, name);
			}
			return stripslashes(name);
		});
		let count = 0;
		for (let record = result.fetchRow(); record !== null; record = result.fetchRow()) {
			count++;
			if (count > 1) {
				run.write(`,${crlf}`);
			}
			const data = new Map<string, string | null>();
			for (const [index, meta] of fieldsMeta.entries()) {
				let value = record[index];
				const binaryBlob = meta.isType(FieldType.BLOB) && meta.charsetnr === BINARY_CHARSET;
				const binaryString = meta.isType(FieldType.STRING) && meta.charsetnr === BINARY_CHARSET;
				if ((meta.isMappedTypeGeometry || binaryBlob || binaryString) && value !== null) {
					value = `0x${bin2hex(value)}`;
				}
				data.set(columns[index], value);
			}
			run.write(this.encode(jsonValue(data)));
		}
		return run.write(`${crlf}]${crlf}${footer}${crlf}`);
	}

	async exportHeader(): Promise<boolean> {
		const data = this.encode({ type: 'header', version: PMA_VERSION, comment: 'Export to JSON plugin for phpMyAdmin' });
		return this.run.write(`[${this.crlf}${data},${this.crlf}`);
	}

	override async exportFooter(): Promise<boolean> {
		return this.run.write(`]${this.crlf}`);
	}

	override async exportDBHeader(db: string, dbAlias = ''): Promise<boolean> {
		const data = this.encode({ type: 'database', name: dbAlias === '' ? db : dbAlias });
		return this.run.write(`${data},${this.crlf}`);
	}

	async exportData(db: string, table: string, sqlQuery: string, aliases: ExportAliases): Promise<boolean> {
		const [dbAlias, tableAlias] = this.initAlias(aliases, db, table);
		if (this.first) {
			this.first = false;
		} else {
			this.run.write(',');
		}
		const buffer = this.encode({ type: 'table', name: tableAlias, database: dbAlias, data: '@@DATA@@' });
		return this.exportForQuery(sqlQuery, buffer, aliases, db, table);
	}

	override async exportRawQuery(db: string | null, sqlQuery: string): Promise<boolean> {
		const buffer = this.encode({ type: 'raw', data: '@@DATA@@' });
		if (db !== null) {
			await this.dbi.selectDb(db);
		}
		return this.exportForQuery(sqlQuery, buffer, null, db, null);
	}
}

export class ExportYaml extends ExportPlugin {
	async exportHeader(): Promise<boolean> {
		this.run.write(`%YAML 1.1${this.crlf}---${this.crlf}`);
		return true;
	}

	override async exportFooter(): Promise<boolean> {
		this.run.write(`...${this.crlf}`);
		return true;
	}

	async exportData(db: string, table: string, sqlQuery: string, aliases: ExportAliases): Promise<boolean> {
		const { crlf } = this;
		const [dbAlias, tableAlias] = this.initAlias(aliases, db, table);
		const result = await this.dbi.query(sqlQuery);
		const fieldsMeta = result.getFieldsMeta();
		const columns = fieldsMeta.map(field => stripslashes(this.columnAlias(aliases, db, table, field.name)));
		let count = 0;
		for (let record = result.fetchRow(); record !== null; record = result.fetchRow()) {
			count++;
			let buffer = count === 1 ? `# ${dbAlias}.${tableAlias}${crlf}-${crlf}` : `-${crlf}`;
			for (const [index, value] of record.entries()) {
				if (value === null) {
					buffer += `  ${columns[index]}: null${crlf}`;
					continue;
				}
				if (isNumericString(value) && fieldsMeta[index].isNotType(FieldType.STRING)) {
					buffer += `  ${columns[index]}: ${value}${crlf}`;
					continue;
				}
				const escaped = rawValue(value, fieldsMeta[index]).replaceAll('\\', '\\\\').replaceAll('"', String.raw`\"`)
					.replaceAll('\n', String.raw`\n`)
					.replaceAll('\r', String.raw`\r`);
				buffer += `  ${columns[index]}: "${escaped}"${crlf}`;
			}
			this.run.write(buffer);
		}
		return true;
	}
}

/** var_export() of a string or null. */
function varExport(value: string | null): string {
	if (value === null) {
		return 'NULL';
	}
	const quoted = `'${value.replaceAll('\\', '\\\\').replaceAll('\'', String.raw`\'`)}'`;
	return quoted.replaceAll('\0', String.raw`' . "\0" . '`);
}

export class ExportPhparray extends ExportPlugin {
	private commentString(value: string): string {
		return value.replaceAll('*', '-');
	}

	async exportHeader(): Promise<boolean> {
		const { crlf } = this;
		this.run.write(`<?php${crlf}/**${crlf} * Export to PHP Array plugin for phpMyAdmin${crlf} * @version ${PMA_VERSION}${crlf} */${crlf}${crlf}`);
		return true;
	}

	override async exportDBHeader(db: string, dbAlias = ''): Promise<boolean> {
		const { crlf } = this;
		this.run.write(`/**${crlf} * Database ${this.commentString(backquote(dbAlias === '' ? db : dbAlias))}${crlf} */${crlf}`);
		return true;
	}

	async exportData(db: string, table: string, sqlQuery: string, aliases: ExportAliases): Promise<boolean> {
		const { crlf } = this;
		const [dbAlias, tableAlias] = this.initAlias(aliases, db, table);
		const result = await this.dbi.query(sqlQuery);
		const columns = result.getFieldNames().map(name => stripslashes(this.columnAlias(aliases, db, table, name)));
		const fieldsMeta = result.getFieldsMeta();
		let tableFixed = table;
		// PHP's \x7f-\xff byte ranges cover every multibyte UTF-8 character.
		if (!/^[a-z_\u{7F}-\u{FFFF}][\w\u{7F}-\u{FFFF}]*$/iu.test(tableAlias)) {
			tableFixed = tableAlias.replaceAll(/[^\w\u{7F}-\u{FFFF}]/gu, '_');
			if (!/^[a-z_\u{7F}-\u{FFFF}]/iu.test(tableFixed)) {
				tableFixed = `_${tableFixed}`;
			}
		}
		this.run.write(`${crlf}/* ${this.commentString(backquote(dbAlias))}.${this.commentString(backquote(tableAlias))} */${crlf}$${tableFixed} = array(`);
		let count = 0;
		for (let record = result.fetchRow(); record !== null; record = result.fetchRow()) {
			count++;
			let buffer = count === 1 ? `${crlf}  array(` : `,${crlf}  array(`;
			buffer += columns.map((column, index) => `${varExport(column)} => ${varExport(record[index] === null ? null : rawValue(record[index], fieldsMeta[index]))}`).join(',');
			this.run.write(`${buffer})`);
		}
		return this.run.write(`${crlf});${crlf}`);
	}
}

// htmlspecialchars() with ENT_SUBSTITUTE turns invalid UTF-8 from binary columns into U+FFFD.
function xmlValue(value: string | null, meta: FieldMetadata): string {
	if (value === null) {
		return 'NULL';
	}
	return isBinaryField(meta) ? substituteInvalid(value) : value;
}

export class ExportXml extends ExportPlugin {
	protected override readonly supportsRawQuery = false;

	private async definitions(db: string, type: string, which: 'EVENT' | 'FUNCTION' | 'PROCEDURE', names: string[]): Promise<string> {
		const { crlf } = this;
		let head = '';
		for (const name of names) {
			head += `            <pma:${type} name="${htmlspecialchars(name)}">${crlf}`;
			const sql = htmlspecialchars(((await getDefinition(this.run.context, db, which, name)) ?? '').trimEnd()).replaceAll('\n', '\n                ');
			head += `                ${sql}${crlf}            </pma:${type}>${crlf}`;
		}
		return head;
	}

	async exportHeader(): Promise<boolean> {
		const { crlf, dbi, run } = this;
		const { config, db } = run.context;
		const table = run.context.table;
		const tables = Array.isArray(run.globals.tables) ? [...run.globals.tables as string[]] : [];
		const exportStruct = ['xml_export_functions', 'xml_export_procedures', 'xml_export_tables', 'xml_export_triggers', 'xml_export_views'].some(name => run.has(name));
		const exportData = run.has('xml_export_contents');
		let head = `<?xml version="1.0" encoding="utf-8"?>${crlf}<!--${crlf}- phpMyAdmin XML Dump${crlf}- version ${PMA_VERSION}${crlf}- https://www.phpmyadmin.net${crlf}-${crlf}- Host: ${htmlspecialchars(config.Server.host)}`;
		if (config.Server.port !== '' && config.Server.port !== '0') {
			head += `:${config.Server.port}`;
		}
		head += `${crlf}- Generation Time: ${localisedDate()}${crlf}- Server version: ${dbi.getVersionString()}${crlf}- PHP Version: ${PHP_VERSION}${crlf}-->${crlf}${crlf}`;
		head += `<pma_xml_export version="1.0"${exportStruct ? ' xmlns:pma="https://www.phpmyadmin.net/some_doc_url/"' : ''}>${crlf}`;
		if (exportStruct) {
			const schema = await dbi.fetchResult(`SELECT \`DEFAULT_CHARACTER_SET_NAME\`, \`DEFAULT_COLLATION_NAME\` FROM \`information_schema\`.\`SCHEMATA\` WHERE \`SCHEMA_NAME\` = '${dbi.escapeString(db)}' LIMIT 1`);
			const row: DbiRow = schema[0] ?? {};
			head += `    <!--${crlf}    - Structure schemas${crlf}    -->${crlf}    <pma:structure_schemas>${crlf}`;
			head += `        <pma:database name="${htmlspecialchars(db)}" collation="${htmlspecialchars(row.DEFAULT_COLLATION_NAME)}" charset="${htmlspecialchars(row.DEFAULT_CHARACTER_SET_NAME)}">${crlf}`;
			if (tables.length === 0) {
				tables.push(table);
			}
			for (const name of tables) {
				const created = await dbi.tryQuery(`SHOW CREATE TABLE ${backquote(db)}.${backquote(name)}`);
				const createRow = created === false ? null : created.fetchRow();
				if (createRow === null) {
					continue;
				}
				const isView = await Table.get(run.context, name, db).isView();
				const type = isView ? 'view' : 'table';
				if ((isView && !run.has('xml_export_views')) || (!isView && !run.has('xml_export_tables'))) {
					continue;
				}
				head += `            <pma:${type} name="${htmlspecialchars(name)}">${crlf}`;
				head += `${`                ${htmlspecialchars(createRow[1])}`.replaceAll('\n', '\n                ')};${crlf}`;
				head += `            </pma:${type}>${crlf}`;
				if (!run.flag('xml_export_triggers')) {
					continue;
				}
				for (const trigger of await getTriggers(run.context, db, name)) {
					head += `            <pma:trigger name="${htmlspecialchars(trigger.name)}">${crlf}`;
					const code = [...trigger.create.trimEnd()].slice(0, -3).join('');
					head += `${`                ${htmlspecialchars(code)}`.replaceAll('\n', '\n                ')}${crlf}`;
					head += `            </pma:trigger>${crlf}`;
				}
			}
			if (run.flag('xml_export_functions')) {
				head += await this.definitions(db, 'function', 'FUNCTION', await getProceduresOrFunctions(run.context, db, 'FUNCTION'));
			}
			if (run.flag('xml_export_procedures')) {
				head += await this.definitions(db, 'procedure', 'PROCEDURE', await getProceduresOrFunctions(run.context, db, 'PROCEDURE'));
			}
			if (run.flag('xml_export_events')) {
				const events = await dbi.fetchResult<string>(`SELECT EVENT_NAME FROM information_schema.EVENTS WHERE EVENT_SCHEMA='${dbi.escapeString(db)}'`, null, 0);
				head += await this.definitions(db, 'event', 'EVENT', events.map(String));
			}
			head += `        </pma:database>${crlf}    </pma:structure_schemas>${crlf}`;
			if (exportData) {
				head += crlf;
			}
		}
		return run.write(head);
	}

	override async exportFooter(): Promise<boolean> {
		return this.run.write('</pma_xml_export>');
	}

	override async exportDBHeader(db: string, dbAlias = ''): Promise<boolean> {
		const { crlf } = this;
		if (this.run.flag('xml_export_contents')) {
			const alias = htmlspecialchars(dbAlias === '' ? db : dbAlias);
			return this.run.write(`    <!--${crlf}    - Database: '${alias}'${crlf}    -->${crlf}    <database name="${alias}">${crlf}`);
		}
		return true;
	}

	override async exportDBFooter(): Promise<boolean> {
		if (this.run.flag('xml_export_contents')) {
			return this.run.write(`    </database>${this.crlf}`);
		}
		return true;
	}

	async exportData(db: string, table: string, sqlQuery: string, aliases: ExportAliases): Promise<boolean> {
		const { crlf } = this;
		if (await Table.get(this.run.context, table, db).isMerge()) {
			return true;
		}
		const [, tableAlias] = this.initAlias(aliases, db, table);
		if (!this.run.flag('xml_export_contents')) {
			return true;
		}
		const result = await this.dbi.query(sqlQuery);
		const columns = result.getFieldNames().map(name => stripslashes(name));
		const fieldsMeta = result.getFieldsMeta();
		this.run.write(`        <!-- Table ${htmlspecialchars(tableAlias)} -->${crlf}`);
		for (let record = result.fetchRow(); record !== null; record = result.fetchRow()) {
			let buffer = `        <table name="${htmlspecialchars(tableAlias)}">${crlf}`;
			for (const [index, column] of columns.entries()) {
				const name = this.columnAlias(aliases, db, table, column);
				buffer += `            <column name="${htmlspecialchars(name)}">${htmlspecialchars(xmlValue(record[index], fieldsMeta[index]))}</column>${crlf}`;
			}
			this.run.write(`${buffer}        </table>${crlf}`);
		}
		return true;
	}
}

// Ports of the document-style export plugins: MediaWiki, Texy! text, LaTeX, Word 2000, CodeGen and the OpenDocument formats.
import {
	type ExportAliases,
	ExportPlugin,
	PhpError,
	type StructureOptions,
	getTriggers,
	isBinaryField,
	stripslashes,
} from './engine.ts';
import { PHP_VERSION } from './sql.ts';
import { bytesToString, escapeBinary, substituteInvalid } from '../../../../lib/pma/export-import/bytes.ts';
import { createZip } from '../../../../lib/pma/export-import/compress.ts';
import { expandUserString } from '../../../../lib/pma/export-import/filename.ts';
import { mysqlStrtotime, phpDate } from '../../../../lib/pma/export-import/strtotime.ts';
import { FieldType } from '../../../../lib/pma/field-metadata.ts';
import { PMA_VERSION } from '../../../../lib/pma/header.ts';
import { sprintf } from '../../../../lib/pma/sprintf.ts';
import { bin2hex } from '../../../../lib/pma/sql/results.ts';
import { extractColumnSpec } from '../../../../lib/pma/table-structure/column-spec.ts';
import { localisedDate } from '../../../../lib/pma/util.ts';
import { htmlspecialchars } from '../../../../lib/twig/php.ts';
import { backquote } from '../../../../lib/twig/sanitize.ts';

import type { FieldMetadata } from '../../../../lib/pma/field-metadata.ts';
import type { DbiRow } from '../../core/dbi.ts';

const isEmpty = (value: unknown): boolean => ([undefined, null, '', '0'] as unknown[]).includes(value);

/** $row['Default'] as the structure dumps show it: NULL for nullable columns without one. */
function columnDefault(column: DbiRow, notNullFallback: string | null = null): string | null {
	if (column.Default !== null && column.Default !== undefined) {
		return column.Default;
	}
	if (column.Null !== 'NO') {
		return 'NULL';
	}
	return notNullFallback;
}

// The Null column of a structure dump.
const nullText = (column: DbiRow): string => (column.Null === '' || column.Null === 'NO' ? 'No' : 'Yes');

// htmlspecialchars() with ENT_SUBSTITUTE for a column value, as the XML-based formats write it.
function cellText(value: string, meta: FieldMetadata): string {
	return htmlspecialchars(isBinaryField(meta) ? substituteInvalid(value) : value);
}

abstract class StructureExportPlugin extends ExportPlugin {
	/** The Column_name of every unique index part. */
	protected async uniqueKeys(db: string, table: string): Promise<string[]> {
		const keys = await this.dbi.getTableIndexes(db, table);
		return keys.filter(key => Number(key.Non_unique) === 0).map(key => String(key.Column_name));
	}

	async exportHeader(): Promise<boolean> {
		return true;
	}
}

// A value written raw, keeping the bytes of binary columns.
function rawCell(value: string, meta: FieldMetadata): string {
	return isBinaryField(meta) ? escapeBinary(value) : value;
}

export class ExportMediawiki extends StructureExportPlugin {
	private comment(text = ''): string {
		return `\n<!--\n${htmlspecialchars(text)}\n-->\n\n`;
	}

	override async exportStructure(db: string, table: string, exportMode: string, _exportType: string, _options: StructureOptions, aliases: ExportAliases): Promise<boolean> {
		const [, tableAlias] = this.initAlias(aliases, db, table);
		let output = '';
		if (exportMode === 'create_table') {
			const columnMap = await this.dbi.getColumns(db, table);
			const columns = columnMap.values().toArray();
			output = this.comment(`Table structure for ${backquote(tableAlias)}`);
			output += '{| class="wikitable" style="text-align:center;"\n';
			if (this.run.has('mediawiki_caption')) {
				output += `|+'''${tableAlias}'''\n`;
			}
			if (this.run.has('mediawiki_headers')) {
				output += '|- style="background:#ffdead;"\n! style="background:#ffffff" | \n';
				for (const column of columns) {
					output += ` | ${this.columnAlias(aliases, db, table, String(column.Field))}\n`;
				}
			}
			for (const [label, key] of [['Type', 'Type'], ['Null', 'Null'], ['Default', 'Default'], ['Extra', 'Extra']]) {
				output += `|-\n! ${label}\n`;
				for (const column of columns) {
					output += ` | ${column[key] ?? ''}\n`;
				}
			}
			output += '|}\n\n';
		}
		return this.run.write(output);
	}

	async exportData(db: string, table: string, sqlQuery: string, aliases: ExportAliases): Promise<boolean> {
		const [, tableAlias] = this.initAlias(aliases, db, table);
		let output = this.comment(tableAlias === '' ? 'Query results' : `Table data for ${backquote(tableAlias)}`);
		output += '{| class="wikitable sortable" style="text-align:center;"\n';
		if (this.run.has('mediawiki_caption')) {
			output += `|+'''${tableAlias}'''\n`;
		}
		if (this.run.has('mediawiki_headers')) {
			const names = await this.dbi.getColumnNames(db, table);
			if (names.length > 0) {
				output += '|-\n';
				for (const name of names) {
					output += ` ! ${this.columnAlias(aliases, db, table, name)}\n`;
				}
			}
		}
		const result = await this.dbi.query(sqlQuery);
		const fieldsMeta = result.getFieldsMeta();
		for (let row = result.fetchRow(); row !== null; row = result.fetchRow()) {
			output += '|-\n';
			for (const [index, value] of row.entries()) {
				output += ` | ${value === null ? '' : rawCell(value, fieldsMeta[index])}\n`;
			}
		}
		return this.run.write(`${output}|}\n\n`);
	}
}

export class ExportTexytext extends StructureExportPlugin {
	private formatColumn(column: DbiRow, uniqueKeys: string[], alias: string): string {
		const name = isEmpty(alias) ? String(column.Field) : alias;
		let type = extractColumnSpec(String(column.Type)).print_type;
		if (isEmpty(type)) {
			type = '&nbsp;';
		}
		let pre = '';
		let post = '';
		if (uniqueKeys.includes(String(column.Field))) {
			pre = `**${pre}`;
			post += '**';
		}
		if (column.Key === 'PRI') {
			pre = `//${pre}`;
			post += '//';
		}
		return `|${pre}${htmlspecialchars(name)}${post}|${htmlspecialchars(type)}|${nullText(column)}|${htmlspecialchars(columnDefault(column) ?? '')}`;
	}

	private async tableDef(db: string, table: string, aliases: ExportAliases): Promise<string> {
		const uniqueKeys = await this.uniqueKeys(db, table);
		await this.dbi.selectDb(db);
		let text = '|------\n|Column|Type|Null|Default\n|------\n';
		const columnMap = await this.dbi.getColumns(db, table);
		for (const column of columnMap.values()) {
			text += `${this.formatColumn(column, uniqueKeys, this.columnAlias(aliases, db, table, String(column.Field)))}\n`;
		}
		return text;
	}

	override async exportDBHeader(db: string, dbAlias = ''): Promise<boolean> {
		return this.run.write(`===Database ${isEmpty(dbAlias) ? db : dbAlias}\n\n`);
	}

	async exportData(db: string, table: string, sqlQuery: string, aliases: ExportAliases): Promise<boolean> {
		const [, tableAlias] = this.initAlias(aliases, db, table);
		this.run.write(tableAlias === '' ? '==Dumping data for query result\n\n' : `== Dumping data for table ${tableAlias}\n\n`);
		const result = await this.dbi.query(sqlQuery);
		const fieldsMeta = result.getFieldsMeta();
		if (this.run.has('texytext_columns')) {
			let text = '|------\n';
			for (const name of result.getFieldNames()) {
				text += `|${htmlspecialchars(stripslashes(this.columnAlias(aliases, db, table, name)))}`;
			}
			this.run.write(`${text}\n|------\n`);
		}
		const nullValue = this.run.str('texytext_null');
		for (let row = result.fetchRow(); row !== null; row = result.fetchRow()) {
			let text = '';
			for (const [index, cell] of row.entries()) {
				let value = ' ';
				if (cell === null) {
					value = nullValue;
				} else if (cell !== '') {
					value = cellText(cell, fieldsMeta[index]);
					text += `|${value.replaceAll('|', '&#124;')}`;
					continue;
				}
				text += `|${htmlspecialchars(value).replaceAll('|', '&#124;')}`;
			}
			this.run.write(`${text}\n`);
		}
		return true;
	}

	override async exportStructure(db: string, table: string, exportMode: string, _exportType: string, _options: StructureOptions, aliases: ExportAliases): Promise<boolean> {
		const [, tableAlias] = this.initAlias(aliases, db, table);
		let dump = '';
		if (exportMode === 'create_table') {
			dump += `== Table structure for table ${tableAlias}\n\n${await this.tableDef(db, table, aliases)}`;
		} else if (exportMode === 'triggers') {
			const triggers = await getTriggers(this.run.context, db, table);
			if (triggers.length > 0) {
				dump += `== Triggers ${tableAlias}\n\n|------\n|Name|Time|Event|Definition\n|------\n`;
				for (const trigger of triggers) {
					dump += `|${trigger.name}|${trigger.actionTiming}|${trigger.event}|${htmlspecialchars(trigger.definition).replaceAll('|', '&#124;')}\n`;
				}
			}
		} else if (exportMode === 'create_view') {
			dump += `== Structure for view ${tableAlias}\n\n${await this.tableDef(db, table, aliases)}`;
		} else {
			dump += `== Stand-in structure for view ${table}\n\n${await this.tableDef(db, table, aliases)}`;
		}
		return this.run.write(dump);
	}
}

/** ExportLatex::texEscape(). */
export function texEscape(value: string): string {
	let escaped = value;
	for (const character of ['$', '%', '{', '}', '&', '#', '_', '^']) {
		escaped = escaped.replaceAll(character, () => `\\${character}`);
	}
	return escaped;
}

export class ExportLatex extends ExportPlugin {
	private expand(template: string, db: string, table: string, escape?: (value: string) => string): string {
		const { context } = this.run;
		return expandUserString(template, {
			httpHost: context.httpHost,
			serverName: context.config.Server.host,
			serverVerbose: context.config.Server.verbose,
			database: db,
			table,
		}, new Date(), escape);
	}

	async exportHeader(): Promise<boolean> {
		const { crlf } = this;
		const { config } = this.run.context;
		let head = `% phpMyAdmin LaTeX Dump${crlf}% version ${PMA_VERSION}${crlf}% https://www.phpmyadmin.net/${crlf}%${crlf}% Host: ${config.Server.host}`;
		if (!isEmpty(config.Server.port)) {
			head += `:${config.Server.port}`;
		}
		head += `${crlf}% Generation Time: ${localisedDate()}${crlf}% Server version: ${this.dbi.getVersionString()}${crlf}% PHP Version: ${PHP_VERSION}${crlf}`;
		return this.run.write(head);
	}

	override async exportDBHeader(db: string, dbAlias = ''): Promise<boolean> {
		const { crlf } = this;
		return this.run.write(`% ${crlf}% Database: '${isEmpty(dbAlias) ? db : dbAlias}'${crlf}% ${crlf}`);
	}

	async exportData(db: string, table: string, sqlQuery: string, aliases: ExportAliases): Promise<boolean> {
		const { crlf, run } = this;
		const [dbAlias, tableAlias] = this.initAlias(aliases, db, table);
		const result = await this.dbi.tryQuery(sqlQuery);
		// Upstream calls numFields() on the false a failed query returns.
		if (result === false) {
			throw new PhpError('Error');
		}
		const columns = result.getFieldNames();
		const fieldsMeta = result.getFieldsMeta();
		const columnAliases = columns.map(name => this.columnAlias(aliases, db, table, name));
		let buffer = `${crlf}%${crlf}% Data: ${tableAlias}${crlf}%${crlf}${String.raw` \begin{longtable}{|`}${'l|'.repeat(columns.length)}} ${crlf}`;
		buffer += `${String.raw` \hline \endhead \hline \endfoot \hline `}${crlf}`;
		if (run.has('latex_caption')) {
			buffer += String.raw` \caption{${this.expand(run.str('latex_data_caption'), dbAlias, tableAlias, texEscape)}} \label{${this.expand(run.str('latex_data_label'), dbAlias, tableAlias)}} \\`;
		}
		run.write(buffer);
		if (run.has('latex_columns')) {
			let header = String.raw`\hline `;
			for (const name of columnAliases) {
				header += String.raw`\multicolumn{1}{|c|}{\textbf{${texEscape(stripslashes(name))}}} & `;
			}
			header = `${[...header].slice(0, -2).join('')}${String.raw`\\ \hline \hline `}`;
			run.write(`${header}${String.raw` \endfirsthead `}${crlf}`);
			if (run.has('latex_caption')) {
				run.write(String.raw`\caption{${this.expand(run.str('latex_data_continued_caption'), dbAlias, tableAlias, texEscape)}} \\ `);
			}
			run.write(`${header}${String.raw`\endhead \endfoot`}${crlf}`);
		} else {
			run.write(String.raw`\\ \hline`);
		}
		for (let record = result.fetchAssoc(); record !== null; record = result.fetchAssoc()) {
			const values = columns.map((name, index) => {
				const value = record[name];
				if (value === null || value === undefined) {
					return run.str('latex_null');
				}
				return texEscape(stripslashes(isBinaryField(fieldsMeta[index]) ? escapeBinary(value) : value));
			});
			run.write(`${values.join(' & ')}${String.raw` \\ \hline `}${crlf}`);
		}
		return run.write(`${String.raw` \end{longtable}`}${crlf}`);
	}

	override async exportStructure(db: string, table: string, exportMode: string, _exportType: string, options: StructureOptions, aliases: ExportAliases): Promise<boolean> {
		const { crlf, run } = this;
		const [dbAlias, tableAlias] = this.initAlias(aliases, db, table);
		if (exportMode === 'triggers') {
			return true;
		}
		const keys = await this.dbi.getTableIndexes(db, table);
		const uniqueKeys = new Set(keys.filter(key => Number(key.Non_unique) === 0).map(key => String(key.Column_name)));
		await this.dbi.selectDb(db);
		run.write(`${crlf}%${crlf}% Structure: ${tableAlias}${crlf}%${crlf}${String.raw` \begin{longtable}{`}`);
		let buffer = `|l|c|c|c|${options.comments ? 'l|' : ''}} ${crlf}`;
		let header = String.raw` \hline \multicolumn{1}{|c|}{\textbf{Column}} & \multicolumn{1}{|c|}{\textbf{Type}} & \multicolumn{1}{|c|}{\textbf{Null}} & \multicolumn{1}{|c|}{\textbf{Default}}`;
		if (options.comments) {
			header += String.raw` & \multicolumn{1}{|c|}{\textbf{Comments}}`;
		}
		if (run.has('latex_caption')) {
			buffer += `${String.raw` \caption{${this.expand(run.str('latex_structure_caption'), dbAlias, tableAlias, texEscape)}} \label{${this.expand(run.str('latex_structure_label'), dbAlias, tableAlias)}} \\`}${crlf}`;
		}
		buffer += `${header}${String.raw` \\ \hline \hline`}${crlf}${String.raw`\endfirsthead`}${crlf}`;
		if (run.has('latex_caption')) {
			buffer += `${String.raw` \caption{${this.expand(run.str('latex_structure_continued_caption'), dbAlias, tableAlias, texEscape)}} \\ `}${crlf}`;
		}
		buffer += `${header}${String.raw` \\ \hline \hline \endhead \endfoot `}${crlf}`;
		run.write(buffer);
		const columnMap = await this.dbi.getColumns(db, table);
		for (const row of columnMap.values()) {
			let type = extractColumnSpec(String(row.Type)).print_type;
			if (isEmpty(type)) {
				type = ' ';
			}
			const fieldName = String(row.Field);
			let local = texEscape(`${this.columnAlias(aliases, db, table, fieldName)}\0${type}\0${nullText(row)}\0${columnDefault(row) ?? ''}`);
			if (row.Key === 'PRI') {
				const position = Math.max(0, local.indexOf('\0'));
				local = String.raw`\textit{${local.slice(0, position)}}${local.slice(position)}`;
			}
			if (uniqueKeys.has(fieldName)) {
				const position = Math.max(0, local.indexOf('\0'));
				local = String.raw`\textbf{${local.slice(0, position)}}${local.slice(position)}`;
			}
			run.write(`${local.replaceAll('\0', ' & ')}${String.raw` \\ \hline `}${crlf}`);
		}
		return run.write(`${String.raw` \end{longtable}`}${crlf}`);
	}
}

export class ExportHtmlword extends StructureExportPlugin {
	private static readonly HEADER = '<table width="100%" cellspacing="1"><tr class="print-category"><th class="print">Column</th><td class="print"><strong>Type</strong></td>'
		+ '<td class="print"><strong>Null</strong></td><td class="print"><strong>Default</strong></td>';

	protected override readonly supportsRawQuery = false;
	private async tableDef(db: string, table: string, aliases: ExportAliases): Promise<string> {
		await this.dbi.selectDb(db);
		let html = `${ExportHtmlword.HEADER}</tr>`;
		const columns = await this.dbi.getColumns(db, table);
		const uniqueKeys = await this.uniqueKeys(db, table);
		for (const column of columns.values()) {
			html += `${this.formatColumn(column, uniqueKeys, this.columnAlias(aliases, db, table, String(column.Field)))}</tr>`;
		}
		return `${html}</table>`;
	}

	private formatColumn(column: DbiRow, uniqueKeys: string[], alias: string): string {
		const name = isEmpty(alias) ? String(column.Field) : alias;
		let type = htmlspecialchars(extractColumnSpec(String(column.Type)).print_type);
		if (isEmpty(type)) {
			type = '&nbsp;';
		}
		let pre = '';
		let post = '';
		if (uniqueKeys.includes(String(column.Field))) {
			pre = `<strong>${pre}`;
			post += '</strong>';
		}
		if (column.Key === 'PRI') {
			pre = `<em>${pre}`;
			post += '</em>';
		}
		return `<tr class="print-category"><td class="print">${pre}${htmlspecialchars(name)}${post}</td><td class="print">${htmlspecialchars(type)}</td>`
			+ `<td class="print">${nullText(column)}</td><td class="print">${htmlspecialchars(columnDefault(column) ?? '')}</td>`;
	}

	private async standIn(db: string, view: string, aliases: ExportAliases): Promise<string> {
		let html = `${ExportHtmlword.HEADER}</tr>`;
		const uniqueKeys = await this.uniqueKeys(db, view);
		const columnMap = await this.dbi.getColumns(db, view);
		for (const column of columnMap.values()) {
			html += `${this.formatColumn(column, uniqueKeys, this.columnAlias(aliases, db, view, String(column.Field)))}</tr>`;
		}
		return `${html}</table>`;
	}

	override async exportHeader(): Promise<boolean> {
		// eslint-disable-next-line unicorn/text-encoding-identifier-case -- the export form posts this exact charset name.
		const charset = this.run.has('charset') ? this.run.str('charset') : 'utf-8';
		/* eslint-disable unicorn/prefer-https -- the document type URL is part of the exported file, byte for byte. */
		return this.run.write(`<html xmlns:o="urn:schemas-microsoft-com:office:office"
            xmlns:x="urn:schemas-microsoft-com:office:word"
            xmlns="http://www.w3.org/TR/REC-html40">

            <!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
            <html>
            <head>
                <meta http-equiv="Content-type" content="text/html;charset=${charset}" />
            </head>
            <body>`);
		/* eslint-enable unicorn/prefer-https */
	}

	override async exportFooter(): Promise<boolean> {
		return this.run.write('</body></html>');
	}

	override async exportDBHeader(db: string, dbAlias = ''): Promise<boolean> {
		return this.run.write(`<h1>Database ${htmlspecialchars(isEmpty(dbAlias) ? db : dbAlias)}</h1>`);
	}

	async exportData(db: string, table: string, sqlQuery: string, aliases: ExportAliases): Promise<boolean> {
		const { run } = this;
		const [, tableAlias] = this.initAlias(aliases, db, table);
		run.write(`<h2>Dumping data for table ${htmlspecialchars(tableAlias)}</h2>`);
		run.write('<table width="100%" cellspacing="1">');
		const result = await this.dbi.query(sqlQuery);
		const fieldsMeta = result.getFieldsMeta();
		if (run.has('htmlword_columns')) {
			let header = '<tr class="print-category">';
			for (const name of result.getFieldNames()) {
				header += `<td class="print"><strong>${htmlspecialchars(stripslashes(this.columnAlias(aliases, db, table, name)))}</strong></td>`;
			}
			run.write(`${header}</tr>`);
		}
		const nullValue = run.str('htmlword_null');
		for (let row = result.fetchRow(); row !== null; row = result.fetchRow()) {
			let line = '<tr class="print-category">';
			for (const [index, cell] of row.entries()) {
				let value: string;
				if (cell === null) {
					value = htmlspecialchars(nullValue);
				} else {
					value = cellText(cell, fieldsMeta[index]);
				}
				line += `<td class="print">${value}</td>`;
			}
			run.write(`${line}</tr>`);
		}
		return run.write('</table>');
	}

	override async exportStructure(db: string, table: string, exportMode: string, _exportType: string, _options: StructureOptions, aliases: ExportAliases): Promise<boolean> {
		const [, tableAlias] = this.initAlias(aliases, db, table);
		const name = htmlspecialchars(tableAlias);
		let dump = '';
		if (exportMode === 'create_table') {
			dump += `<h2>Table structure for table ${name}</h2>${await this.tableDef(db, table, aliases)}`;
		} else if (exportMode === 'triggers') {
			const triggers = await getTriggers(this.run.context, db, table);
			if (triggers.length > 0) {
				dump += `<h2>Triggers ${name}</h2><table width="100%" cellspacing="1"><tr class="print-category"><th class="print">Name</th><td class="print"><strong>Time</strong></td><td class="print"><strong>Event</strong></td><td class="print"><strong>Definition</strong></td></tr>`;
				for (const trigger of triggers) {
					dump += `<tr class="print-category"><td class="print">${htmlspecialchars(trigger.name)}</td><td class="print">${htmlspecialchars(trigger.actionTiming)}</td>`
						+ `<td class="print">${htmlspecialchars(trigger.event)}</td><td class="print">${htmlspecialchars(trigger.definition)}</td></tr>`;
				}
				dump += '</table>';
			}
		} else if (exportMode === 'create_view') {
			dump += `<h2>Structure for view ${name}</h2>${await this.tableDef(db, table, aliases)}`;
		} else {
			dump += `<h2>Stand-in structure for view ${name}</h2>${await this.standIn(db, table, aliases)}`;
		}
		return this.run.write(dump);
	}
}

/** ExportCodegen::cgMakeIdentifier(). */
export function cgMakeIdentifier(value: string, ucfirst = true): string {
	let identifier = value.replaceAll(/[^\p{L}\p{Nl}_]/gu, '');
	if (!/^\p{L}/u.test(identifier)) {
		identifier = `_${identifier}`;
	}
	if (ucfirst && /^[a-z]/.test(identifier)) {
		identifier = identifier[0].toUpperCase() + identifier.slice(1);
	}
	return identifier;
}

/** Plugins\Export\Helpers\TableProperty: one DESC row. */
class TableProperty {
	readonly name: string;
	readonly type: string;
	readonly nullable: string;
	readonly key: string;

	constructor(row: (string | null)[]) {
		const trim = (value: string | null | undefined): string => (value ?? '').replaceAll(/^[ \t\n\r\0\v]+|[ \t\n\r\0\v]+$/g, '');
		this.name = trim(row[0]);
		this.type = trim(row[1]);
		this.nullable = trim(row[2]);
		this.key = trim(row[3]);
	}

	private typeName(names: [string, string, string, string, string, string, string, string, string]): string {
		const prefixes = ['int', 'longtext', 'long', 'char', 'varchar', 'text', 'tinyint', 'datetime'];
		const index = prefixes.findIndex(prefix => this.type.startsWith(prefix));
		return index === -1 ? names[8] : names[index];
	}

	private format(text: string): string {
		const parenthesis = this.type.indexOf('(');
		return text
			.replaceAll('#ucfirstName#', () => cgMakeIdentifier(this.name))
			.replaceAll('#dotNetPrimitiveType#', () => this.typeName(['int', 'string', 'long', 'string', 'string', 'string', 'bool', 'DateTime', 'unknown']))
			.replaceAll('#dotNetObjectType#', () => this.typeName(['Int32', 'String', 'Long', 'String', 'String', 'String', 'Boolean', 'DateTime', 'Unknown']))
			.replaceAll('#type#', () => (parenthesis > 0 ? this.type.slice(0, parenthesis) : this.type))
			.replaceAll('#notNull#', () => (this.nullable === 'NO' ? 'true' : 'false'))
			.replaceAll('#unique#', () => (this.key === 'PRI' || this.key === 'UNI' ? 'true' : 'false'));
	}

	isPK(): boolean {
		return this.key === 'PRI';
	}

	formatCs(text: string): string {
		return this.format(text.replaceAll('#name#', () => cgMakeIdentifier(this.name, false)));
	}

	formatXml(text: string): string {
		const name = htmlspecialchars(this.name).replaceAll('&#039;', '\'');
		const indexName = this.key === '' ? '' : `index="${name}"`;
		return this.format(text.replaceAll('#name#', () => name).replaceAll('#indexName#', () => indexName));
	}
}

export class ExportCodegen extends StructureExportPlugin {
	protected override readonly supportsRawQuery = false;

	private async properties(db: string, table: string, aliases: ExportAliases): Promise<TableProperty[]> {
		const result = await this.dbi.query(`DESC ${backquote(db)}.${backquote(table)}`);
		const properties: TableProperty[] = [];
		for (let row = result.fetchRow(); row !== null; row = result.fetchRow()) {
			const alias = this.getAlias(aliases, String(row[0]), 'col', db, table);
			if (!isEmpty(alias)) {
				row[0] = alias;
			}
			properties.push(new TableProperty(row));
		}
		return properties;
	}

	async exportData(db: string, table: string, _sqlQuery: string, aliases: ExportAliases): Promise<boolean> {
		const format = Number.parseInt(this.run.str('codegen_format'), 10) || 0;
		const [dbAlias, tableAlias] = this.initAlias(aliases, db, table);
		if (format === 0) {
			const properties = await this.properties(db, table, aliases);
			const className = cgMakeIdentifier(tableAlias);
			const lines = ['using System;', 'using System.Collections;', 'using System.Collections.Generic;', 'using System.Text;', `namespace ${cgMakeIdentifier(dbAlias)}`, '{', `    #region ${className}`, `    public class ${className}`, '    {', '        #region Member Variables'];
			for (const property of properties) {
				lines.push(property.formatCs('        protected #dotNetPrimitiveType# _#name#;'));
			}
			lines.push('        #endregion', '        #region Constructors', `        public ${className}() { }`);
			const others = properties.filter(property => !property.isPK());
			lines.push(`        public ${className}(${others.map(property => property.formatCs('#dotNetPrimitiveType# #name#')).join(', ')})`, '        {');
			for (const property of others) {
				lines.push(property.formatCs('            this._#name#=#name#;'));
			}
			lines.push('        }', '        #endregion', '        #region Public Properties');
			for (const property of properties) {
				lines.push(property.formatCs('        public virtual #dotNetPrimitiveType# #ucfirstName#\n        {\n            get {return _#name#;}\n            set {_#name#=value;}\n        }'));
			}
			lines.push('        #endregion', '    }', '    #endregion', '}');
			return this.run.write(lines.join(this.crlf));
		}
		if (format === 1) {
			const lines = [
				'<?xml version="1.0" encoding="utf-8" ?>',
				`<hibernate-mapping xmlns="urn:nhibernate-mapping-2.2" namespace="${cgMakeIdentifier(dbAlias)}" assembly="${cgMakeIdentifier(dbAlias)}">`,
				`    <class name="${cgMakeIdentifier(tableAlias)}" table="${cgMakeIdentifier(tableAlias)}">`,
			];
			for (const property of await this.properties(db, table, aliases)) {
				if (property.isPK()) {
					lines.push(property.formatXml('        <id name="#ucfirstName#" type="#dotNetObjectType#" unsaved-value="0">\n            <column name="#name#" sql-type="#type#" not-null="#notNull#" unique="#unique#" index="PRIMARY"/>\n            <generator class="native" />\n        </id>'));
				} else {
					lines.push(property.formatXml('        <property name="#ucfirstName#" type="#dotNetObjectType#">\n            <column name="#name#" sql-type="#type#" not-null="#notNull#" #indexName#/>\n        </property>'));
				}
			}
			lines.push('    </class>', '</hibernate-mapping>');
			return this.run.write(lines.join(this.crlf));
		}
		return this.run.write(sprintf('%s is not supported.', format));
	}
}

/** OpenDocument::NS. */
const OPEN_DOCUMENT_NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"\nxmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"\n'
	+ 'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"\nxmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"\n'
	+ 'xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0"\nxmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"';

const OPEN_DOCUMENT_STYLES = `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${OPEN_DOCUMENT_NS} office:version="1.0"><office:font-face-decls>`
	+ '<style:font-face style:name="Arial Unicode MS" svg:font-family="\'Arial Unicode MS\'" style:font-pitch="variable"/>'
	+ '<style:font-face style:name="DejaVu Sans1" svg:font-family="\'DejaVu Sans\'" style:font-pitch="variable"/>'
	+ '<style:font-face style:name="HG Mincho Light J" svg:font-family="\'HG Mincho Light J\'" style:font-pitch="variable"/>'
	+ '<style:font-face style:name="DejaVu Serif" svg:font-family="\'DejaVu Serif\'" style:font-family-generic="roman" style:font-pitch="variable"/>'
	+ '<style:font-face style:name="Thorndale" svg:font-family="Thorndale" style:font-family-generic="roman" style:font-pitch="variable"/>'
	+ '<style:font-face style:name="DejaVu Sans" svg:font-family="\'DejaVu Sans\'" style:font-family-generic="swiss" style:font-pitch="variable"/>'
	+ '</office:font-face-decls><office:styles><style:default-style style:family="paragraph">'
	+ '<style:paragraph-properties fo:hyphenation-ladder-count="no-limit" style:text-autospace="ideograph-alpha" style:punctuation-wrap="hanging"'
	+ ' style:line-break="strict" style:tab-stop-distance="0.4925in" style:writing-mode="page"/>'
	+ '<style:text-properties style:use-window-font-color="true" style:font-name="DejaVu Serif" fo:font-size="12pt" fo:language="en"'
	+ ' fo:country="US" style:font-name-asian="DejaVu Sans1" style:font-size-asian="12pt" style:language-asian="none"'
	+ ' style:country-asian="none" style:font-name-complex="DejaVu Sans1" style:font-size-complex="12pt" style:language-complex="none"'
	+ ' style:country-complex="none" fo:hyphenate="false" fo:hyphenation-remain-char-count="2" fo:hyphenation-push-char-count="2"/>'
	+ '</style:default-style><style:style style:name="Standard" style:family="paragraph" style:class="text"/>'
	+ '<style:style style:name="Text_body" style:display-name="Text body" style:family="paragraph" style:parent-style-name="Standard" style:class="text">'
	+ '<style:paragraph-properties fo:margin-top="0in" fo:margin-bottom="0.0835in"/></style:style>'
	+ '<style:style style:name="Heading" style:family="paragraph" style:parent-style-name="Standard" style:next-style-name="Text_body" style:class="text">'
	+ '<style:paragraph-properties fo:margin-top="0.1665in" fo:margin-bottom="0.0835in" fo:keep-with-next="always"/>'
	+ '<style:text-properties style:font-name="DejaVu Sans" fo:font-size="14pt" style:font-name-asian="DejaVu Sans1" style:font-size-asian="14pt"'
	+ ' style:font-name-complex="DejaVu Sans1" style:font-size-complex="14pt"/></style:style>'
	+ '<style:style style:name="Heading_1" style:display-name="Heading 1" style:family="paragraph" style:parent-style-name="Heading"'
	+ ' style:next-style-name="Text_body" style:class="text" style:default-outline-level="1">'
	+ '<style:text-properties style:font-name="Thorndale" fo:font-size="24pt" fo:font-weight="bold" style:font-name-asian="HG Mincho Light J"'
	+ ' style:font-size-asian="24pt" style:font-weight-asian="bold" style:font-name-complex="Arial Unicode MS" style:font-size-complex="24pt"'
	+ ' style:font-weight-complex="bold"/></style:style>'
	+ '<style:style style:name="Heading_2" style:display-name="Heading 2" style:family="paragraph" style:parent-style-name="Heading"'
	+ ' style:next-style-name="Text_body" style:class="text" style:default-outline-level="2">'
	+ '<style:text-properties style:font-name="DejaVu Serif" fo:font-size="18pt" fo:font-weight="bold" style:font-name-asian="DejaVu Sans1"'
	+ ' style:font-size-asian="18pt" style:font-weight-asian="bold" style:font-name-complex="DejaVu Sans1" style:font-size-complex="18pt"'
	+ ' style:font-weight-complex="bold"/></style:style></office:styles><office:automatic-styles><style:page-layout style:name="pm1">'
	+ '<style:page-layout-properties fo:page-width="8.2673in" fo:page-height="11.6925in" style:num-format="1" style:print-orientation="portrait"'
	+ ' fo:margin-top="1in" fo:margin-bottom="1in" fo:margin-left="1.25in" fo:margin-right="1.25in" style:writing-mode="lr-tb"'
	+ ' style:footnote-max-height="0in"><style:footnote-sep style:width="0.0071in" style:distance-before-sep="0.0398in"'
	+ ' style:distance-after-sep="0.0398in" style:adjustment="left" style:rel-width="25%" style:color="#000000"/>'
	+ '</style:page-layout-properties><style:header-style/><style:footer-style/></style:page-layout></office:automatic-styles>'
	+ '<office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1"/></office:master-styles></office:document-styles>';

/** OpenDocument::create(): the zipped document, as a byte string for the export buffer. */
function openDocument(mime: string, content: string): string {
	const now = new Date();
	const created = `${now.toISOString().slice(0, 19)}+00:00`;
	const meta = '<?xml version="1.0" encoding="UTF-8"?><office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"'
		+ ' xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" office:version="1.0"><office:meta>'
		+ `<meta:generator>phpMyAdmin ${PMA_VERSION}</meta:generator><meta:initial-creator>phpMyAdmin ${PMA_VERSION}</meta:initial-creator>`
		+ `<meta:creation-date>${created}</meta:creation-date></office:meta></office:document-meta>`;
	const manifest = '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">'
		+ `<manifest:file-entry manifest:media-type="${mime}" manifest:full-path="/"/>`
		+ '<manifest:file-entry manifest:media-type="text/xml" manifest:full-path="content.xml"/>'
		+ '<manifest:file-entry manifest:media-type="text/xml" manifest:full-path="meta.xml"/>'
		+ '<manifest:file-entry manifest:media-type="text/xml" manifest:full-path="styles.xml"/></manifest:manifest>';
	const encoder = new TextEncoder();
	const files: [string, string][] = [['mimetype', mime], ['content.xml', content], ['meta.xml', meta], ['styles.xml', OPEN_DOCUMENT_STYLES], ['META-INF/manifest.xml', manifest]];
	const zip = createZip(files.map(([name, data]) => [name, encoder.encode(data)]), now);
	return escapeBinary(bytesToString(zip));
}

/** bin2hex() of a geometry value, which throws a TypeError on NULL under strict_types. */
function geometryHex(value: string | null): string {
	if (value === null) {
		throw new PhpError();
	}
	return bin2hex(value);
}

/** date($format, strtotime($value)), which throws a TypeError when strtotime() fails. */
function odsDate(format: string, value: string): string {
	const timestamp = mysqlStrtotime(value, Math.floor(Date.now() / 1000));
	if (timestamp === null) {
		throw new PhpError();
	}
	return phpDate(format, timestamp);
}

export class ExportOds extends ExportPlugin {
	private buffer = '';

	async exportHeader(): Promise<boolean> {
		this.buffer += `<?xml version="1.0" encoding="utf-8"?><office:document-content ${OPEN_DOCUMENT_NS} office:version="1.0"><office:automatic-styles>`
			+ '<number:date-style style:name="N37" number:automatic-order="true"><number:month number:style="long"/><number:text>/</number:text>'
			+ '<number:day number:style="long"/><number:text>/</number:text><number:year/></number:date-style>'
			+ '<number:time-style style:name="N43"><number:hours number:style="long"/><number:text>:</number:text><number:minutes number:style="long"/>'
			+ '<number:text>:</number:text><number:seconds number:style="long"/><number:text> </number:text><number:am-pm/></number:time-style>'
			+ '<number:date-style style:name="N50" number:automatic-order="true" number:format-source="language"><number:month/><number:text>/</number:text>'
			+ '<number:day/><number:text>/</number:text><number:year/><number:text> </number:text><number:hours number:style="long"/><number:text>:</number:text>'
			+ '<number:minutes number:style="long"/><number:text> </number:text><number:am-pm/></number:date-style>'
			+ '<style:style style:name="DateCell" style:family="table-cell" style:parent-style-name="Default" style:data-style-name="N37"/>'
			+ '<style:style style:name="TimeCell" style:family="table-cell" style:parent-style-name="Default" style:data-style-name="N43"/>'
			+ '<style:style style:name="DateTimeCell" style:family="table-cell" style:parent-style-name="Default" style:data-style-name="N50"/>'
			+ '</office:automatic-styles><office:body><office:spreadsheet>';
		return true;
	}

	override async exportFooter(): Promise<boolean> {
		this.buffer += '</office:spreadsheet></office:body></office:document-content>';
		return this.run.write(openDocument('application/vnd.oasis.opendocument.spreadsheet', this.buffer));
	}

	async exportData(db: string, table: string, sqlQuery: string, aliases: ExportAliases): Promise<boolean> {
		const [, tableAlias] = this.initAlias(aliases, db, table);
		const result = await this.dbi.query(sqlQuery);
		const fieldsMeta = result.getFieldsMeta();
		const cell = (text: string): string => `<table:table-cell office:value-type="string"><text:p>${text}</text:p></table:table-cell>`;
		this.buffer += `<table:table table:name="${htmlspecialchars(tableAlias)}">`;
		if (this.run.has('ods_columns')) {
			this.buffer += `<table:table-row>${fieldsMeta.map(field => cell(htmlspecialchars(stripslashes(this.columnAlias(aliases, db, table, field.name))))).join('')}</table:table-row>`;
		}
		for (let row = result.fetchRow(); row !== null; row = result.fetchRow()) {
			this.buffer += '<table:table-row>';
			for (const [index, meta] of fieldsMeta.entries()) {
				let value = row[index];
				if (meta.isMappedTypeGeometry) {
					value = `0x${geometryHex(value)}`;
				}
				if (value === null || value === undefined) {
					this.buffer += cell(htmlspecialchars(this.run.str('ods_null')));
				} else if (meta.isBinary && meta.isBlob) {
					this.buffer += cell('');
				} else if (meta.isType(FieldType.DATE)) {
					this.buffer += `<table:table-cell office:value-type="date" office:date-value="${odsDate('Y-m-d', value)}" table:style-name="DateCell"><text:p>${htmlspecialchars(value)}</text:p></table:table-cell>`;
				} else if (meta.isType(FieldType.TIME)) {
					const duration = odsDate(String.raw`\P\TH\Hi\Ms\S`, value);
					this.buffer += `<table:table-cell office:value-type="time" office:time-value="${duration}" table:style-name="TimeCell"><text:p>${htmlspecialchars(value)}</text:p></table:table-cell>`;
				} else if (meta.isType(FieldType.DATETIME)) {
					const dateTime = odsDate(String.raw`Y-m-d\TH:i:s`, value);
					this.buffer += `<table:table-cell office:value-type="date" office:date-value="${dateTime}" table:style-name="DateTimeCell"><text:p>${htmlspecialchars(value)}</text:p></table:table-cell>`;
				} else if (meta.isNumeric) {
					this.buffer += `<table:table-cell office:value-type="float" office:value="${value}" ><text:p>${htmlspecialchars(value)}</text:p></table:table-cell>`;
				} else {
					this.buffer += cell(cellText(value, meta));
				}
			}
			this.buffer += '</table:table-row>';
		}
		this.buffer += '</table:table>';
		return true;
	}
}

const odtCell = (text: string): string => `<table:table-cell office:value-type="string"><text:p>${text}</text:p></table:table-cell>`;
const ODT_HEADER_CELLS = ['Column', 'Type', 'Null', 'Default'].map(label => odtCell(label)).join('');

export class ExportOdt extends ExportPlugin {
	private buffer = '';

	private formatColumn(column: DbiRow, alias: string): string {
		let type = htmlspecialchars(extractColumnSpec(String(column.Type)).print_type);
		if (isEmpty(type)) {
			type = '&nbsp;';
		}
		return `<table:table-row>${odtCell(htmlspecialchars(isEmpty(alias) ? column.Field : alias))}${odtCell(htmlspecialchars(type))}${odtCell(nullText(column))}${odtCell(htmlspecialchars(columnDefault(column, '')))}`;
	}

	private async tableDef(db: string, table: string, comments: boolean, aliases: ExportAliases): Promise<void> {
		const [, tableAlias] = this.initAlias(aliases, db, table);
		await this.dbi.selectDb(db);
		this.buffer += `<table:table table:name="${htmlspecialchars(tableAlias)}_structure"><table:table-column table:number-columns-repeated="${comments ? 5 : 4}"/>`;
		this.buffer += `<table:table-row>${ODT_HEADER_CELLS}`;
		let columnComments = new Map<string, string>();
		if (comments) {
			this.buffer += odtCell('Comments');
			const full = await this.dbi.getColumns(db, table, true);
			columnComments = new Map(full.values().filter(column => !isEmpty(column.Comment)).map(column => [String(column.Field), String(column.Comment)]));
		}
		this.buffer += '</table:table-row>';
		const columnMap = await this.dbi.getColumns(db, table);
		for (const column of columnMap.values()) {
			const fieldName = String(column.Field);
			this.buffer += this.formatColumn(column, this.columnAlias(aliases, db, table, fieldName));
			if (comments) {
				this.buffer += odtCell(htmlspecialchars(columnComments.get(fieldName) ?? ''));
			}
			this.buffer += '</table:table-row>';
		}
		this.buffer += '</table:table>';
	}

	async exportHeader(): Promise<boolean> {
		this.buffer += `<?xml version="1.0" encoding="utf-8"?><office:document-content ${OPEN_DOCUMENT_NS} office:version="1.0"><office:body><office:text>`;
		return true;
	}

	override async exportFooter(): Promise<boolean> {
		this.buffer += '</office:text></office:body></office:document-content>';
		return this.run.write(openDocument('application/vnd.oasis.opendocument.text', this.buffer));
	}

	override async exportDBHeader(db: string, dbAlias = ''): Promise<boolean> {
		this.buffer += `<text:h text:outline-level="1" text:style-name="Heading_1" text:is-list-header="true">Database ${htmlspecialchars(isEmpty(dbAlias) ? db : dbAlias)}</text:h>`;
		return true;
	}

	async exportData(db: string, table: string, sqlQuery: string, aliases: ExportAliases): Promise<boolean> {
		const [, tableAlias] = this.initAlias(aliases, db, table);
		const result = await this.dbi.query(sqlQuery);
		const fieldsMeta = result.getFieldsMeta();
		this.buffer += '<text:h text:outline-level="2" text:style-name="Heading_2" text:is-list-header="true">';
		this.buffer += tableAlias === '' ? 'Dumping data for query result' : `Dumping data for table ${htmlspecialchars(tableAlias)}`;
		this.buffer += `</text:h><table:table table:name="${htmlspecialchars(tableAlias)}_structure"><table:table-column table:number-columns-repeated="${fieldsMeta.length}"/>`;
		if (this.run.has('odt_columns')) {
			this.buffer += `<table:table-row>${fieldsMeta.map(field => odtCell(htmlspecialchars(stripslashes(this.columnAlias(aliases, db, table, field.name))))).join('')}</table:table-row>`;
		}
		for (let row = result.fetchRow(); row !== null; row = result.fetchRow()) {
			this.buffer += '<table:table-row>';
			for (const [index, meta] of fieldsMeta.entries()) {
				let value = row[index];
				if (meta.isMappedTypeGeometry) {
					value = `0x${geometryHex(value)}`;
				}
				if (value === null || value === undefined) {
					this.buffer += odtCell(htmlspecialchars(this.run.str('odt_null')));
				} else if (meta.isBinary && meta.isBlob) {
					this.buffer += odtCell('');
				} else if (meta.isNumeric) {
					this.buffer += `<table:table-cell office:value-type="float" office:value="${value}" ><text:p>${htmlspecialchars(value)}</text:p></table:table-cell>`;
				} else {
					this.buffer += odtCell(cellText(value, meta));
				}
			}
			this.buffer += '</table:table-row>';
		}
		this.buffer += '</table:table>';
		return true;
	}

	override async exportStructure(db: string, table: string, exportMode: string, _exportType: string, options: StructureOptions, aliases: ExportAliases): Promise<boolean> {
		const [, tableAlias] = this.initAlias(aliases, db, table);
		const heading = (text: string): string => `<text:h text:outline-level="2" text:style-name="Heading_2" text:is-list-header="true">${text} ${htmlspecialchars(tableAlias)}</text:h>`;
		if (exportMode === 'create_table') {
			this.buffer += heading('Table structure for table');
			await this.tableDef(db, table, options.comments, aliases);
		} else if (exportMode === 'triggers') {
			const triggers = await getTriggers(this.run.context, db, table);
			if (triggers.length > 0) {
				this.buffer += heading('Triggers');
				this.buffer += `<table:table table:name="${htmlspecialchars(tableAlias)}_triggers"><table:table-column table:number-columns-repeated="4"/><table:table-row>`
					+ `${['Name', 'Time', 'Event', 'Definition'].map(label => odtCell(label)).join('')}</table:table-row>`;
				for (const trigger of await getTriggers(this.run.context, db, table)) {
					this.buffer += `<table:table-row>${[trigger.name, trigger.actionTiming, trigger.event, trigger.definition].map(text => odtCell(htmlspecialchars(text))).join('')}</table:table-row>`;
				}
				this.buffer += '</table:table>';
			}
		} else if (exportMode === 'create_view') {
			this.buffer += heading('Structure for view');
			await this.tableDef(db, table, options.comments, aliases);
		} else {
			this.buffer += heading('Stand-in structure for view');
			await this.dbi.selectDb(db);
			this.buffer += `<table:table table:name="${htmlspecialchars(tableAlias)}_data"><table:table-column table:number-columns-repeated="4"/><table:table-row>${ODT_HEADER_CELLS}</table:table-row>`;
			const columnMap = await this.dbi.getColumns(db, table);
			for (const column of columnMap.values()) {
				this.buffer += `${this.formatColumn(column, this.columnAlias(aliases, db, table, String(column.Field)))}</table:table-row>`;
			}
			this.buffer += '</table:table>';
		}
		return true;
	}
}

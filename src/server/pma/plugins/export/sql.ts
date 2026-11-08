// Port of Plugins\Export\ExportSql without the configuration storage features (relations, media types, metadata).
import {
	type ExportAliases,
	ExportPlugin,
	type StructureOptions,
	getDefinition,
	getProceduresOrFunctions,
	getTriggers,
	rawValue,
} from './engine.ts';
import { PMA_VERSION } from '../../../../lib/pma/header.ts';
import { sprintf } from '../../../../lib/pma/sprintf.ts';
import { bin2hex, getUniqueCondition, printableBitValue } from '../../../../lib/pma/sql/results.ts';
import { extractColumnSpec } from '../../../../lib/pma/table-structure/column-spec.ts';
import { localisedDate } from '../../../../lib/pma/util.ts';
import { backquote } from '../../../../lib/twig/sanitize.ts';
import {
	Context,
	CreateDefinition,
	CreateStatement,
	Parser,
	Token,
} from '../../../../sql-parser/index.ts';
import { Table } from '../../core/table.ts';

import type { FieldMetadata } from '../../../../lib/pma/field-metadata.ts';

/** PHP_VERSION of the official phpmyadmin:5.2 image the dump header reports. */
export const PHP_VERSION = '8.3.36';

/** Charsets::$mysqlCharsetMap. */
const MYSQL_CHARSET_MAP: Record<string, string> = {
	'big5': 'big5',
	'cp-866': 'cp866',
	'euc-jp': 'ujis',
	'euc-kr': 'euckr',
	'gb2312': 'gb2312',
	'gbk': 'gbk',
	'iso-8859-1': 'latin1',
	'iso-8859-2': 'latin2',
	'iso-8859-7': 'greek',
	'iso-8859-8': 'hebrew',
	'iso-8859-8-i': 'hebrew',
	'iso-8859-9': 'latin5',
	'iso-8859-13': 'latin7',
	'iso-8859-15': 'latin1',
	'koi8-r': 'koi8r',
	'shift_jis': 'sjis',
	'tis-620': 'tis620',
	// eslint-disable-next-line unicorn/text-encoding-identifier-case -- the export form posts this exact charset name.
	'utf-8': 'utf8',
	'windows-1250': 'cp1250',
	'windows-1251': 'cp1251',
	'windows-1252': 'latin1',
	'windows-1256': 'cp1256',
	'windows-1257': 'cp1257',
};

const isEmpty = (value: unknown): boolean => ([undefined, null, '', '0', false] as unknown[]).includes(value);

/** Util::backquoteCompat(). */
export function backquoteCompat(identifier: string, compatibility = 'MSSQL', doIt: boolean = true): string {
	if (identifier === '' || identifier === '*') {
		return identifier;
	}
	if (!doIt && !((Context.isKeyword(identifier) ?? 0) & Token.FLAG_KEYWORD_RESERVED)) {
		return identifier;
	}
	if (compatibility === 'MSSQL') {
		return `"${identifier.replaceAll('"', String.raw`\"`)}"`;
	}
	return `\`${identifier.replaceAll('`', '``')}\``;
}

// ExportSql::makeCreateTableMSSQLCompatible().
function makeCreateTableMssqlCompatible(createQuery: string): string {
	return createQuery
		.replace(/^CREATE TABLE IF NOT EXISTS/, 'CREATE TABLE')
		.replaceAll(/" date DEFAULT NULL(,)?\n/g, '" datetime DEFAULT NULL$1\n')
		.replaceAll(/" date NOT NULL(,)?\n/g, '" datetime NOT NULL$1\n')
		.replaceAll(/" date NOT NULL DEFAULT '([^'])/g, '" datetime NOT NULL DEFAULT \'$1')
		.replaceAll(/\) unsigned NOT NULL(,)?\n/g, ') NOT NULL$1\n')
		.replaceAll(/\) unsigned DEFAULT NULL(,)?\n/g, ') DEFAULT NULL$1\n')
		.replaceAll(/\) unsigned NOT NULL DEFAULT '([^'])/g, ') NOT NULL DEFAULT \'$1')
		.replaceAll(/" (int|tinyint|smallint|bigint)\(\d+\) DEFAULT NULL(,)?\n/g, '" $1 DEFAULT NULL$2\n')
		.replaceAll(/" (int|tinyint|smallint|bigint)\(\d+\) NOT NULL(,)?\n/g, '" $1 NOT NULL$2\n')
		.replaceAll(/" (int|tinyint|smallint|bigint)\(\d+\) NOT NULL DEFAULT '([^'])/g, '" $1 NOT NULL DEFAULT \'$2')
		.replaceAll(/" (float|double)(\(\d+,[\d,]+\))? DEFAULT NULL(,)?\n/g, '" float DEFAULT NULL$3\n')
		.replaceAll(/" (float|double)(\([\d,]\d*,[\d,]+\))? NOT NULL(,)?\n/g, '" float NOT NULL$3\n')
		.replaceAll(/" (float|double)(\([\d,]\d*,[\d,]+\))? NOT NULL DEFAULT '([^'])/g, '" float NOT NULL DEFAULT \'$3');
}

// strtotime() of a MySQL DATETIME in the image's UTC zone.
function timestamp(value: string): number {
	return Math.floor(Date.parse(`${value.replace(' ', 'T')}Z`) / 1000);
}

export class ExportSql extends ExportPlugin {
	private sentCharset = false;
	private sqlViews = '';
	private oldTimeZone = '';
	private sqlIndexes: string | null = null;
	private sqlAutoIncrements: string | null = null;
	private sqlConstraints: string | null = null;

	private get compat(): string {
		return this.run.has('sql_compatibility') ? this.run.str('sql_compatibility') : 'NONE';
	}

	private get backquotes(): boolean {
		return this.run.has('sql_backquotes');
	}

	private exportComment(text = ''): string {
		if (!this.run.flag('sql_include_comments')) {
			return '';
		}
		if (text === '' || text === '0') {
			return `--${this.crlf}`;
		}
		return text.split(/\r\n|\r|\n/).map(line => `-- ${line}${this.crlf}`).join('');
	}

	private possibleCRLF(): string {
		return this.run.flag('sql_include_comments') ? this.crlf : '';
	}

	private async isView(db: string, table: string): Promise<boolean> {
		return Table.get(this.run.context, table, db).isView();
	}

	private exportUseStatement(db: string): boolean {
		if (this.run.str('sql_compatibility') === 'NONE') {
			return this.run.write(`USE ${backquoteCompat(db, this.compat, this.backquotes)};${this.crlf}`);
		}
		return this.run.write(`USE ${db};${this.crlf}`);
	}

	private async exportRoutineSql(db: string, aliases: ExportAliases, type: 'FUNCTION' | 'PROCEDURE', name: string, routines: string[], delimiter: string): Promise<string> {
		const { crlf } = this;
		let text = this.exportComment() + this.exportComment(name) + this.exportComment();
		let usedAlias = false;
		let query = '';
		for (const routine of routines) {
			if (this.run.flag('sql_drop_table')) {
				query += `DROP ${type} IF EXISTS ${backquote(routine)}${delimiter}${crlf}`;
			}
			const definition = await getDefinition(this.run.context, db, type, routine);
			const [createQuery, flag] = this.replaceWithAliases(delimiter, definition ?? '', aliases, db);
			usedAlias ||= flag;
			query += `${createQuery}${delimiter}${crlf}${crlf}`;
		}
		if (usedAlias) {
			text += this.exportComment('It appears your database uses routines;') + this.exportComment('alias export may not work reliably in all cases.') + this.exportComment();
		}
		return text + query;
	}

	/** ExportSql::getTableDefStandIn(). */
	private async getTableDefStandIn(db: string, view: string, aliases: ExportAliases): Promise<string> {
		const { crlf } = this;
		const [, viewAlias] = this.initAlias(aliases, db, view);
		let createQuery = '';
		if (this.run.flag('sql_drop_table')) {
			createQuery += `DROP VIEW IF EXISTS ${backquote(viewAlias)};${crlf}`;
		}
		createQuery += 'CREATE TABLE ';
		if (this.run.flag('sql_if_not_exists')) {
			createQuery += 'IF NOT EXISTS ';
		}
		createQuery += `${backquote(viewAlias)} (${crlf}`;
		const columns = await this.dbi.getColumnsFull(db, view);
		const lines = [...columns].map(([name, definition]) => `${backquote(this.columnAlias(aliases, db, view, name))} ${definition.Type}${crlf}`);
		return `${createQuery}${lines.join(',')});${crlf}`;
	}

	/** ExportSql::getTableDefForView(). */
	private async getTableDefForView(db: string, view: string, aliases: ExportAliases): Promise<string> {
		const { crlf, dbi } = this;
		const [, viewAlias] = this.initAlias(aliases, db, view);
		let createQuery = 'CREATE TABLE';
		if (this.run.has('sql_if_not_exists')) {
			createQuery += ' IF NOT EXISTS ';
		}
		createQuery += `${backquote(viewAlias)}(${crlf}`;
		const columns = await dbi.getColumns(db, view, true);
		let first = true;
		for (const column of columns.values()) {
			const name = this.columnAlias(aliases, db, view, String(column.Field));
			const spec = extractColumnSpec(String(column.Type));
			if (!first) {
				createQuery += `,${crlf}`;
			}
			createQuery += `    ${backquote(name)} ${column.Type}`;
			if (spec.can_contain_collation && !isEmpty(column.Collation)) {
				createQuery += ` COLLATE ${column.Collation}`;
			}
			if (column.Null === 'NO') {
				createQuery += ' NOT NULL';
			}
			if (column.Default !== null && column.Default !== undefined) {
				createQuery += ` DEFAULT '${dbi.escapeString(column.Default)}'`;
			} else if (column.Null === 'YES') {
				createQuery += ' DEFAULT NULL';
			}
			if (!isEmpty(column.Comment)) {
				createQuery += ` COMMENT '${dbi.escapeString(String(column.Comment))}'`;
			}
			first = false;
		}
		createQuery += `${crlf});${crlf}`;
		if (this.compat === 'MSSQL') {
			createQuery = makeCreateTableMssqlCompatible(createQuery);
		}
		return createQuery;
	}

	private generateComment(statement: string | null, comment1: string, comment2: string, tableAlias: string): string {
		let text = statement ?? `${this.crlf}${this.exportComment()}${this.exportComment(comment1)}${this.exportComment()}`;
		text += `${this.crlf}${this.exportComment()}${this.exportComment(`${comment2} ${backquoteCompat(tableAlias, this.compat, this.backquotes)}`)}${this.exportComment()}`;
		return text;
	}

	/** ExportSql::getTableDef(). */
	private async getTableDef(db: string, table: string, showDates: boolean, view: boolean, aliases: ExportAliases): Promise<string> {
		const { crlf, dbi } = this;
		const [, tableAlias] = this.initAlias(aliases, db, table);
		const compat = this.compat;
		let schemaCreate = '';
		let newCrlf = crlf;
		const status = await dbi.tryQuery(`SHOW TABLE STATUS FROM ${backquote(db)} WHERE Name = '${dbi.escapeString(table)}'`);
		if (status !== false && status.numRows() > 0) {
			const row = status.fetchAssoc() ?? {};
			for (const [key, label] of [['Create_time', 'Creation:'], ['Update_time', 'Last update:'], ['Check_time', 'Last check:']]) {
				const value = row[key];
				if (showDates && value !== null && value !== undefined && !isEmpty(value)) {
					schemaCreate += this.exportComment(`${label} ${localisedDate(timestamp(value))}`);
					newCrlf = this.exportComment() + crlf;
				}
			}
		}
		schemaCreate += newCrlf;
		const sqlBackquotes = this.run.globals.sql_backquotes;
		const dropTable = this.run.flag('sql_drop_table');
		if (dropTable && await this.isView(db, table)) {
			schemaCreate += `DROP VIEW IF EXISTS ${backquoteCompat(tableAlias, 'NONE', Boolean(sqlBackquotes))};${crlf}`;
		}
		if (dropTable && !await this.isView(db, table)) {
			schemaCreate += `DROP TABLE IF EXISTS ${backquoteCompat(tableAlias, 'NONE', Boolean(sqlBackquotes))};${crlf}`;
		}
		await dbi.query(`SET SQL_QUOTE_SHOW_CREATE = ${sqlBackquotes ? 1 : 0}`);
		await dbi.tryQuery(`USE ${backquote(db)}`);
		const result = await dbi.tryQuery(`SHOW CREATE TABLE ${backquote(db)}.${backquote(table)}`);
		const error = dbi.getError();
		if (error !== '') {
			return this.exportComment(`${sprintf('Error reading structure for table %s:', `${db}.${table}`)} ${error}`);
		}
		let warning = '';
		const row = result === false ? null : result.fetchRow();
		if (row !== null) {
			let createQuery = String(row[1]);
			if (createQuery.indexOf('(\r\n ') > 0) {
				createQuery = createQuery.replaceAll('\r\n', () => crlf);
			} else if (createQuery.indexOf('(\n ') > 0) {
				createQuery = createQuery.replaceAll('\n', () => crlf);
			} else if (createQuery.indexOf('(\r ') > 0) {
				createQuery = createQuery.replaceAll('\r', () => crlf);
			}
			this.run.loadParserContext();
			if (view) {
				createQuery = createQuery.replaceAll(`${backquote(db)}.`, '');
				const statement = new Parser(createQuery).statements[0];
				const definerless = this.run.context.config.Export.remove_definer_from_definitions || this.run.has('sql_view_current_user');
				if (definerless) {
					statement.options?.remove('DEFINER');
				}
				if (this.run.has('sql_simple_view_export')) {
					for (const option of ['SQL SECURITY', 'INVOKER', 'ALGORITHM', 'DEFINER']) {
						statement.options?.remove(option);
					}
				}
				createQuery = statement.build();
				if (this.run.has('sql_or_replace_view')) {
					createQuery = createQuery.replace(/^CREATE/, 'CREATE OR REPLACE');
				}
			}
			const [aliased, flag] = this.replaceWithAliases(null, createQuery, aliases, db);
			createQuery = aliased;
			if (flag && view) {
				warning = this.exportComment() + this.exportComment('It appears your database uses views;') + this.exportComment('alias export may not work reliably in all cases.') + this.exportComment();
			}
			if (this.run.has('sql_if_not_exists')) {
				createQuery = createQuery.replace(/^CREATE TABLE/, 'CREATE TABLE IF NOT EXISTS');
			}
			if (compat === 'MSSQL') {
				createQuery = makeCreateTableMssqlCompatible(createQuery);
			}
			if (!view) {
				if (!sqlBackquotes) {
					Context.MODE |= Context.SQL_MODE_NO_ENCLOSING_QUOTES;
				}
				if (compat === 'MSSQL' || sqlBackquotes === '"') {
					Context.MODE |= Context.SQL_MODE_ANSI_QUOTES;
				}
			}
			createQuery = this.splitCreateTable(createQuery, table, tableAlias);
			schemaCreate += createQuery;
		}
		Context.setMode();
		return `${warning}${schemaCreate};${crlf}`;
	}

	// The part of getTableDef() that moves indexes, constraints and AUTO_INCREMENT into ALTER TABLE statements.
	private splitCreateTable(createQuery: string, table: string, tableAlias: string): string {
		const { crlf } = this;
		const compat = this.compat;
		const statement = new Parser(createQuery).statements[0] as CreateStatement;
		const engine = statement.entityOptions === null ? '' : statement.entityOptions.has('ENGINE');
		const fields = statement.fields;
		if (!Array.isArray(fields) || fields.length === 0 || (!isEmpty(engine) && String(engine).toUpperCase() === 'ARCHIVE')) {
			return createQuery;
		}
		const ifNotExists = this.run.flag('sql_if_not_exists');
		const constraints: string[] = [];
		const indexes: string[] = [];
		const fulltext: string[] = [];
		const autoIncrement: string[] = [];
		const removed = new Set<CreateDefinition>();
		for (const field of fields) {
			if (field.isConstraint) {
				constraints.push(CreateDefinition.build(field));
				removed.add(field);
			} else if (field.key !== null) {
				if (field.key.type === 'FULLTEXT KEY') {
					fulltext.push(CreateDefinition.build(field));
					removed.add(field);
				} else if (!ifNotExists) {
					indexes.push(CreateDefinition.build(field).replaceAll('COMMENT=\'', 'COMMENT \''));
					removed.add(field);
				}
			}
			if (field.key !== null && field.key.type === 'FOREIGN KEY') {
				removed.add(field);
			}
			if (field.options === null) {
				continue;
			}
			if (field.options.has('AUTO_INCREMENT') === false || ifNotExists) {
				continue;
			}
			autoIncrement.push(CreateDefinition.build(field));
			field.options.remove('AUTO_INCREMENT');
		}
		statement.fields = fields.filter(field => !removed.has(field));
		const alterHeader = `ALTER TABLE ${backquoteCompat(tableAlias, compat, this.backquotes)}`;
		const alterFooter = `;${crlf}`;
		if (constraints.length > 0) {
			const query = `${alterHeader}${crlf}  ADD ${constraints.join(`,${crlf}  ADD `)}${alterFooter}`;
			this.sqlConstraints = this.generateComment(this.sqlConstraints, 'Constraints for dumped tables', 'Constraints for table', tableAlias) + query;
		}
		let indexesQuery = '';
		if (indexes.length > 0) {
			indexesQuery += `${alterHeader}${crlf}  ADD ${indexes.join(`,${crlf}  ADD `)}${alterFooter}`;
		}
		if (fulltext.length > 0) {
			indexesQuery += `${alterHeader} ADD ${fulltext.join(`${alterFooter}${alterHeader} ADD `)}${alterFooter}`;
		}
		if (indexes.length > 0 || fulltext.length > 0) {
			this.sqlIndexes = this.generateComment(this.sqlIndexes, 'Indexes for dumped tables', 'Indexes for table', tableAlias) + indexesQuery;
		}
		if (autoIncrement.length > 0) {
			let query = `${alterHeader}${crlf}  MODIFY ${autoIncrement.join(`,${crlf}  MODIFY `)}`;
			const tableValue = statement.entityOptions?.has('AUTO_INCREMENT') ?? false;
			if (this.run.has('sql_auto_increment') && tableValue !== false) {
				const tableData = this.run.globals.table_data;
				if (tableData === undefined || (Array.isArray(tableData) && tableData.includes(table))) {
					query += `, AUTO_INCREMENT=${String(tableValue)}`;
				}
			}
			query += `;${crlf}`;
			this.sqlAutoIncrements = this.generateComment(this.sqlAutoIncrements, 'AUTO_INCREMENT for dumped tables', 'AUTO_INCREMENT for table', tableAlias) + query;
		}
		if (statement.entityOptions !== null && (!ifNotExists || !this.run.flag('sql_auto_increment'))) {
			statement.entityOptions.remove('AUTO_INCREMENT');
		}
		return statement.build();
	}

	private sqlValue(value: string | null | undefined, meta: FieldMetadata): string {
		if (value === null || value === undefined) {
			return 'NULL';
		}
		if (meta.isNumeric) {
			return value;
		}
		if (meta.isBinary && this.run.has('sql_hex_for_binary')) {
			if (value === '') {
				return '\'\'';
			}
			return `0x${bin2hex(value)}`;
		}
		if (meta.isMappedTypeBit) {
			return `b'${printableBitValue(value, meta.length)}'`;
		}
		if (meta.isMappedTypeGeometry) {
			return `0x${bin2hex(value)}`;
		}
		if (value === '') {
			return '\'\'';
		}
		return `'${this.dbi.escapeString(rawValue(value, meta))}'`;
	}

	async exportHeader(): Promise<boolean> {
		const { config } = this.run.context;
		const { crlf, dbi } = this;
		if (this.run.has('sql_compatibility')) {
			const compat = this.compat === 'NONE' ? '' : this.compat;
			await dbi.tryQuery(`SET SQL_MODE="${compat}"`);
		}
		let head = this.exportComment('phpMyAdmin SQL Dump') + this.exportComment(`version ${PMA_VERSION}`) + this.exportComment('https://www.phpmyadmin.net/') + this.exportComment();
		let host = `Host: ${config.Server.host}`;
		if (!isEmpty(config.Server.port)) {
			host += `:${config.Server.port}`;
		}
		head += this.exportComment(host);
		head += this.exportComment(`Generation Time: ${localisedDate()}`)
			+ this.exportComment(`Server version: ${dbi.getVersionString()}`)
			+ this.exportComment(`PHP Version: ${PHP_VERSION}`)
			+ this.possibleCRLF();
		const headerComment = this.run.str('sql_header_comment');
		if (!isEmpty(headerComment)) {
			head += this.exportComment();
			for (const line of headerComment.split(String.raw`\n`)) {
				head += this.exportComment(line);
			}
			head += this.exportComment();
		}
		if (this.run.has('sql_disable_fk')) {
			head += `SET FOREIGN_KEY_CHECKS=0;${crlf}`;
		}
		if (!this.run.has('sql_compatibility') || this.compat === 'NONE') {
			head += `SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";${crlf}`;
		}
		if (this.run.has('sql_use_transaction')) {
			head += `START TRANSACTION;${crlf}`;
		}
		if (this.run.flag('sql_utc_time')) {
			head += `SET time_zone = "+00:00";${crlf}`;
			this.oldTimeZone = String(await dbi.fetchValue('SELECT @@session.time_zone'));
			await dbi.query('SET time_zone = "+00:00"');
		}
		head += this.possibleCRLF();
		if (this.run.flag('asfile')) {
			let setNames = MYSQL_CHARSET_MAP[this.run.str('charset')] ?? 'utf8';
			if (setNames === 'utf8' && dbi.getVersion() > 50503) {
				setNames = 'utf8mb4';
			}
			head += `${crlf}/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;${crlf}`
				+ `/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;${crlf}`
				+ `/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;${crlf}`
				+ `/*!40101 SET NAMES ${setNames} */;${crlf}${crlf}`;
			this.sentCharset = true;
		}
		return this.run.write(head);
	}

	override async exportFooter(): Promise<boolean> {
		const { crlf } = this;
		let foot = '';
		if (this.run.has('sql_disable_fk')) {
			foot += `SET FOREIGN_KEY_CHECKS=1;${crlf}`;
		}
		if (this.run.has('sql_use_transaction')) {
			foot += `COMMIT;${crlf}`;
		}
		if (this.sentCharset) {
			foot += `${crlf}/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;${crlf}`
				+ `/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;${crlf}`
				+ `/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;${crlf}`;
			this.sentCharset = false;
		}
		if (this.run.flag('sql_utc_time')) {
			await this.dbi.query(`SET time_zone = "${this.oldTimeZone}"`);
		}
		return this.run.write(foot);
	}

	override async exportDBCreate(db: string, exportType: string, dbAlias = ''): Promise<boolean> {
		const alias = isEmpty(dbAlias) ? db : dbAlias;
		const { crlf } = this;
		const structureOrData = this.run.globals.sql_structure_or_data;
		const exportStructure = ([undefined, 'structure', 'structure_and_data'] as unknown[]).includes(structureOrData);
		if (exportStructure && this.run.has('sql_drop_database')) {
			this.run.write(`DROP DATABASE IF EXISTS ${backquoteCompat(alias, this.compat, this.backquotes)};${crlf}`);
		}
		if (exportType === 'database' && !this.run.has('sql_create_database')) {
			return true;
		}
		let createQuery = `CREATE DATABASE IF NOT EXISTS ${backquoteCompat(alias, this.compat, this.backquotes)}`;
		const collation = await this.dbi.getDbCollation(db);
		const underscore = collation.indexOf('_');
		if (underscore > 0) {
			createQuery += ` DEFAULT CHARACTER SET ${collation.slice(0, underscore)} COLLATE ${collation}`;
		} else {
			createQuery += ` DEFAULT CHARACTER SET ${collation}`;
		}
		this.run.write(`${createQuery};${crlf}`);
		return this.exportUseStatement(alias);
	}

	override async exportDBHeader(db: string, dbAlias = ''): Promise<boolean> {
		const alias = isEmpty(dbAlias) ? db : dbAlias;
		return this.run.write(this.exportComment() + this.exportComment(`Database: ${backquoteCompat(alias, this.compat, this.backquotes)}`) + this.exportComment());
	}

	override async exportDBFooter(): Promise<boolean> {
		if (this.sqlIndexes !== null) {
			this.run.write(this.sqlIndexes);
			this.sqlIndexes = null;
		}
		if (this.sqlAutoIncrements !== null) {
			this.run.write(this.sqlAutoIncrements);
			this.sqlAutoIncrements = null;
		}
		if (this.sqlViews !== '') {
			this.run.write(this.sqlViews);
			this.sqlViews = '';
		}
		if (this.sqlConstraints !== null) {
			this.run.write(this.sqlConstraints);
			this.sqlConstraints = null;
		}
		return true;
	}

	override async exportRoutines(db: string, aliases: ExportAliases): Promise<boolean> {
		const { crlf } = this;
		const delimiter = '$$';
		const procedures = await getProceduresOrFunctions(this.run.context, db, 'PROCEDURE');
		const functions = await getProceduresOrFunctions(this.run.context, db, 'FUNCTION');
		let text = '';
		if (procedures.length > 0 || functions.length > 0) {
			text += `${crlf}DELIMITER ${delimiter}${crlf}`;
			if (procedures.length > 0) {
				text += await this.exportRoutineSql(db, aliases, 'PROCEDURE', 'Procedures', procedures, delimiter);
			}
			if (functions.length > 0) {
				text += await this.exportRoutineSql(db, aliases, 'FUNCTION', 'Functions', functions, delimiter);
			}
			text += `DELIMITER ;${crlf}`;
		}
		if (text !== '') {
			return this.run.write(text);
		}
		return false;
	}

	override async exportEvents(db: string): Promise<boolean> {
		const { crlf, dbi } = this;
		const delimiter = '$$';
		const events = await dbi.fetchResult<string>(`SELECT EVENT_NAME FROM information_schema.EVENTS WHERE EVENT_SCHEMA= '${dbi.escapeString(db)}';`, null, 0);
		let text = '';
		if (events.length > 0) {
			text += `${crlf}DELIMITER ${delimiter}${crlf}`;
			text += this.exportComment() + this.exportComment('Events') + this.exportComment();
			for (const event of events) {
				if (this.run.flag('sql_drop_table')) {
					text += `DROP EVENT IF EXISTS ${backquote(event)}${delimiter}${crlf}`;
				}
				const definition = await getDefinition(this.run.context, db, 'EVENT', String(event));
				text += `${definition ?? ''}${delimiter}${crlf}${crlf}`;
			}
			text += `DELIMITER ;${crlf}`;
		}
		if (text !== '') {
			return this.run.write(text);
		}
		return false;
	}

	/** ExportSql::replaceWithAliases(): the rebuilt query and whether an alias was applied. */
	replaceWithAliases(delimiter: string | null, sqlQuery: string, aliases: ExportAliases, db: string): [string, boolean] {
		this.run.loadParserContext();
		const parser = new Parser(delimiter === null || delimiter === '' ? sqlQuery : `DELIMITER ${delimiter}\n${sqlQuery}`);
		const statement = parser.statements[0] as CreateStatement | undefined;
		if (statement === undefined) {
			return [sqlQuery, false];
		}
		let flag = false;
		let oldDatabase = db;
		const columnsOf = (database: string, name: string): Record<string, string> => aliases[database]?.tables?.[name]?.columns ?? {};
		if (statement.options?.has('TABLE') && statement.name !== null) {
			const name = statement.name;
			if (!isEmpty(name.database)) {
				oldDatabase = String(name.database);
			}
			const oldTable = String(name.table);
			let newDatabase: string | null = null;
			if (!isEmpty(name.database)) {
				newDatabase = String(name.database);
				if (aliases[oldDatabase]?.alias) {
					newDatabase = aliases[oldDatabase].alias as string;
				}
			}
			const newTable = aliases[oldDatabase]?.tables?.[oldTable]?.alias || oldTable;
			if (name.database !== newDatabase || name.table !== newTable) {
				name.database = newDatabase;
				name.table = newTable;
				name.expr = '';
				flag = true;
			}
			for (const field of Array.isArray(statement.fields) ? statement.fields : []) {
				const columns = columnsOf(oldDatabase, oldTable);
				if (field.type !== null && columns[String(field.name)]) {
					field.name = columns[String(field.name)];
					flag = true;
				}
				if (field.key !== null) {
					for (const column of field.key.columns) {
						if (!(column.name !== undefined && column.name !== null && columns[String(column.name)])) {
							continue;
						}

						column.name = columns[String(column.name)];
						flag = true;
					}
				}
				if (field.references === null) {
					continue;
				}
				const referenceTable = String(field.references.table?.table);
				const referenceAlias = aliases[oldDatabase]?.tables?.[referenceTable]?.alias;
				if (referenceAlias && field.references.table !== null) {
					field.references.table.table = referenceAlias;
					field.references.table.expr = '';
					flag = true;
				}
				const referenceColumns = columnsOf(oldDatabase, referenceTable);
				field.references.columns = field.references.columns.map((column) => {
					if (referenceColumns[column]) {
						flag = true;
						return referenceColumns[column];
					}
					return column;
				});
			}
		} else if (statement.options?.has('TRIGGER') && statement.table !== null) {
			if (!isEmpty(statement.table.database)) {
				oldDatabase = String(statement.table.database);
			}
			const triggerAlias = aliases[oldDatabase]?.tables?.[String(statement.table.table)]?.alias;
			if (triggerAlias) {
				statement.table.table = triggerAlias;
				statement.table.expr = '';
				flag = true;
			}
		}
		const options = statement.options;
		if (options?.has('TRIGGER') || options?.has('PROCEDURE') || options?.has('FUNCTION') || options?.has('VIEW')) {
			for (const token of statement.body ?? []) {
				const isSymbol = token.type === Token.TYPE_SYMBOL;
				const isKeyword = token.type === Token.TYPE_KEYWORD;
				const isNone = token.type === Token.TYPE_NONE;
				const replaceToken = (isSymbol && !(token.flags & Token.FLAG_SYMBOL_VARIABLE)) || (isKeyword && !(token.flags & Token.FLAG_KEYWORD_RESERVED)) || isNone;
				if (!replaceToken) {
					continue;
				}
				const alias = this.getAlias(aliases, String(token.value));
				if (alias === '' || alias === '0') {
					continue;
				}
				token.token = Context.escape(alias);
				flag = true;
			}
		}
		return [statement.build(), flag];
	}

	override async exportRawQuery(db: string | null, sqlQuery: string): Promise<boolean> {
		if (db !== null) {
			await this.dbi.selectDb(db);
		}
		return this.exportData(db ?? '', '', sqlQuery, {});
	}

	override async exportStructure(db: string, table: string, exportMode: string, exportType: string, options: StructureOptions, aliases: ExportAliases): Promise<boolean> {
		const { crlf } = this;
		const [, tableAlias] = this.initAlias(aliases, db, table);
		const formattedTableName = backquoteCompat(tableAlias, this.compat, this.backquotes);
		let dump = this.possibleCRLF() + this.exportComment('-'.repeat(56)) + this.possibleCRLF() + this.exportComment();
		switch (exportMode) {
			case 'create_table': {
				dump += this.exportComment(`Table structure for table ${formattedTableName}`) + this.exportComment();
				dump += await this.getTableDef(db, table, options.dates, false, aliases);
				break;
			}
			case 'triggers': {
				dump = '';
				const delimiter = '$$';
				const triggers = await getTriggers(this.run.context, db, table, delimiter);
				if (triggers.length > 0) {
					dump += this.possibleCRLF() + this.exportComment() + this.exportComment(`Triggers ${formattedTableName}`) + this.exportComment();
					let usedAlias = false;
					let triggerQuery = '';
					for (const trigger of triggers) {
						if (this.run.flag('sql_drop_table')) {
							triggerQuery += `${trigger.drop};${crlf}`;
						}
						triggerQuery += `DELIMITER ${delimiter}${crlf}`;
						const [create, flag] = this.replaceWithAliases(delimiter, trigger.create, aliases, db);
						usedAlias ||= flag;
						triggerQuery += `${create}${delimiter}${crlf}DELIMITER ;${crlf}`;
					}
					if (usedAlias) {
						dump += this.exportComment('It appears your table uses triggers;') + this.exportComment('alias export may not work reliably in all cases.') + this.exportComment();
					}
					dump += triggerQuery;
				}
				break;
			}
			case 'create_view': {
				const viewsAsTables = this.run.flag('sql_views_as_tables');
				if (viewsAsTables) {
					dump += this.exportComment(sprintf('Structure for view %s exported as a table', formattedTableName)) + this.exportComment();
				} else {
					dump += this.exportComment(`Structure for view ${formattedTableName}`) + this.exportComment();
				}
				if (exportType !== 'table') {
					dump += `DROP TABLE IF EXISTS ${backquote(tableAlias)};${crlf}`;
				}
				if (viewsAsTables) {
					dump += await this.getTableDefForView(db, table, aliases);
				} else {
					dump += await this.getTableDef(db, table, options.dates, true, aliases);
					this.sqlViews += dump;
					dump = '';
				}
				break;
			}
			default: {
				dump += this.exportComment(`Stand-in structure for view ${formattedTableName}`) + this.exportComment('(See below for the actual view)') + this.exportComment();
				dump += await this.getTableDefStandIn(db, table, aliases);
			}
		}
		return this.run.write(dump);
	}

	async exportData(db: string, table: string, sqlQuery: string, aliases: ExportAliases): Promise<boolean> {
		const { crlf, dbi } = this;
		const tableObject = Table.get(this.run.context, table, db);
		if (await tableObject.isMerge()) {
			return true;
		}
		const [, tableAlias] = this.initAlias(aliases, db, table);
		const compat = this.compat;
		const sqlBackquotes = Boolean(this.run.globals.sql_backquotes);
		const formattedTableName = backquoteCompat(tableAlias, compat, sqlBackquotes);
		if (await tableObject.isView() && !this.run.flag('sql_views_as_tables')) {
			const head = this.possibleCRLF() + this.exportComment() + this.exportComment(`VIEW ${formattedTableName}`) + this.exportComment('Data: None') + this.exportComment() + this.possibleCRLF();
			return this.run.write(head);
		}
		const result = await dbi.tryQuery(sqlQuery);
		const error = dbi.getError();
		if (error !== '') {
			return this.run.write(this.exportComment(`${sprintf('Error reading data for table %s:', `${db}.${table}`)} ${error}`));
		}
		if (result === false) {
			return true;
		}
		const fieldsMeta = result.getFieldsMeta();
		const fieldSet = fieldsMeta.map(meta => backquoteCompat(this.columnAlias(aliases, db, table, meta.name), compat, sqlBackquotes));
		const type = this.run.str('sql_type');
		const insertSyntax = this.run.str('sql_insert_syntax');
		let schemaInsert: string;
		if (type === 'UPDATE') {
			schemaInsert = `UPDATE ${this.run.has('sql_ignore') ? 'IGNORE ' : ''}${backquoteCompat(tableAlias, compat, sqlBackquotes)} SET`;
		} else {
			const command = type === 'REPLACE' ? 'REPLACE' : 'INSERT';
			let insertDelayed = this.run.has('sql_delayed') ? ' DELAYED' : '';
			if (this.run.has('sql_type') && this.run.has('sql_ignore') && type === 'INSERT') {
				insertDelayed += ' IGNORE';
			}
			if (this.run.flag('sql_truncate') && command === 'INSERT') {
				const truncateHead = this.possibleCRLF() + this.exportComment() + this.exportComment(`Truncate table before insert ${formattedTableName}`) + this.exportComment() + crlf;
				this.run.write(truncateHead);
				this.run.write(`TRUNCATE TABLE ${backquoteCompat(tableAlias, compat, sqlBackquotes)};`);
			}
			if (insertSyntax === 'complete' || insertSyntax === 'both') {
				schemaInsert = `${command}${insertDelayed} INTO ${backquoteCompat(tableAlias, compat, sqlBackquotes)} (${fieldSet.join(', ')}) VALUES`;
			} else {
				schemaInsert = `${command}${insertDelayed} INTO ${backquoteCompat(tableAlias, compat, sqlBackquotes)} VALUES`;
			}
		}
		const extended = (insertSyntax === 'extended' || insertSyntax === 'both') && type !== 'UPDATE';
		let separator = ';';
		if (extended) {
			separator = ',';
			schemaInsert += crlf;
		}
		const maxSize = Number(this.run.globals.sql_max_query_size ?? 0) || 0;
		let currentRow = 0;
		let querySize = 0;
		for (let row = result.fetchRow(); row !== null; row = result.fetchRow()) {
			if (currentRow === 0) {
				this.run.write(`${this.possibleCRLF()}${this.exportComment()}${this.exportComment(`Dumping data for table ${formattedTableName}`)}${this.exportComment()}${crlf}`);
			}
			if (compat === 'MSSQL' && currentRow === 0) {
				this.run.write(`SET IDENTITY_INSERT ${backquoteCompat(tableAlias, compat, sqlBackquotes)} ON ;${crlf}`);
			}
			currentRow++;
			const values = fieldsMeta.map((meta, index) => this.sqlValue(row[index], meta));
			let insertLine: string;
			if (type === 'UPDATE') {
				insertLine = `${schemaInsert} ${fieldSet.map((field, index) => `${field} = ${values[index]}`).join(',')}`;
				const [condition] = getUniqueCondition(fieldsMeta, row, { isView: () => false, escapeString: value => dbi.escapeString(value) });
				insertLine += ` WHERE ${condition}`;
			} else if (extended) {
				if (currentRow === 1) {
					insertLine = `${schemaInsert}(${values.join(', ')})`;
				} else {
					insertLine = `(${values.join(', ')})`;
					const lineSize = [...insertLine].length;
					if (maxSize > 0 && querySize + lineSize > maxSize) {
						this.run.write(`;${crlf}`);
						querySize = 0;
						currentRow = 1;
						insertLine = schemaInsert + insertLine;
					}
				}
				querySize += [...insertLine].length;
			} else {
				insertLine = `${schemaInsert}(${values.join(', ')})`;
			}
			this.run.write((currentRow === 1 ? '' : separator + crlf) + insertLine);
		}
		if (currentRow > 0) {
			this.run.write(`;${crlf}`);
		}
		if (compat === 'MSSQL' && currentRow > 0) {
			this.run.write(`${crlf}SET IDENTITY_INSERT ${backquoteCompat(tableAlias, compat, sqlBackquotes)} OFF;${crlf}`);
		}
		return true;
	}
}

// Ports of Table::rename(), Table::moveCopy() and Operations::moveOrCopyTable() for the table operations page.
import { escapeString } from '../../../../lib/pma/dbi-sql.ts';
import { Message } from '../../../../lib/pma/message.ts';
import { sprintf } from '../../../../lib/pma/sprintf.ts';
import { htmlspecialchars } from '../../../../lib/twig/php.ts';
import { backquote } from '../../../../lib/twig/sanitize.ts';
import {
	AlterStatement,
	Context,
	CreateDefinition,
	CreateStatement,
	DropStatement,
	Expression,
	OptionsArray,
	Parser,
} from '../../../../sql-parser/index.ts';
import { Table } from '../../core/table.ts';

import type { PmaContext } from '../../core/context.ts';

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const isEmpty = (value: unknown): boolean => [undefined, null, '', '0', false].includes(value as never);

export interface RenameResult {
	ok: boolean;
	table: Table;
	/** Table::getLastMessage() on success, Table::getLastError() on failure. */
	message: string;
	/** $GLOBALS['sql_query'] when the RENAME ran. */
	sqlQuery: string;
}

function loadParserContext(context: PmaContext): void {
	const { dbi } = context;
	Context.loadClosest(`${dbi.isMariaDB() ? 'MariaDb' : 'MySql'}${dbi.getVersion()}`);
}

/** Table::rename(); triggers only move with the table across databases, which customers cannot reach. */
export async function renameTable(context: PmaContext, table: Table, requestedName: string, newDb: string | null = null): Promise<RenameResult> {
	const { dbi } = context;
	let newName = requestedName;
	if (await dbi.getLowerCaseNames() === '1') {
		newName = newName.toLowerCase();
	}
	let targetDb = table.getDbName();
	if (newDb !== null && newDb !== table.getDbName()) {
		const databases = await dbi.getDatabaseList();
		if (!databases.includes(newDb)) {
			return { ok: false, table, message: `Invalid database: ${newDb}`, sqlQuery: '' };
		}
		targetDb = newDb;
	}
	const target = Table.get(context, newName, targetDb);
	if (table.getFullName() === target.getFullName()) {
		return { ok: true, table, message: '', sqlQuery: '' };
	}
	if (!Table.isValidName(newName, true)) {
		return { ok: false, table, message: `Invalid table name: ${target.getFullName()}`, sqlQuery: '' };
	}
	const sqlQuery = `\n            RENAME TABLE ${table.getFullName(true)}\n                  TO ${target.getFullName(true)};`;
	context.response.globals.sqlQuery = sqlQuery;
	if (await dbi.tryQuery(sqlQuery) === false) {
		return { ok: false, table, message: dbi.getError(), sqlQuery };
	}
	return { ok: true, table: target, message: sprintf('Table %1$s has been renamed to %2$s.', table.getName(), newName), sqlQuery };
}

interface TableDefinition {
	create: string;
	constraints: string;
	indexes: string;
	autoIncrements: string;
}

/** The parts of ExportSql::getTableDef() that Table::moveCopy() uses: the bare CREATE plus the split ALTER statements. */
async function getTableDef(context: PmaContext, db: string, table: string, isView: boolean, autoIncrementOption: boolean): Promise<TableDefinition> {
	const { dbi } = context;
	const definition: TableDefinition = { create: '\n', constraints: '', indexes: '', autoIncrements: '' };
	await dbi.tryQuery(`SHOW TABLE STATUS FROM ${backquote(db)} WHERE Name = '${escapeString(table)}'`);
	await dbi.query('SET SQL_QUOTE_SHOW_CREATE = 1');
	await dbi.tryQuery(`USE ${backquote(db)}`);
	const result = await dbi.tryQuery(`SHOW CREATE TABLE ${backquote(db)}.${backquote(table)}`);
	const error = dbi.getError();
	if (error !== '') {
		definition.create = `-- ${sprintf('Error reading structure for table %s:', `${db}.${table}`)} ${error}\n`;
		return definition;
	}
	const row = result === false ? null : result.fetchRow();
	if (row === null) {
		return definition;
	}
	let createQuery = String(row[1]);
	loadParserContext(context);
	if (isView) {
		createQuery = createQuery.replaceAll(`${backquote(db)}.`, '');
		createQuery = new Parser(createQuery).statements[0].build();
	}
	const statement = new Parser(createQuery).statements[0];
	if (!(statement instanceof CreateStatement) || !Array.isArray(statement.fields) || statement.fields.length === 0) {
		definition.create += createQuery;
		return definition;
	}
	const engine = statement.entityOptions?.has('ENGINE') ?? '';
	if (!isEmpty(engine) && String(engine).toUpperCase() === 'ARCHIVE') {
		definition.create += createQuery;
		return definition;
	}
	const constraints: string[] = [];
	const indexes: string[] = [];
	const fulltext: string[] = [];
	const autoIncrement: string[] = [];
	const removed = new Set<CreateDefinition>();
	for (const field of statement.fields) {
		if (field.isConstraint) {
			constraints.push(CreateDefinition.build(field));
			removed.add(field);
		} else if (field.key !== null) {
			if (field.key.type === 'FULLTEXT KEY') {
				fulltext.push(CreateDefinition.build(field));
			} else {
				indexes.push(CreateDefinition.build(field).replaceAll('COMMENT=\'', 'COMMENT \''));
			}
			removed.add(field);
		}
		if (field.key !== null && field.key.type === 'FOREIGN KEY') {
			removed.add(field);
		}
		if (field.options === null || field.options.has('AUTO_INCREMENT') === false) {
			continue;
		}
		autoIncrement.push(CreateDefinition.build(field));
		field.options.remove('AUTO_INCREMENT');
	}
	statement.fields = statement.fields.filter(field => !removed.has(field));
	const header = `ALTER TABLE ${backquote(table)}`;
	if (constraints.length > 0) {
		definition.constraints = `${header}\n  ADD ${constraints.join(',\n  ADD ')};\n`;
	}
	if (indexes.length > 0) {
		definition.indexes += `${header}\n  ADD ${indexes.join(',\n  ADD ')};\n`;
	}
	if (fulltext.length > 0) {
		definition.indexes += `${header} ADD ${fulltext.join(`;\n${header} ADD `)};\n`;
	}
	if (autoIncrement.length > 0) {
		let query = `${header}\n  MODIFY ${autoIncrement.join(',\n  MODIFY ')}`;
		const tableValue = statement.entityOptions?.has('AUTO_INCREMENT') ?? false;
		if (autoIncrementOption && tableValue !== false) {
			query += `, AUTO_INCREMENT=${String(tableValue)}`;
		}
		definition.autoIncrements = `${query};\n`;
	}
	statement.entityOptions?.remove('AUTO_INCREMENT');
	definition.create += statement.build();
	return definition;
}

// Rebuilds ALTER statements for the destination table without constraint names, which must stay unique.
function retargetAlters(sql: string, destination: Expression): string[] {
	return new Parser(sql).statements.filter(statement => statement instanceof AlterStatement).map((statement) => {
		statement.table = destination;
		for (const altered of statement.altered) {
			if (altered.options?.has('CONSTRAINT')) {
				altered.field = null;
			}
		}
		return `${statement.build()};`;
	});
}

export interface MoveCopyOptions {
	sourceDb: string;
	sourceTable: string;
	targetDb: string;
	targetTable: string;
	what: string;
	move: boolean;
	addDropIfExists: boolean;
}

/** Table::moveCopy() in 'one_table' mode; returns false with an error message when a database is missing. */
export async function moveCopy(context: PmaContext, options: MoveCopyOptions): Promise<{ ok: boolean; message?: Message | string; }> {
	const { dbi, response } = context;
	const { sourceDb, sourceTable, targetTable, what, move } = options;
	const globals = response.globals;
	if (move && what === 'data') {
		const renamed = await renameTable(context, Table.get(context, sourceTable, sourceDb), targetTable, options.targetDb);
		if (renamed.ok) {
			return { ok: true, message: renamed.message };
		}
	}
	const databases = await dbi.getDatabaseList();
	if (!databases.includes(sourceDb) || !databases.includes(options.targetDb)) {
		let message: Message | undefined;
		if (!databases.includes(sourceDb)) {
			message = Message.rawError(sprintf('Source database `%s` was not found!', htmlspecialchars(sourceDb)));
		}
		if (!databases.includes(options.targetDb)) {
			message = Message.rawError(sprintf('Target database `%s` was not found!', htmlspecialchars(options.targetDb)));
		}
		return { ok: false, message };
	}
	const source = `${backquote(sourceDb)}.${backquote(sourceTable)}`;
	const targetDb = options.targetDb === '' ? sourceDb : options.targetDb;
	await dbi.selectDb(targetDb);
	const target = `${backquote(targetDb)}.${backquote(targetTable)}`;
	if (what === 'dataonly') {
		globals.sqlQuery = '';
	} else {
		const isView = await Table.get(context, sourceTable, sourceDb).isView();
		const definition = await getTableDef(context, sourceDb, sourceTable, isView, context.request.post.sql_auto_increment !== undefined);
		const destination = new Expression(targetDb, targetTable, '');
		const mode = await dbi.fetchValue('SELECT @@sql_mode');
		loadParserContext(context);
		Context.setMode(typeof mode === 'string' ? mode : '');
		if (options.addDropIfExists) {
			const drop = new DropStatement();
			drop.options = new OptionsArray([await Table.get(context, targetTable, targetDb).isView() ? 'VIEW' : 'TABLE', 'IF EXISTS']);
			drop.fields = [destination];
			const dropQuery = `${drop.build()};`;
			await dbi.query(dropQuery);
			globals.sqlQuery += `\n${dropQuery}`;
		}
		const statement = new Parser(definition.create).statements[0];
		if (statement !== undefined) {
			(statement as CreateStatement).name = destination;
			const structure = `${statement.build()};`;
			if (move) {
				await dbi.selectDb(targetDb);
			}
			await dbi.query(structure);
			globals.sqlQuery += `\n${structure}`;
		}
		if (move && definition.constraints !== '') {
			const [constraintsQuery] = retargetAlters(definition.constraints, destination);
			await dbi.query(constraintsQuery);
			globals.sqlQuery += `\n${constraintsQuery}`;
		}
		if (definition.indexes !== '') {
			let indexesQuery = '';
			for (const query of retargetAlters(definition.indexes, destination)) {
				await dbi.query(query);
				indexesQuery += query;
			}
			globals.sqlQuery += `\n${indexesQuery}`;
		}
		if (definition.autoIncrements !== '') {
			const [autoIncrementQuery] = retargetAlters(definition.autoIncrements, destination);
			if (autoIncrementQuery !== undefined) {
				await dbi.query(autoIncrementQuery);
				globals.sqlQuery += `\n${autoIncrementQuery}`;
			}
		}
		Context.setMode();
	}
	if ((what === 'data' || what === 'dataonly') && !await Table.get(context, targetTable, targetDb).isView()) {
		const setMode = 'SET SQL_MODE=\'NO_AUTO_VALUE_ON_ZERO\'';
		await dbi.query(setMode);
		globals.sqlQuery += `\n\n${setMode};`;
		const columns = await Table.get(context, sourceTable, sourceDb).getNonGeneratedColumns(true);
		if (columns.length > 0) {
			const insert = `INSERT INTO ${target}(${columns.join(', ')}) SELECT ${columns.join(', ')} FROM ${source}`;
			await dbi.query(insert);
			globals.sqlQuery += `\n\n${insert};`;
		}
	}
	if (move) {
		await dbi.selectDb(sourceDb);
		const drop = `${await Table.get(context, sourceTable, sourceDb).isView() ? 'DROP VIEW' : 'DROP TABLE'} ${source}`;
		await dbi.query(drop);
		globals.sqlQuery += `\n\n${drop};`;
	}
	return { ok: true };
}

/** Operations::moveOrCopyTable(). */
export async function moveOrCopyTable(context: PmaContext): Promise<Message> {
	const { dbi } = context;
	const post = context.request.post;
	const { db, table } = context;
	await dbi.selectDb(db);
	let targetDb = db;
	if (typeof post.target_db === 'string' && post.target_db !== '') {
		targetDb = post.target_db;
	}
	const newName = text(post.new_name);
	if (newName === '') {
		return Message.error('The table name is empty!');
	}
	const isMove = post.submit_move !== undefined;
	if (db === targetDb && table === newName) {
		return Message.error(isMove ? 'Can\'t move table to same one!' : 'Can\'t copy table to same one!');
	}
	await moveCopy(context, {
		sourceDb: db,
		sourceTable: table,
		targetDb,
		targetTable: newName,
		what: text(post.what),
		move: isMove,
		addDropIfExists: post.drop_if_exists === 'true',
	});
	// The privilege tables are only rewritten for accounts that may, but the message follows the checkbox.
	const adjusted = !isEmpty(post.adjust_privileges) ? ' Privileges have been adjusted.' : '';
	const message = Message.success(`${isMove ? 'Table %s has been moved to %s.' : 'Table %s has been copied to %s.'}${adjusted}`);
	message.addParam(`${backquote(db)}.${backquote(table)}`);
	let finalName = newName;
	if (await dbi.getLowerCaseNames() === '1') {
		finalName = finalName.toLowerCase();
	}
	context.table = finalName;
	message.addParam(`${backquote(targetDb)}.${backquote(finalName)}`);
	return message;
}

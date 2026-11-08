// Port of Controllers\Table\Structure\SaveController (route /table/structure/save): ALTER TABLE ... CHANGE for edited columns.
import { serverKind } from './columns-definition.ts';
import { getColumnsWithIndex, mysqlDieHtmlFor } from './common.ts';
import { structureController } from './structure.ts';
import {
	INDEX_FULLTEXT,
	INDEX_INDEX,
	INDEX_PRIMARY,
	INDEX_SPATIAL,
	INDEX_UNIQUE,
} from '../../../../lib/pma/index.ts';
import { Message } from '../../../../lib/pma/message.ts';
import { type PhpArray, nestedParams, phpGet } from '../../../../lib/pma/table-data/php-params.ts';
import { valueByKey } from '../../../../lib/pma/table-structure/columns-definition.ts';
import { generateAlter } from '../../../../lib/pma/table-structure/field-spec.ts';
import { formatSql } from '../../../../lib/pma/table-structure/sql-format.ts';
import { backquote } from '../../../../lib/twig/sanitize.ts';
import { DbiQueryError } from '../../core/dbi.ts';
import { getMessage } from '../../core/generator.ts';
import { PROP_SORTED_COLUMN, Table } from '../../core/table.ts';
import { withMysqlDie } from '../server/mysql-die.ts';

import type { PmaContext } from '../../core/context.ts';

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Core::previewSQL(). */
export function previewSql(context: PmaContext, queries: string | string[]): void {
	let html = '<div class="preview_sql">';
	const list = Array.isArray(queries) ? queries : [queries];
	if (list.length === 0 || (list.length === 1 && (list[0] === '' || list[0] === '0'))) {
		html += 'No change';
	} else {
		for (const query of list) {
			html += formatSql(query);
		}
	}
	html += '</div>';
	context.response.addJSON('sql_data', html);
}

/** Generator::mysqlDie() with exit: the error box becomes the page or the AJAX error. */
export async function mysqlDie(context: PmaContext, error: DbiQueryError): Promise<Response> {
	const { response } = context;
	const html = mysqlDieHtmlFor(context, error.formatted, error.query);
	if (response.isAjax) {
		response.setRequestStatus(false);
		response.addJSON('message', html);
	} else {
		response.addHTML(html);
	}
	return response.response();
}

// SaveController::columnNeedsAlterTable(), which also fills in the unticked checkboxes.
function columnNeedsAlterTable(post: PhpArray, index: number): boolean {
	for (const [name, fallback] of [['field_null', 'NO'], ['field_extra', '']]) {
		const list = (post[name] ?? {}) as PhpArray;
		post[name] = list;
		list[index] ??= fallback;
	}
	if (text(phpGet(post, 'field_name', index)) !== text(phpGet(post, 'field_orig', index))) {
		return true;
	}
	const fields = ['field_attribute', 'field_collation', 'field_comments', 'field_default_value', 'field_default_type', 'field_extra', 'field_length', 'field_null', 'field_type', 'field_virtuality'];
	for (const field of fields) {
		if (text(phpGet(post, field, index)) !== text(phpGet(post, `${field}_orig`, index))) {
			return true;
		}
	}
	const moveTo = text(phpGet(post, 'field_move_to', index));
	return moveTo !== '' && moveTo !== '0';
}

function alterClause(context: PmaContext, post: PhpArray, index: number, suffix: '' | '_orig', columnsWithIndex: string[] | null): string {
	const field = (name: string): string => text(phpGet(post, `${name}${suffix}`, index));
	const extra = valueByKey(post, `field_extra${suffix}.${index}`, null);
	return `CHANGE ${generateAlter(text(valueByKey(post, `field_orig.${index}`, '')), {
		name: text(phpGet(post, 'field_name', index)),
		type: field('field_type'),
		length: field('field_length'),
		attribute: field('field_attribute'),
		collation: text(valueByKey(post, `field_collation${suffix}.${index}`, '')),
		nullable: text(valueByKey(post, `field_null${suffix}.${index}`, 'NO')),
		defaultType: field('field_default_type'),
		defaultValue: field('field_default_value'),
		extra: extra === null ? false : text(extra),
		comment: text(valueByKey(post, `field_comments${suffix}.${index}`, '')),
		virtuality: text(valueByKey(post, `field_virtuality${suffix}.${index}`, '')),
		expression: text(valueByKey(post, `field_expression${suffix}.${index}`, '')),
		moveTo: text(valueByKey(post, `field_move_to${suffix}.${index}`, '')),
		columnsWithIndex,
	}, serverKind(context))}`;
}

/** SaveController::adjustColumnPrivileges(). */
async function adjustColumnPrivileges(context: PmaContext, renames: Map<string, string>): Promise<boolean> {
	const { dbi } = context;
	const privileges = await dbi.getUserPrivileges();
	if (!privileges.colPriv || !privileges.isReloadPriv) {
		return false;
	}
	await dbi.selectDb('mysql');
	for (const [oldColumn, newColumn] of renames) {
		await dbi.query(`UPDATE ${backquote('columns_priv')} SET Column_name = "${newColumn}"
                        WHERE Db = "${context.db}"
                        AND Table_name = "${context.table}"
                        AND Column_name = "${oldColumn}";`);
	}
	if (renames.size > 0) {
		await dbi.query('FLUSH PRIVILEGES;');
	}
	return renames.size > 0;
}

/** SaveController::updateColumns(): a Response when upstream exits, else whether the form must be shown again. */
async function updateColumns(context: PmaContext): Promise<Response | boolean> {
	const { dbi, response } = context;
	const post = nestedParams(context.request.post);
	const tableObject = Table.get(context, context.table, context.db);
	const fieldNames = post.field_name;
	const fieldCount = typeof fieldNames === 'object' ? Object.keys(fieldNames).length : 0;
	const changes: string[] = [];
	const renames = new Map<string, string>();
	const primaryOrUnique = await getColumnsWithIndex(context, context.table, context.db, INDEX_PRIMARY | INDEX_UNIQUE);
	for (let index = 0; index < fieldCount; index++) {
		if (!columnNeedsAlterTable(post, index)) {
			continue;
		}
		changes.push(alterClause(context, post, index, '', primaryOrUnique));
		const sorted = await tableObject.getUiProp(PROP_SORTED_COLUMN);
		const original = text(phpGet(post, 'field_orig', index));
		if (typeof sorted === 'string' && sorted.includes(backquote(original))) {
			tableObject.removeUiProp(PROP_SORTED_COLUMN);
		}
		const adjust = text(phpGet(post, 'field_adjust_privileges', index));
		const newName = text(phpGet(post, 'field_name', index));
		if (adjust !== '' && adjust !== '0' && original !== newName) {
			renames.set(original, newName);
		}
	}

	let regenerate = false;
	if (changes.length === 0 && post.preview_sql === undefined) {
		return regenerate;
	}
	await dbi.selectDb(context.db);
	let sqlQuery = `ALTER TABLE ${backquote(context.table)} ${changes.join(', ')}`;
	if (post.online_transaction !== undefined) {
		sqlQuery += ', ALGORITHM=INPLACE, LOCK=NONE';
	}
	sqlQuery += ';';
	if (post.preview_sql !== undefined) {
		previewSql(context, changes.length > 0 ? sqlQuery : '');
		return response.response();
	}

	const allIndexed = await getColumnsWithIndex(context, context.table, context.db, INDEX_PRIMARY | INDEX_UNIQUE | INDEX_INDEX | INDEX_SPATIAL | INDEX_FULLTEXT);
	const changedToBlob: boolean[] = [];
	for (let index = 0; index < fieldCount; index++) {
		const collation = phpGet(post, 'field_collation', index);
		const original = text(phpGet(post, 'field_orig', index));
		const originalCollation = phpGet(post, 'field_collation_orig', index);
		if (collation === undefined || originalCollation === undefined || collation === originalCollation || allIndexed.includes(original)) {
			changedToBlob[index] = false;
			continue;
		}
		const originalType = text(phpGet(post, 'field_type_orig', index));
		let blobType = 'BLOB';
		if (originalType === 'MEDIUMTEXT') {
			blobType = 'MEDIUMBLOB';
		} else if (originalType === 'LONGTEXT') {
			blobType = 'LONGBLOB';
		}
		let secondary = `ALTER TABLE ${backquote(context.table)} CHANGE ${backquote(original)} ${backquote(original)} ${blobType}`;
		const virtuality = phpGet(post, 'field_virtuality', index);
		const expression = phpGet(post, 'field_expression', index);
		if (virtuality !== undefined && expression !== undefined && text(virtuality) !== '' && text(virtuality) !== '0') {
			secondary += ` AS (${text(expression)}) ${text(virtuality)}`;
		}
		secondary += ';';
		await dbi.query(secondary);
		changedToBlob[index] = true;
	}

	const result = await dbi.tryQuery(sqlQuery);
	if (result !== false) {
		const adjusted = await adjustColumnPrivileges(context, renames);
		const message = Message.success(adjusted ? 'Table %1$s has been altered successfully. Privileges have been adjusted.' : 'Table %1$s has been altered successfully.');
		message.addParam(context.table);
		response.addHTML(await getMessage(context, message, { sqlQuery, type: 'success' }));
	} else {
		const originalError = dbi.getError();
		const reverts: string[] = [];
		for (let index = 0; index < fieldCount; index++) {
			if (changedToBlob[index]) {
				reverts.push(alterClause(context, post, index, '_orig', null));
			}
		}
		await dbi.query(`ALTER TABLE ${backquote(context.table)} ${reverts.join(', ')};`);
		response.setRequestStatus(false);
		response.addHTML(await getMessage(context, Message.rawError(`Query error:<br>${originalError}`), { sqlQuery, type: 'error' }));
		regenerate = true;
	}
	return regenerate;
}

export async function saveController(context: PmaContext): Promise<Response> {
	let updated: Response | boolean;
	try {
		updated = await updateColumns(context);
	} catch (error) {
		if (!(error instanceof DbiQueryError)) {
			throw error;
		}
		return mysqlDie(context, error);
	}
	if (updated instanceof Response) {
		return updated;
	}
	return structureController(context);
}

export const controllers = { 'Table/Structure/SaveController': async (context: PmaContext) => withMysqlDie(context, async () => saveController(context)) };

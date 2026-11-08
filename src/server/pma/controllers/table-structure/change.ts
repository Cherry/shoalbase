// Port of Controllers\Table\Structure\ChangeController (route /table/structure/change): the edit form for one or more columns.
import { columnsFormData, getColumn } from './columns-definition.ts';
import { render } from './common.ts';
import { Message } from '../../../../lib/pma/message.ts';
import { getFromRoute } from '../../../../lib/twig/url.ts';

import type { PmaContext } from '../../core/context.ts';
import type { DbiRow } from '../../core/dbi.ts';

/** ChangeController::displayHtmlForColumnChange(). */
export async function displayColumnChange(context: PmaContext, selected: string[] | null): Promise<Response> {
	const { dbi, response } = context;
	let columns = selected;
	if (columns === null || columns.length === 0) {
		const field = context.request.params.field;
		columns = [typeof field === 'string' ? field : ''];
	}
	const fieldsMeta: DbiRow[] = [];
	for (const column of columns) {
		const value = await getColumn(context, context.db, context.table, column, true);
		if (value === null) {
			const message = Message.error('Failed to get description of column %s!');
			message.addParam(column);
			response.addHTML(message.getDisplay());
		} else {
			fieldsMeta.push(value);
		}
	}
	await dbi.getUserPrivileges();
	response.addScriptFiles(['vendor/jquery/jquery.uitablefilter.js', 'indexes.js']);
	const data = await columnsFormData(context, {
		action: getFromRoute(context.urlState(), '/table/structure/save'),
		numFields: fieldsMeta.length,
		selected: columns,
		fieldsMeta,
	});
	response.addHTML(await render(context, 'columns_definitions/column_definitions_form', data));
	return response.response();
}

export async function changeController(context: PmaContext): Promise<Response> {
	const { response } = context;
	if (context.request.query.change_column !== undefined) {
		return displayColumnChange(context, null);
	}
	const selected = context.request.post.selected_fld;
	const list = Array.isArray(selected) ? selected : [];
	if (list.length === 0) {
		response.setRequestStatus(false);
		response.addJSON('message', 'No column selected.');
		return response.response();
	}
	return displayColumnChange(context, list);
}

export const controllers = { 'Table/Structure/ChangeController': changeController };

// BrowseForeignersController: the dialog listing the values a foreign key column may take.
import { type ForeignCell, foreignRows } from '../../../../lib/pma/misc/browse-foreigners.ts';
import { pageSelector } from '../../../../lib/pma/navigation-html.ts';
import { themeImagePath } from '../../../../lib/twig/html.ts';
import { htmlspecialchars } from '../../../../lib/twig/php.ts';
import { getFromRoute, getHiddenInputs } from '../../../../lib/twig/url.ts';
import { renderTemplate } from '../../../twig/render.ts';
import { type ForeignData, getForeignData, getForeigners } from '../table-data/relation.ts';

import type { TemplateStateInput } from '../../../twig/state.ts';
import type { PmaContext } from '../../core/context.ts';

const HEADER = `<tr>
            <th>Keyname</th>
            <th>Description</th>
            <td width="20%"></td>
            <th>Description</th>
            <th>Keyname</th>
        </tr>`;

const text = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

/** BrowseForeigners::getHtmlForGotoPage(): a page selector once there are more rows than MaxRows. */
function gotoPage(context: PmaContext, foreignData: ForeignData): string {
	const maxRows = Math.trunc(Number(context.config.MaxRows));
	const total = Number(foreignData.the_total ?? 0);
	if (foreignData.disp_row === null || total <= maxRows) {
		return '';
	}
	const pageNow = Math.floor(Number(text(context.request.post.pos, '0')) / maxRows) + 1;
	return `Page number:${pageSelector('pos', maxRows, pageNow, Math.ceil(total / maxRows))}`;
}

async function columnElement(cell: ForeignCell, nowrap: boolean, state: TemplateStateInput): Promise<string> {
	return renderTemplate('table/browse_foreigners/column_element', { ...cell, nowrap }, state);
}

/** BrowseForeigners::getHtmlForRelationalFieldSelection(). */
async function relationalFieldSelection(context: PmaContext, field: string, foreignData: ForeignData, state: TemplateStateInput): Promise<string> {
	const { config, request } = context;
	const { post } = request;
	const maxRows = Math.trunc(Number(config.MaxRows));
	const showAll = await renderTemplate('table/browse_foreigners/show_all', { foreign_data: foreignData, show_all: Boolean(config.ShowAll), max_rows: maxRows }, state);
	const filterValue = post.foreign_filter === undefined ? '' : htmlspecialchars(post.foreign_filter);
	let output = `<form class="ajax" id="browse_foreign_form" name="browse_foreign_from" action="${getFromRoute(context.urlState(), '/browse-foreigners')}" method="post">`
		+ `<fieldset class="row g-3 align-items-center mb-3">${getHiddenInputs(context.urlState(), context.db, context.table)}`
		+ `<input type="hidden" name="field" value="${htmlspecialchars(field)}"><input type="hidden" name="fieldkey" value="${htmlspecialchars(text(post.fieldkey))}">`;
	if (post.rownumber !== undefined) {
		output += `<input type="hidden" name="rownumber" value="${htmlspecialchars(post.rownumber)}">`;
	}
	output += '<div class="col-auto"><label class="form-label" for="input_foreign_filter">Search:</label></div>'
		+ `<div class="col-auto"><input class="form-control" type="text" name="foreign_filter" id="input_foreign_filter" value="${filterValue}" data-old="${filterValue}">`
		+ '</div><div class="col-auto"><input class="btn btn-primary" type="submit" name="submit_foreign_filter" value="Go"></div>'
		+ `<div class="col-auto">${gotoPage(context, foreignData)}</div><div class="col-auto">${showAll}</div></fieldset></form>`
		+ '<table class="table table-striped table-hover" id="browse_foreign_table">';
	if (foreignData.disp_row === null) {
		return `${output}</tbody></table>`;
	}
	output += `<thead>${HEADER}</thead>\n<tfoot>${HEADER}</tfoot>\n<tbody>\n`;
	const spacer = themeImagePath(state.themeImages ?? new Set(), state.themeImgPath ?? '', 'spacer.png');
	const rows = foreignRows({
		dispRow: foreignData.disp_row,
		foreignField: foreignData.foreign_field ?? '',
		foreignDisplay: foreignData.foreign_display,
		currentValue: text(post.data),
		limitChars: Math.trunc(Number(config.LimitChars)),
		repeatCells: Math.trunc(Number(config.RepeatCells)),
	});
	for (const row of rows) {
		if (row.repeatHeader) {
			output += HEADER;
		}
		output += '<tr class="noclick">'
			+ await columnElement(row.left, true, state)
			+ await columnElement(row.left, false, state)
			+ `<td width="20%"><img src="${spacer}" alt="" width="1" height="1"></td>`
			+ await columnElement(row.right, false, state)
			+ await columnElement(row.right, true, state)
			+ '</tr>';
	}
	return `${output}</tbody></table>`;
}

export async function browseForeignersController(context: PmaContext): Promise<Response> {
	const { config, request, response } = context;
	const { db, table, field } = request.post;
	if (typeof db !== 'string' || typeof table !== 'string' || typeof field !== 'string') {
		return response.response();
	}
	response.setMinimal();
	response.disableMenuAndConsole();
	response.setBodyId('body_browse_foreigners');
	const foreigners = await getForeigners(context, db, table);
	// BrowseForeigners::getForeignLimit(): pos goes into the LIMIT clause as sent.
	let foreignLimit = `LIMIT ${text(request.post.pos, '0')}, ${Math.trunc(Number(config.MaxRows))} `;
	if (request.post.foreign_showAll === 'Show all') {
		foreignLimit = '';
	}
	const foreignData = await getForeignData(context, foreigners, field, true, text(request.post.foreign_filter), foreignLimit, true);
	response.addHTML(await relationalFieldSelection(context, field, foreignData, await context.templateState()));
	return response.response();
}

export const controllers = {
	BrowseForeignersController: browseForeignersController,
};

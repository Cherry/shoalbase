// Ports of Server\Status\ProcessesController and its Refresh and Kill AJAX siblings.
import { selectMysqlForSuperUser } from './info-pages.ts';
import { withMysqlDie } from './mysql-die.ts';
import { renderServerTemplate } from './render.ts';
import { loadStatusData } from './status-data.ts';
import { Message } from '../../../../lib/pma/message.ts';
import { phpEmpty, phpInt } from '../../../../lib/pma/server/php.ts';
import { processListQuery, processRow, sortableColumns } from '../../../../lib/pma/server/processes.ts';

import type { PmaContext } from '../../core/context.ts';
import type { ControllerContext } from '../../dispatcher.ts';

const PARAM_NAMES = ['showExecuting', 'full', 'column_name', 'order_by_field', 'sort_order'];

function postedParams(context: PmaContext): Record<string, unknown> {
	return Object.fromEntries(PARAM_NAMES.map(name => [name, context.request.post[name] ?? null]));
}

/** Processes::getList(). */
async function processList(context: PmaContext, params: Record<string, unknown>): Promise<Record<string, unknown>> {
	const { dbi, config } = context;
	const query = processListQuery(params);
	const result = await dbi.query(query.sql);
	const rows = result.fetchAllAssoc().map(row => processRow(row, query.useIS, query.showFullSql, config.MaxCharactersInDisplayedSQL));
	return {
		columns: sortableColumns(query.showFullSql, params, dbi.isMariaDB()),
		rows,
		refresh_params: query.refreshParams,
		is_mariadb: dbi.isMariaDB(),
	};
}

export async function processesController(context: PmaContext): Promise<Response> {
	// The controller is built with the status Data, which runs its queries first.
	await loadStatusData(context);
	return withMysqlDie(context, async () => {
		const params = postedParams(context);
		await selectMysqlForSuperUser(context);
		context.response.addScriptFiles(['server/status/processes.js']);
		const urlParams = {
			ajax_request: true,
			full: params.full ?? '',
			column_name: params.column_name ?? '',
			order_by_field: params.order_by_field ?? '',
			sort_order: params.sort_order ?? '',
		};
		const listHtml = await renderServerTemplate(context, 'server/status/processes/list', await processList(context, params));
		context.response.addHTML(await renderServerTemplate(context, 'server/status/processes/index', {
			url_params: urlParams,
			is_checked: !phpEmpty(params.showExecuting),
			server_process_list: listHtml,
		}));
		return context.response.response();
	});
}

export async function refreshProcessesController(context: PmaContext): Promise<Response> {
	await loadStatusData(context);
	const params = postedParams(context);
	if (!context.response.isAjax) {
		return context.response.response();
	}
	return withMysqlDie(context, async () => {
		context.response.addHTML(await renderServerTemplate(context, 'server/status/processes/list', await processList(context, params)));
		return context.response.response();
	});
}

/** DatabaseInterface::isAmazonRds(). */
async function isAmazonRds(context: PmaContext): Promise<boolean> {
	const basedir = await context.dbi.fetchValue('SELECT @@basedir');
	return typeof basedir === 'string' && basedir.startsWith('/rdsdbbin/');
}

export async function killProcessController(context: ControllerContext): Promise<Response> {
	const { dbi, response } = context;
	await loadStatusData(context);
	if (!response.isAjax) {
		return response.response();
	}
	const kill = phpInt(context.params.id);
	let query = `KILL ${kill};`;
	if (await dbi.isSuperUser() && await isAmazonRds(context)) {
		query = `CALL mysql.rds_kill(${kill});`;
	}
	let message: Message;
	if (await dbi.tryQuery(query) === false) {
		message = Message.error('phpMyAdmin was unable to kill thread %s. It probably has already been closed.');
		response.setRequestStatus(false);
	} else {
		message = Message.success('Thread %s was successfully killed.');
		response.setRequestStatus(true);
	}
	message.addParam(kill);
	response.addJSON({ message });
	return response.response();
}

export const controllers = {
	'Server/Status/ProcessesController': processesController,
	'Server/Status/Processes/RefreshController': refreshProcessesController,
	'Server/Status/Processes/KillController': killProcessController,
};

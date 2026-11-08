// Ports of Controllers\Table\Maintenance\* (routes /table/maintenance/*): ANALYZE, CHECK, CHECKSUM, OPTIMIZE and REPAIR on the selected tables.
import { render } from './common.ts';
import { Message } from '../../../../lib/pma/message.ts';
import {
	groupMaintenanceRows,
	isSelectedTableList,
	nameAssertionError,
	warningToString,
} from '../../../../lib/pma/table-structure/maintenance.ts';
import { htmlspecialchars } from '../../../../lib/twig/php.ts';
import { backquote } from '../../../../lib/twig/sanitize.ts';
import { getMessage } from '../../core/generator.ts';
import { findDuplicates } from '../../core/index.ts';

import type { PmaContext } from '../../core/context.ts';
import type { DbiRow } from '../../core/dbi.ts';

type Operation = 'analyze' | 'check' | 'checksum' | 'optimize' | 'repair';

/** The shared validation of every maintenance controller; returns the response when it fails. */
async function validate(context: PmaContext): Promise<Response | { db: string; tables: string[]; }> {
	const { response } = context;
	const selected = context.request.post.selected_tbl;
	if (!isSelectedTableList(selected)) {
		response.setRequestStatus(false);
		response.addJSON('message', 'No table selected.');
		return response.response();
	}
	const db = context.request.params.db;
	for (const value of [db, ...selected]) {
		const error = nameAssertionError(value);
		if (error !== null) {
			response.setRequestStatus(false);
			response.addJSON('message', Message.error(error).getDisplay());
			return response.response();
		}
	}
	if (context.config.DisableMultiTableMaintenance && selected.length > 1) {
		response.setRequestStatus(false);
		response.addJSON('message', 'Maintenance operations on multiple tables are disabled.');
		return response.response();
	}
	return { db: db as string, tables: selected };
}

/** Maintenance::getIndexesProblems(). */
async function indexesProblems(context: PmaContext, db: string, tables: string[]): Promise<string> {
	let html = '';
	for (const table of tables) {
		const check = await findDuplicates(context, table, db);
		if (check === '') {
			continue;
		}
		html += htmlspecialchars(`Problems with indexes of table \`${table}\``);
		html += check;
	}
	return html;
}

function maintenanceController(operation: Operation) {
	return async (context: PmaContext): Promise<Response> => {
		const validated = await validate(context);
		if (validated instanceof Response) {
			return validated;
		}
		const { db, tables } = validated;
		const { dbi } = context;
		const query = `${operation.toUpperCase()} TABLE ${tables.map(table => backquote(table)).join(', ')};`;
		await dbi.selectDb(db);
		const rows = await dbi.fetchResult(query) as DbiRow[];
		const variables: Record<string, unknown> = {
			message: await getMessage(context, 'Your SQL query has been executed successfully.', { sqlQuery: query, type: 'success' }),
		};
		if (operation === 'checksum') {
			variables.rows = rows;
			const warnings = await dbi.getWarnings();
			variables.warnings = warnings.map(warning => warningToString(warning));
		} else {
			variables.rows = groupMaintenanceRows(rows);
		}
		if (operation === 'check') {
			variables.indexes_problems = await indexesProblems(context, db, tables);
		}
		context.response.addHTML(await render(context, `table/maintenance/${operation}`, variables));
		return context.response.response();
	};
}

export const controllers = {
	'Table/Maintenance/AnalyzeController': maintenanceController('analyze'),
	'Table/Maintenance/CheckController': maintenanceController('check'),
	'Table/Maintenance/ChecksumController': maintenanceController('checksum'),
	'Table/Maintenance/OptimizeController': maintenanceController('optimize'),
	'Table/Maintenance/RepairController': maintenanceController('repair'),
};

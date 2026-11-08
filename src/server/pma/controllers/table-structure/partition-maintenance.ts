// Ports of Controllers\Table\Partition\* (routes /table/partition/*): ALTER TABLE ... <operation> PARTITION on one partition.
import { render } from './common.ts';
import { Message } from '../../../../lib/pma/message.ts';
import { nameAssertionError } from '../../../../lib/pma/table-structure/maintenance.ts';
import { backquote } from '../../../../lib/twig/sanitize.ts';
import { getMessage } from '../../core/generator.ts';
import { Table } from '../../core/table.ts';

import type { PmaContext } from '../../core/context.ts';
import type { DbiRow } from '../../core/dbi.ts';

type Operation = 'analyze' | 'check' | 'drop' | 'optimize' | 'rebuild' | 'repair' | 'truncate';

// These return result rows; the others only report whether the statement succeeded.
const ROW_OPERATIONS = new Set<Operation>(['analyze', 'check', 'optimize', 'repair']);

/** Partitioning\Maintenance::<operation>(): the query, plus the rows grouped by table or the success flag. */
async function runOperation(context: PmaContext, operation: Operation, db: string, table: string, partition: string): Promise<{ query: string; rows?: Map<string, DbiRow[]>; result?: boolean; }> {
	const { dbi } = context;
	if (operation === 'truncate' && await Table.get(context, table, db).isView()) {
		return { query: 'This table is a view, it can not be truncated.', result: false };
	}
	const query = `ALTER TABLE ${backquote(table)} ${operation.toUpperCase()} PARTITION ${backquote(partition)};`;
	await dbi.selectDb(db);
	if (!ROW_OPERATIONS.has(operation)) {
		return { query, result: await dbi.tryQuery(query) !== false };
	}
	const rows = new Map<string, DbiRow[]>();
	for (const row of await dbi.fetchResult(query) as DbiRow[]) {
		const name = row.Table ?? '';
		rows.set(name, [...rows.get(name) ?? [], row]);
	}
	return { query, rows };
}

function partitionController(operation: Operation) {
	return async (context: PmaContext): Promise<Response> => {
		const { response } = context;
		const partitionName = context.request.post.partition_name;
		const db = context.request.params.db;
		const table = context.request.params.table;
		let error: string | null;
		if (typeof partitionName !== 'string') {
			error = nameAssertionError(partitionName);
		} else if (partitionName === '') {
			error = 'Expected a different value than "".';
		} else {
			error = nameAssertionError(db) ?? nameAssertionError(table);
		}
		if (error !== null) {
			response.addHTML(Message.error(error).getDisplay());
			return response.response();
		}
		const outcome = await runOperation(context, operation, db as string, table as string, partitionName as string);
		let message: string;
		if (outcome.result === false) {
			message = await getMessage(context, 'Error', { sqlQuery: outcome.query, type: 'error' });
		} else {
			message = await getMessage(context, 'Your SQL query has been executed successfully.', { sqlQuery: outcome.query, type: 'success' });
		}
		const variables: Record<string, unknown> = { partition_name: partitionName, message };
		if (outcome.rows !== undefined) {
			variables.rows = outcome.rows;
		}
		response.addHTML(await render(context, `table/partition/${operation}`, variables));
		return response.response();
	};
}

export const controllers = {
	'Table/Partition/AnalyzeController': partitionController('analyze'),
	'Table/Partition/CheckController': partitionController('check'),
	'Table/Partition/DropController': partitionController('drop'),
	'Table/Partition/OptimizeController': partitionController('optimize'),
	'Table/Partition/RebuildController': partitionController('rebuild'),
	'Table/Partition/RepairController': partitionController('repair'),
	'Table/Partition/TruncateController': partitionController('truncate'),
};

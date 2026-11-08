// The request data the schema exporters read: $_POST arrays and $_REQUEST flags.
import { type PhpArray, nestedParams } from '../../../lib/pma/table-data/php-params.ts';

import type { PmaContext } from '../core/context.ts';

export interface SchemaRequest {
	context: PmaContext;
	post: PhpArray;
	db: string;
	/** isset($_REQUEST[$name]). */
	has: (name: string) => boolean;
	/** (string) $_REQUEST[$name]. */
	string: (name: string) => string;
	/** (int) $_REQUEST['page_number']. */
	pageNumber: number;
	offline: boolean;
}

export function schemaRequest(context: PmaContext, db: string): SchemaRequest {
	const { params } = context.request;
	const value = (name: string): string => {
		const item = params[name];
		if (typeof item === 'string') {
			return item;
		}
		return item === undefined ? '' : 'Array';
	};
	const pageMatch = /^[\t\n\v\f\r ]*[+-]?\d+/.exec(value('page_number'));
	return {
		context,
		post: nestedParams(context.request.post),
		db,
		has: name => params[name] !== undefined,
		string: value,
		pageNumber: pageMatch === null ? 0 : Number.parseInt(pageMatch[0], 10),
		offline: params.offline_export !== undefined,
	};
}

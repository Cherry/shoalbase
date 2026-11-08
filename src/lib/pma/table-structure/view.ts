// The CREATE/ALTER VIEW statement View\CreateController builds from the posted view[...] fields.
import { backquote } from '../../twig/sanitize.ts';

import type { PhpArray } from '../table-data/php-params.ts';

const ALGORITHMS = new Set(['UNDEFINED', 'MERGE', 'TEMPTABLE']);
const WITH_OPTIONS = new Set(['CASCADED', 'LOCAL']);
const SECURITY_OPTIONS = new Set(['DEFINER', 'INVOKER']);
const SEPARATOR = '\r\n';

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const isEmpty = (value: unknown): boolean => [undefined, '', '0'].includes(value as never);

/** CreateController::__invoke()'s statement for createview (true) or alterview (false). */
export function createViewQuery(view: PhpArray, create: boolean): string {
	let sql = 'ALTER';
	if (create) {
		sql = view.or_replace === undefined ? 'CREATE' : 'CREATE OR REPLACE';
	}
	if (ALGORITHMS.has(text(view.algorithm))) {
		sql += `${SEPARATOR} ALGORITHM = ${text(view.algorithm)}`;
	}
	const definer = text(view.definer);
	if (!isEmpty(view.definer)) {
		if (definer.includes('@')) {
			const [user, host] = definer.split('@', 2);
			sql += `${SEPARATOR}DEFINER=${backquote(user)}@${backquote(host)} `;
		} else {
			sql += `${SEPARATOR}DEFINER=${backquote(definer)}`;
		}
	}
	if (SECURITY_OPTIONS.has(text(view.sql_security))) {
		sql += `${SEPARATOR} SQL SECURITY ${text(view.sql_security)}`;
	}
	sql += `${SEPARATOR} VIEW ${backquote(text(view.name))}`;
	if (!isEmpty(view.column_names)) {
		sql += `${SEPARATOR} (${text(view.column_names)})`;
	}
	sql += `${SEPARATOR} AS ${text(view.as)}`;
	if (WITH_OPTIONS.has(text(view.with))) {
		sql += `${SEPARATOR} WITH ${text(view.with)}  CHECK OPTION`;
	}
	return sql;
}

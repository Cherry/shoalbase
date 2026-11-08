// Pure parts of ConfigStorage\Relation used by insert/edit and search: foreign key lookup and the foreign value drop-down.
import { htmlspecialchars } from '../../twig/php.ts';
import { isNumericString, strnatcasecmp } from '../php-compare.ts';

import type { ForeignKey } from '../../../sql-parser/index.ts';

export interface Foreigner {
	foreign_field: string;
	foreign_db: string;
	foreign_table: string;
	constraint?: unknown;
	on_update?: string;
	on_delete?: string;
}

/** Relation::getForeigners() without pmadb: only the InnoDB keys from SHOW CREATE TABLE, plus the emulated internal relations. */
export interface Foreigners {
	foreign_keys_data?: ForeignKey[];
	[column: string]: Foreigner | ForeignKey[] | undefined;
}

/** PHP's loose == between two strings: numeric strings compare as numbers. */
export function looseEquals(left: string, right: string): boolean {
	if (isNumericString(left) && isNumericString(right)) {
		return Number(left) === Number(right);
	}
	return left === right;
}

/** Relation::searchColumnInForeigners(). */
export function searchColumnInForeigners(foreigners: Foreigners, column: string, currentDb: string): Foreigner | false {
	if (column !== 'foreign_keys_data' && foreigners[column] !== undefined) {
		return foreigners[column] as Foreigner;
	}
	if (foreigners.foreign_keys_data === undefined) {
		return false;
	}
	for (const key of foreigners.foreign_keys_data) {
		// array_search() compares loosely; column names are never numeric-equal in practice, so strict equality is enough.
		const index = key.index_list.findIndex(name => String(name) === column);
		if (index !== -1) {
			const foreigner: Foreigner = {
				foreign_field: String(key.ref_index_list?.[index] ?? ''),
				foreign_db: String(key.ref_db_name ?? currentDb),
				foreign_table: String(key.ref_table_name ?? ''),
				constraint: key.constraint,
				on_update: key.on_update ?? 'RESTRICT',
				on_delete: key.on_delete ?? 'RESTRICT',
			};
			return foreigner;
		}
	}
	return false;
}

export interface DropdownConfig {
	NaturalOrder: boolean;
	LimitChars: number;
	ForeignKeyMaxLimit: number;
	ForeignKeyDropdownOrder?: unknown;
}

// The u-modified pattern Relation uses to decide whether a value can be shown as text.
// eslint-disable-next-line no-control-regex -- matching control characters is the point of this pattern.
const CONTROL_CHARACTERS = /[\u{0}-\u{8}\v\f\u{E}-\u{1F}\u{80}-\u{9F}]/u;

function isPrintable(value: string): boolean {
	return !value.includes('�') && !CONTROL_CHARACTERS.test(value);
}

function bin2hex(value: string): string {
	return [...new TextEncoder().encode(value)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function compareKeys(left: string, right: string, natural: boolean): number {
	if (natural) {
		return strnatcasecmp(left, right);
	}
	// ksort() orders integer keys numerically before string keys compared bytewise.
	if (isNumericString(left) && isNumericString(right)) {
		return Math.sign(Number(left) - Number(right));
	}
	if (left < right) {
		return -1;
	}
	return Number(left > right);
}

/** Relation::buildForeignDropdown(). */
export function buildForeignDropdown(foreign: [string, string][], data: string, mode: string, config: DropdownConfig): string[] {
	let entries = foreign;
	if (mode === 'id-content' || mode === 'id-only') {
		entries = foreign.toSorted(([left], [right]) => compareKeys(left, right, config.NaturalOrder));
	} else if (mode === 'content-id') {
		entries = foreign.toSorted(([, left], [, right]) => compareKeys(left, right, config.NaturalOrder));
	}

	const options: string[] = [];
	for (const [rawKey, rawValue] of entries) {
		let key: string;
		let selected: boolean;
		if (isPrintable(rawKey)) {
			selected = looseEquals(rawKey, data);
			key = htmlspecialchars(rawKey);
		} else {
			key = `0x${bin2hex(rawKey)}`;
			if (data.includes('0x')) {
				selected = key === data.trim();
			} else {
				selected = key === `0x${data}`;
			}
		}

		let value: string;
		if (!isPrintable(rawValue)) {
			value = `0x${bin2hex(rawValue)}`;
		} else if ([...rawValue].length <= config.LimitChars) {
			value = htmlspecialchars(rawValue);
		} else {
			value = htmlspecialchars(`${[...rawValue].slice(0, config.LimitChars).join('')}...`);
		}

		const option = `<option value="${key}"${selected ? ' selected="selected"' : ''}>`;
		if (mode === 'content-id') {
			options.push(`${option}${value}&nbsp;-&nbsp;${key}</option>`);
		} else if (mode === 'id-content') {
			options.push(`${option}${key}&nbsp;-&nbsp;${value}</option>`);
		} else if (mode === 'id-only') {
			options.push(`${option}${key}</option>`);
		}
	}
	return options;
}

function dropdownOrder(order: unknown, index: number): string {
	let value: unknown;
	if (Array.isArray(order)) {
		value = order[index];
	} else if (order !== null && typeof order === 'object') {
		value = (order as Record<string, unknown>)[index];
	}
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	return '';
}

/** Relation::foreignDropdown(); rows are the foreign table rows as fetched, keyed by column name. */
export function foreignDropdown(dispRow: Record<string, string | null>[], foreignField: string, foreignDisplay: string, data: unknown, config: DropdownConfig, max: number | null = null): string {
	const limit = max ?? config.ForeignKeyMaxLimit;
	// PHP array semantics: a repeated key keeps its first position but takes the last value.
	const foreign = new Map<string, string>();
	for (const row of dispRow) {
		foreign.set(row[foreignField] ?? '', foreignDisplay === '' ? '' : (row[foreignDisplay] ?? ''));
	}
	const entries = [...foreign];
	const current = data === null || data === undefined ? '' : String(data);

	let top: string[] = [];
	let bottom: string[] = [];
	if (foreignDisplay === '') {
		top = buildForeignDropdown(entries, current, 'id-only', config);
	} else if (config.ForeignKeyDropdownOrder !== null && typeof config.ForeignKeyDropdownOrder === 'object') {
		const first = dropdownOrder(config.ForeignKeyDropdownOrder, 0);
		const second = dropdownOrder(config.ForeignKeyDropdownOrder, 1);
		if (first !== '') {
			top = buildForeignDropdown(entries, current, first, config);
		}
		if (second !== '') {
			bottom = buildForeignDropdown(entries, current, second, config);
		}
	} else {
		top = buildForeignDropdown(entries, current, 'id-content', config);
		bottom = buildForeignDropdown(entries, current, 'content-id', config);
	}

	let html = '<option value="">&nbsp;</option>';
	if (limit === -1 || top.length < limit) {
		html += top.join('');
		if (foreignDisplay !== '' && top.length > 0) {
			html += '<option value="">&nbsp;</option>';
		}
	}
	if (foreignDisplay !== '') {
		html += bottom.join('');
	}
	return html;
}

// Port of Partitioning\TablePartitionDefinition::getDetails(): the partition form state rebuilt from the POSTed values.
import { type PhpArray, type PhpValue, phpArray } from '../table-data/php-params.ts';

export type PartitionFields = Record<string, unknown>;

export interface PartitionDetails {
	partition_by: PhpValue | null;
	partition_expr: PhpValue | null;
	subpartition_by: PhpValue | null;
	subpartition_expr: PhpValue | null;
	partition_count: number;
	subpartition_count: number;
	can_have_subpartitions: boolean;
	value_enabled: boolean;
	partitions?: PartitionFields[];
}

const RANGE_OR_LIST = new Set(['RANGE', 'RANGE COLUMNS', 'LIST', 'LIST COLUMNS']);

const BLANK_STORAGE = {
	engine: '',
	comment: '',
	data_directory: '',
	index_directory: '',
	max_rows: '',
	min_rows: '',
	tablespace: '',
	node_group: '',
};

// is_numeric() for a request value: optional sign, digits with an optional fraction or exponent, leading spaces allowed.
function isNumeric(value: PhpValue | undefined): value is string {
	return typeof value === 'string' && /^[ \t\n\r\v\f]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?[ \t\n\r\v\f]*$/i.test(value);
}

function partitionCount(post: PhpArray, name: string): number {
	const value = post[name];
	if (!isNumeric(value)) {
		return 0;
	}
	return Math.min(Math.trunc(Number(value)), 8192);
}

// array_splice($list, $count) on a PHP list, keeping the first entries in key order.
function listOf(value: PhpValue | undefined, count: number): PartitionFields[] {
	const array = phpArray(value);
	if (array === undefined) {
		return [];
	}
	return Object.values(array).slice(0, Math.max(count, 0)).map((item) => { return { ...phpArray(item) }; });
}

function subpartitionsOf(partition: PartitionFields, count: number): PartitionFields[] {
	const existing = partition.subpartitions;
	const list = existing === undefined ? [] : listOf(existing as PhpArray, count);
	for (let index = 0; index < count; index++) {
		list[index] ??= { name: `${String(partition.name)}_s${index}`, ...BLANK_STORAGE };
	}
	return list;
}

/** TablePartitionDefinition::getDetails() without pre-filled details. */
export function getPartitionDetails(post: PhpArray): PartitionDetails {
	const pick = (name: string): PhpValue | null => post[name] ?? null;
	const partitionBy = pick('partition_by');
	const rangeOrList = typeof partitionBy === 'string' && RANGE_OR_LIST.has(partitionBy);
	const details: PartitionDetails = {
		partition_by: partitionBy,
		partition_expr: pick('partition_expr'),
		subpartition_by: pick('subpartition_by'),
		subpartition_expr: pick('subpartition_expr'),
		partition_count: partitionCount(post, 'partition_count'),
		subpartition_count: partitionCount(post, 'subpartition_count'),
		can_have_subpartitions: false,
		value_enabled: rangeOrList,
	};
	details.can_have_subpartitions = details.partition_count > 1 && rangeOrList;
	if (details.partition_count <= 1) {
		return details;
	}
	const partitions = listOf(post.partitions, details.partition_count);
	for (let index = 0; index < details.partition_count; index++) {
		let partition = partitions[index];
		if (partition === undefined) {
			partition = { name: `p${index}`, value_type: '', value: '', ...BLANK_STORAGE };
			partitions[index] = partition;
		}
		partition.prefix = `partitions[${index}]`;
		if (partition.value_type === undefined) {
			partition.value_type = '';
			partition.value = '';
		}
		if (partition.engine === undefined) {
			Object.assign(partition, BLANK_STORAGE);
		}
		if (details.subpartition_count < 2 || !details.can_have_subpartitions) {
			delete partition.subpartitions;
			delete partition.subpartition_count;
			continue;
		}
		partition.subpartition_count = details.subpartition_count;
		const subpartitions = subpartitionsOf(partition, details.subpartition_count);
		for (const [subIndex, subpartition] of subpartitions.entries()) {
			subpartition.prefix = `partitions[${index}][subpartitions][${subIndex}]`;
		}
		partition.subpartitions = subpartitions;
	}
	details.partitions = partitions;
	return details;
}

// PHP's (string) cast of a parser value: false and null are '', true is '1'.
function phpText(value: unknown): string {
	if ([false, null, undefined].includes(value as never)) {
		return '';
	}
	if (value === true) {
		return '1';
	}
	return String(value);
}

// trim($value, $characters) for a set of single characters.
function trimCharacters(value: string, characters: string): string {
	let start = 0;
	let end = value.length;
	while (start < end && characters.includes(value[start])) {
		start++;
	}
	while (end > start && characters.includes(value[end - 1])) {
		end--;
	}
	return value.slice(start, end);
}

function splitMethod(definition: string | null | undefined): [string, string] | null {
	if (definition === null || definition === undefined || ['', '0'].includes(definition)) {
		return null;
	}
	const open = definition.indexOf('(');
	const close = definition.lastIndexOf(')');
	if (open === -1 || close === -1) {
		return null;
	}
	return [definition.slice(0, open).trim(), definition.slice(open + 1, close).trim()];
}

interface ParsedPartition {
	name: unknown;
	type?: unknown;
	expr?: unknown;
	options: { has: (key: string, getExpr?: boolean) => unknown; } | null;
	subpartitions?: ParsedPartition[] | null;
}

/** The parts of a parsed CREATE TABLE statement that PartitioningController reads. */
export interface ParsedPartitioning {
	partitionBy?: string | null;
	partitionsNum?: unknown;
	subpartitionBy?: string | null;
	subpartitionsNum?: unknown;
	partitions?: ParsedPartition[] | null;
}

function storageOptions(partition: ParsedPartition): Record<string, unknown> {
	const option = (key: string): unknown => partition.options?.has(key, true) ?? false;
	return {
		engine: option('ENGINE'),
		comment: trimCharacters(phpText(option('COMMENT')), '\''),
		data_directory: trimCharacters(phpText(option('DATA DIRECTORY')), '\''),
		index_directory: trimCharacters(phpText(option('INDEX_DIRECTORY')), '\''),
		max_rows: option('MAX_ROWS'),
		min_rows: option('MIN_ROWS'),
		tablespace: option('TABLESPACE'),
		node_group: option('NODEGROUP'),
	};
}

/** PartitioningController::extractPartitionDetails() for a parsed CREATE TABLE statement. */
export function partitionDetailsFromStatement(statement: ParsedPartitioning): PartitionDetails {
	const partitions = statement.partitions ?? [];
	const details: PartitionDetails = {
		partition_by: '',
		partition_expr: '',
		partition_count: 0,
		subpartition_by: '',
		subpartition_expr: '',
		subpartition_count: 0,
		can_have_subpartitions: false,
		value_enabled: false,
	};
	const method = splitMethod(statement.partitionBy);
	if (method !== null) {
		details.partition_by = method[0];
		details.partition_expr = method[1];
		details.partition_count = Number(statement.partitionsNum ?? partitions.length);
	}
	const subMethod = splitMethod(statement.subpartitionBy);
	if (subMethod !== null) {
		details.subpartition_by = subMethod[0];
		details.subpartition_expr = subMethod[1];
		details.subpartition_count = Number(statement.subpartitionsNum ?? partitions[0]?.subpartitions?.length ?? 0);
	}
	const rangeOrList = RANGE_OR_LIST.has(String(details.partition_by));
	details.can_have_subpartitions = details.partition_count > 1 && rangeOrList;
	details.value_enabled = rangeOrList;
	details.partitions = [];
	for (let index = 0; index < details.partition_count; index++) {
		const parsed = partitions[index];
		let partition: PartitionFields;
		if (parsed === undefined) {
			partition = { name: `p${index}`, value_type: '', value: '', ...BLANK_STORAGE };
		} else {
			let type = phpText(parsed.type);
			let value = trimCharacters(phpText(parsed.expr), '()');
			if (value === 'MAXVALUE') {
				type += ' MAXVALUE';
				value = '';
			}
			partition = { name: parsed.name, value_type: type, value, ...storageOptions(parsed) };
		}
		partition.prefix = `partitions[${index}]`;
		details.partitions.push(partition);
		if (details.subpartition_count <= 1) {
			continue;
		}
		partition.subpartition_count = details.subpartition_count;
		const subpartitions: PartitionFields[] = [];
		for (let subIndex = 0; subIndex < details.subpartition_count; subIndex++) {
			const parsedSub = parsed?.subpartitions?.[subIndex];
			let subpartition: PartitionFields;
			if (parsedSub === undefined) {
				subpartition = { name: `${String(partition.name)}_s${subIndex}`, ...BLANK_STORAGE };
			} else {
				subpartition = { name: parsedSub.name, ...storageOptions(parsedSub) };
			}
			subpartition.prefix = `partitions[${index}][subpartitions][${subIndex}]`;
			subpartitions.push(subpartition);
		}
		partition.subpartitions = subpartitions;
	}
	return details;
}

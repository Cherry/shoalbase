// The size arithmetic of StructureController::getTableStats().
import { formatByteDown } from '../util.ts';

type StatusRow = Record<string, string | number | null>;

export interface TableStatSizes {
	showtable: StatusRow;
	is_innodb: boolean;
	avg_size: string;
	avg_unit: string;
	data_size: string;
	data_unit: string;
	index_size: string | null;
	index_unit: string | null;
	free_size: string | null;
	free_unit: string | null;
	effect_size: string;
	effect_unit: string;
	tot_size: string;
	tot_unit: string;
}

const isEmpty = (value: unknown): boolean => [undefined, null, '', '0', 0].includes(value as never);

function bytes(value: number, limes = 3, comma = 1): [string, string] {
	// formatByteDown() only gives null for a null input.
	return formatByteDown(value, limes, comma) as [string, string];
}

/** The template values of display_table_stats.twig; `numRows` is Table::getNumRows(). */
export function tableStatSizes(status: StatusRow | null, numRows: number, isMerge: boolean): TableStatSizes {
	const showtable: StatusRow = { ...status };
	if (isEmpty(showtable.Data_length)) {
		showtable.Data_length = 0;
	}
	if (isEmpty(showtable.Index_length)) {
		showtable.Index_length = 0;
	}
	const dataLength = Number(showtable.Data_length);
	const indexLength = Number(showtable.Index_length);
	const [dataSize, dataUnit] = bytes(dataLength);
	let indexSize: string | null = null;
	let indexUnit: string | null = null;
	if (!isMerge) {
		[indexSize, indexUnit] = bytes(indexLength);
	}
	let freeSize: string | null = null;
	let freeUnit: string | null = null;
	let effective: [string, string];
	if (showtable.Data_free !== undefined && showtable.Data_free !== null) {
		const dataFree = Number(showtable.Data_free);
		[freeSize, freeUnit] = bytes(dataFree);
		effective = bytes(dataLength + indexLength - dataFree);
	} else {
		effective = bytes(dataLength + indexLength);
	}
	const [totalSize, totalUnit] = bytes(dataLength + indexLength);
	let avgSize = '';
	let avgUnit = '';
	if (numRows > 0) {
		[avgSize, avgUnit] = bytes((dataLength + indexLength) / Number(showtable.Rows), 6, 1);
	}
	return {
		showtable,
		is_innodb: showtable.Type === 'InnoDB',
		avg_size: avgSize,
		avg_unit: avgUnit,
		data_size: dataSize,
		data_unit: dataUnit,
		index_size: indexSize,
		index_unit: indexUnit,
		free_size: freeSize,
		free_unit: freeUnit,
		effect_size: effective[0],
		effect_unit: effective[1],
		tot_size: totalSize,
		tot_unit: totalUnit,
	};
}

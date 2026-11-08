// Port of Partitioning\Partition and SubPartition, built from information_schema.PARTITIONS rows; templates call their getters.
// information_schema.PARTITIONS rows from SELECT *, so every column is present.
export type PartitionRow = Record<string, string | null>;

const isEmpty = (value: string | null | undefined): boolean => [undefined, null, '', '0'].includes(value);

export class SubPartition {
	protected name: string | null = null;
	protected ordinal: string | null = null;
	protected method: string | null = null;
	protected expression: string | null = null;
	rows: string | null = null;
	dataLength: string | null = null;
	indexLength: string | null = null;
	protected comment: string | null = null;

	constructor(row: PartitionRow) {
		this.loadData(row);
	}

	protected loadData(row: PartitionRow): void {
		this.name = row.SUBPARTITION_NAME;
		this.ordinal = row.SUBPARTITION_ORDINAL_POSITION;
		this.method = row.SUBPARTITION_METHOD;
		this.expression = row.SUBPARTITION_EXPRESSION;
		this.loadCommonData(row);
	}

	protected loadCommonData(row: PartitionRow): void {
		this.rows = row.TABLE_ROWS;
		this.dataLength = row.DATA_LENGTH;
		this.indexLength = row.INDEX_LENGTH;
		this.comment = row.PARTITION_COMMENT;
	}

	getName(): string | null {
		return this.name;
	}

	getOrdinal(): string | null {
		return this.ordinal;
	}

	getMethod(): string | null {
		return this.method;
	}

	getExpression(): string | null {
		return this.expression;
	}

	getRows(): string | number | null {
		return this.rows;
	}

	getDataLength(): string | number | null {
		return this.dataLength;
	}

	getIndexLength(): string | number | null {
		return this.indexLength;
	}

	getComment(): string | null {
		return this.comment;
	}
}

// The sums PHP's += makes of numeric strings.
function sum(values: (string | null)[]): number {
	return values.reduce((total, value) => total + Number(value ?? 0), 0);
}

export class Partition extends SubPartition {
	// Declared only, because a field initializer would run after the base constructor's loadData() and reset it.
	declare private description: string | null;
	private readonly subPartitions: SubPartition[] = [];

	protected override loadData(row: PartitionRow): void {
		this.name = row.PARTITION_NAME;
		this.ordinal = row.PARTITION_ORDINAL_POSITION;
		this.method = row.PARTITION_METHOD;
		this.expression = row.PARTITION_EXPRESSION;
		this.description = row.PARTITION_DESCRIPTION;
		// With sub partitions the sizes live on them instead.
		if (isEmpty(row.SUBPARTITION_NAME)) {
			this.loadCommonData(row);
		}
	}

	getDescription(): string | null {
		return this.description;
	}

	addSubPartition(partition: SubPartition): void {
		this.subPartitions.push(partition);
	}

	hasSubPartitions(): boolean {
		return this.subPartitions.length > 0;
	}

	override getRows(): string | number | null {
		if (this.subPartitions.length === 0) {
			return this.rows;
		}
		return sum(this.subPartitions.map(partition => partition.rows));
	}

	override getDataLength(): string | number | null {
		if (this.subPartitions.length === 0) {
			return this.dataLength;
		}
		return sum(this.subPartitions.map(partition => partition.dataLength));
	}

	override getIndexLength(): string | number | null {
		if (this.subPartitions.length === 0) {
			return this.indexLength;
		}
		return sum(this.subPartitions.map(partition => partition.indexLength));
	}

	getSubPartitions(): SubPartition[] {
		return this.subPartitions;
	}
}

/** The grouping loop of Partition::getPartitions(). */
export function partitionsFromRows(rows: PartitionRow[]): Partition[] {
	const partitions = new Map<string, Partition>();
	for (const row of rows) {
		const name = row.PARTITION_NAME;
		if (isEmpty(name)) {
			continue;
		}
		let partition = partitions.get(name as string);
		if (partition === undefined) {
			partition = new Partition(row);
			partitions.set(name as string, partition);
		}
		if (!isEmpty(row.SUBPARTITION_NAME)) {
			partition.addSubPartition(new SubPartition(row));
		}
	}
	return partitions.values().toArray();
}

// Pure parts of PhpMyAdmin\ReplicationInfo: which statements to run and how their rows become primary/replica info.

type StatusRow = Record<string, string | null>;

export interface ReplicationSideInfo {
	status: boolean;
	Do_DB?: string[];
	Ignore_DB?: string[];
	Do_Table?: string[];
	Ignore_Table?: string[];
	Wild_Do_Table?: string[];
	Wild_Ignore_Table?: string[];
}

interface ServerFlavour {
	isMariaDB: boolean;
	version: number;
}

/** Compatibility::getShowBinLogStatusStmt(). */
export function showBinLogStatusStatement({ isMariaDB, version }: ServerFlavour): string {
	if (!isMariaDB && version >= 80200) {
		return 'SHOW BINARY LOG STATUS';
	}
	if (isMariaDB && version >= 100502) {
		return 'SHOW BINLOG STATUS';
	}
	return 'SHOW MASTER STATUS';
}

/** ReplicationInfo::setReplicaStatus()'s statement. */
export function showReplicaStatusStatement({ isMariaDB, version }: ServerFlavour): string {
	if ((!isMariaDB && version >= 80022) || (isMariaDB && version >= 100501)) {
		return 'SHOW REPLICA STATUS';
	}
	return 'SHOW SLAVE STATUS';
}

/** ReplicationInfo::fill(): a comma separated column of the first row, or nothing when empty. */
function fill(status: StatusRow[], key: string): string[] {
	const value = status[0]?.[key];
	if ([undefined, null, '', '0'].includes(value)) {
		return [];
	}
	return (value as string).split(',');
}

/** ReplicationInfo::setPrimaryInfo(). */
export function primaryInfo(status: StatusRow[]): ReplicationSideInfo {
	if (status.length === 0) {
		return { status: false };
	}
	return { status: true, Do_DB: fill(status, 'Binlog_Do_DB'), Ignore_DB: fill(status, 'Binlog_Ignore_DB') };
}

/** ReplicationInfo::setReplicaInfo(). */
export function replicaInfo(status: StatusRow[]): ReplicationSideInfo {
	if (status.length === 0) {
		return { status: false };
	}
	return {
		status: true,
		Do_DB: fill(status, 'Replicate_Do_DB'),
		Ignore_DB: fill(status, 'Replicate_Ignore_DB'),
		Do_Table: fill(status, 'Replicate_Do_Table'),
		Ignore_Table: fill(status, 'Replicate_Ignore_Table'),
		Wild_Do_Table: fill(status, 'Replicate_Wild_Do_Table'),
		Wild_Ignore_Table: fill(status, 'Replicate_Wild_Ignore_Table'),
	};
}

/** DatabasesController::getDatabases()'s is_replicated: not ignored, and either listed or no Do_DB filter at all. */
export function isReplicated(info: ReplicationSideInfo, database: string): boolean {
	if ((info.Ignore_DB ?? []).includes(database)) {
		return false;
	}
	const doDb = info.Do_DB ?? [];
	return doDb.includes(database) || doDb.length === 0;
}

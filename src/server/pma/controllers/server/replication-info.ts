// Port of PhpMyAdmin\ReplicationInfo::load(): the primary and replica status of the server.
import {
	type ReplicationSideInfo,
	primaryInfo,
	replicaInfo,
	showBinLogStatusStatement,
	showReplicaStatusStatement,
} from '../../../../lib/pma/server/replication-info.ts';

import type { PmaContext } from '../../core/context.ts';
import type { DbiRow } from '../../core/dbi.ts';

export interface ReplicationInfo {
	primaryStatus: DbiRow[];
	replicaStatus: DbiRow[];
	multiPrimaryStatus: DbiRow[];
	primaryInfo: ReplicationSideInfo;
	replicaInfo: ReplicationSideInfo;
}

/** ReplicationInfo::load($connection). */
export async function loadReplicationInfo(context: PmaContext, connection: unknown): Promise<ReplicationInfo> {
	const { dbi } = context;
	await dbi.connect();
	const flavour = { isMariaDB: dbi.isMariaDB(), version: dbi.getVersion() };
	const primaryStatus = await dbi.fetchResult(showBinLogStatusStatement(flavour));
	let multiPrimaryStatus: DbiRow[] = [];
	if (typeof connection === 'string' && connection !== '' && connection !== '0' && flavour.isMariaDB) {
		let sql = 'SHOW ALL SLAVES STATUS';
		if (flavour.version >= 100501) {
			sql = 'SHOW ALL REPLICAS STATUS';
		}
		multiPrimaryStatus = await dbi.fetchResult(sql);
		if (multiPrimaryStatus.length > 0) {
			await dbi.query(`SET @@default_master_connection = '${dbi.escapeString(connection)}'`);
		}
	}
	const replicaStatus = await dbi.fetchResult(showReplicaStatusStatement(flavour));
	return {
		primaryStatus,
		replicaStatus,
		multiPrimaryStatus,
		primaryInfo: primaryInfo(primaryStatus),
		replicaInfo: replicaInfo(replicaStatus),
	};
}

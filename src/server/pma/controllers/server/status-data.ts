// Port of the PhpMyAdmin\Server\Status\Data constructor: the server status the Status pages share.
import { type ReplicationInfo, loadReplicationInfo } from './replication-info.ts';
import {
	STATUS_SECTIONS,
	type StatusLinks,
	type StatusMap,
	calculateValues,
	cleanDeprecated,
	isLocalHost,
	sortVariables,
	statusLinks,
} from '../../../../lib/pma/server/status-data.ts';

import type { PmaContext } from '../../core/context.ts';

export interface StatusData {
	dataLoaded: boolean;
	status: StatusMap;
	variables: Map<string, string | null>;
	sections: [string, string][];
	usedQueries: StatusMap;
	allocationMap: Map<string, string>;
	links: StatusLinks;
	sectionUsed: Set<string>;
	dbIsLocal: boolean;
	replication: ReplicationInfo;
}

/** new Data(): replication info, SHOW GLOBAL STATUS and SHOW GLOBAL VARIABLES. */
export async function loadStatusData(context: PmaContext): Promise<StatusData> {
	const { dbi, request } = context;
	const replication = await loadReplicationInfo(context, request.post.primary_connection);
	const result = await dbi.tryQuery('SHOW GLOBAL STATUS');
	let status: StatusMap = new Map();
	let dataLoaded = false;
	if (result !== false) {
		dataLoaded = true;
		status = new Map([...result.fetchAllKeyPair()].map(([name, value]) => [name, value ?? '']));
	}
	const variables = await dbi.fetchResult<string | null>('SHOW GLOBAL VARIABLES', 0, 1);
	status = calculateValues(cleanDeprecated(status), variables);
	const { allocationMap, sectionUsed, usedQueries } = sortVariables(status);
	return {
		dataLoaded,
		status,
		variables,
		sections: STATUS_SECTIONS,
		usedQueries,
		allocationMap,
		links: statusLinks(context.urlState(), replication.primaryInfo, replication.replicaInfo),
		sectionUsed,
		dbIsLocal: isLocalHost(context.config.Server.host),
		replication,
	};
}

import type { Connection } from 'mysql2/promise';

export interface ConnectionSettings {
	host: string;
	port: number;
	user: string;
	password: string;
	ssl: boolean;
	/** Pinned certificate key for TLS servers that cannot be verified any other way; see src/lib/server-identity.ts. */
	pin?: string;
}

export type MysqlConnector = (settings: ConnectionSettings) => Promise<Connection>;

/** One request's MySQL link: opened on first use, then shared by every query of that request. */
export interface RequestConnection {
	get(): Promise<Connection>;
	/** Ends the link if it was opened; safe to call more than once. */
	close(): Promise<void>;
}

export const createRequestConnection = (settings: ConnectionSettings, connector: MysqlConnector): RequestConnection => {
	let pending: Promise<Connection> | undefined;
	return {
		get() {
			pending ??= connector(settings);
			return pending;
		},
		async close() {
			const opening = pending;
			pending = undefined;
			if (!opening) {
				return;
			}
			try {
				const connection = await opening;
				await connection.end();
			} catch {
				// A connection that failed to open or already dropped has nothing left to close.
			}
		},
	};
};

export interface ServerConfig {
	host: string;
	port: number;
	ssl: boolean;
	/** Base64 SHA-256 of the server certificate's public key (MySQL). TLS servers without one must be MariaDB and prove their certificate instead. */
	pin?: string;
}

const normalizeEntry = (entry: unknown): ServerConfig => {
	if (typeof entry !== 'object' || entry === null) {
		throw new Error('Each PMA_SERVERS entry must be an object.');
	}
	const { host, port = 3306, ssl = false, pin } = entry as Record<string, unknown>;
	if (typeof host !== 'string' || host.trim().length === 0) {
		throw new Error('Each PMA_SERVERS entry needs a host.');
	}
	if (typeof port !== 'number' || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
		throw new Error(`Invalid port for PMA_SERVERS host ${host}.`);
	}
	if (typeof ssl !== 'boolean') {
		throw new TypeError(`Invalid ssl flag for PMA_SERVERS host ${host}.`);
	}
	if (pin === undefined) {
		return { host: host.trim(), port, ssl };
	}
	// 32-byte SHA-256 digests are always 44 base64 characters.
	if (typeof pin !== 'string' || !/^[\d+/A-Z]{43}=$/i.test(pin)) {
		throw new TypeError(`Invalid pin for PMA_SERVERS host ${host}.`);
	}
	return { host: host.trim(), port, ssl, pin };
};

const byHost = (left: ServerConfig, right: ServerConfig): number => {
	if (left.host < right.host) {
		return -1;
	}
	if (left.host > right.host) {
		return 1;
	}
	return 0;
};

/**
 * Parses the PMA_SERVERS JSON array into the login server list.
 * Sorted by host in byte order so server numbers stay stable when entries are added.
 */
export const loadServers = (value: string | undefined): ServerConfig[] => {
	if (value === undefined || value.trim().length === 0) {
		throw new Error('PMA_SERVERS is not set.');
	}
	const parsed: unknown = JSON.parse(value);
	if (!Array.isArray(parsed) || parsed.length === 0) {
		throw new Error('PMA_SERVERS must be a non-empty JSON array.');
	}
	return parsed.map(entry => normalizeEntry(entry)).toSorted(byHost);
};

/** Resolves phpMyAdmin's 1-based `server` form value. */
export const serverByIndex = (servers: ServerConfig[], index: unknown): ServerConfig | undefined => {
	const position = Number(index);
	if (!Number.isSafeInteger(position) || position < 1) {
		return undefined;
	}
	return servers[position - 1];
};

/** Identifies a server in cookies; host alone is ambiguous when one host serves several ports. */
export const serverKey = (server: ServerConfig): string => `${server.host}:${server.port}`;

/** Config::selectServer(): the request's `server` by number or host name, else ServerDefault (1). */
export const selectServer = (servers: ServerConfig[], requested: unknown): number => {
	if (typeof requested !== 'string') {
		return 1;
	}
	if (/^\d+$/.test(requested) && serverByIndex(servers, requested)) {
		return Number(requested);
	}
	const byHost = servers.findIndex(server => server.host === requested);
	return byHost === -1 ? 1 : byHost + 1;
};

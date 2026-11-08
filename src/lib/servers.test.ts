import { describe, expect, it } from 'vitest';

import {
	findServer,
	loadServers,
	serverByIndex,
	serverIndex,
	serverKey,
} from '~/lib/servers';

describe('server list', () => {
	it('parses the JSON list with defaults, sorted by host in byte order', () => {
		expect(loadServers('[{"host":"zeta"},{"host":" alpha ","port":33306,"ssl":true},{"host":"Zulu"}]')).toEqual([
			{ host: 'Zulu', port: 3306, ssl: false },
			{ host: 'alpha', port: 33306, ssl: true },
			{ host: 'zeta', port: 3306, ssl: false },
		]);
		expect(loadServers('[{"host":"same"},{"host":"same"}]')).toHaveLength(2);
	});

	it('requires a list instead of starting without servers', () => {
		expect(() => loadServers(undefined)).toThrow('PMA_SERVERS is not set');
		expect(() => loadServers('  ')).toThrow('PMA_SERVERS is not set');
	});

	it('rejects malformed lists', () => {
		expect(() => loadServers('{}')).toThrow('non-empty JSON array');
		expect(() => loadServers('[]')).toThrow('non-empty JSON array');
		expect(() => loadServers('[null]')).toThrow('must be an object');
		expect(() => loadServers('[{"host":""}]')).toThrow('needs a host');
		expect(() => loadServers('[{"host":"db","port":0}]')).toThrow('Invalid port');
		expect(() => loadServers('[{"host":"db","port":"3306"}]')).toThrow('Invalid port');
		expect(() => loadServers('[{"host":"db","ssl":"yes"}]')).toThrow('Invalid ssl');
		expect(() => loadServers('not json')).toThrow();
	});

	it('maps phpMyAdmin 1-based server numbers to hosts and back', () => {
		const servers = loadServers('[{"host":"b"},{"host":"a"}]');

		expect(serverByIndex(servers, '1')?.host).toBe('a');
		expect(serverByIndex(servers, 2)?.host).toBe('b');
		expect(serverByIndex(servers, 3)).toBeUndefined();
		expect(serverByIndex(servers, '0')).toBeUndefined();
		expect(serverByIndex(servers, '1.5')).toBeUndefined();
		expect(serverByIndex(servers, null)).toBeUndefined();
		expect(serverIndex(servers, 'b:3306')).toBe(2);
		expect(serverIndex(servers, 'b')).toBe(0);
	});

	it('tells apart servers that share a host by port', () => {
		const servers = loadServers('[{"host":"db","port":3307},{"host":"db"}]');

		expect(servers.map(server => serverKey(server))).toEqual(['db:3307', 'db:3306']);
		expect(findServer(servers, 'db:3306')?.port).toBe(3306);
		expect(findServer(servers, 'db')).toBeUndefined();
	});

	it('accepts only well-formed SHA-256 pins', () => {
		const pin = 'Gy789bwh929fkWB/9h3N1oUYTB78tiH3waOuO1sGVQw=';

		expect(loadServers(`[{"host":"db","ssl":true,"pin":"${pin}"}]`)[0]?.pin).toBe(pin);
		expect(() => loadServers('[{"host":"db","pin":"sha256/abc"}]')).toThrow('Invalid pin');
		expect(() => loadServers('[{"host":"db","pin":42}]')).toThrow('Invalid pin');
	});
});

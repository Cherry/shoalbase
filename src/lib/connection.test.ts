import {
	describe,
	expect,
	it,
	vi,
} from 'vitest';

import type { Connection } from 'mysql2/promise';

import { type ConnectionSettings, createRequestConnection } from '~/lib/connection';

const settings: ConnectionSettings = { host: 'db', port: 3306, user: 'customer', password: 'pw', ssl: false };

const fakeConnection = (end = vi.fn(async () => {})): Connection => ({ end }) as unknown as Connection;

describe('createRequestConnection', () => {
	it('opens nothing until a query needs the link', async () => {
		const connector = vi.fn(async () => fakeConnection());
		const connection = createRequestConnection(settings, connector);

		await connection.close();
		expect(connector).not.toHaveBeenCalled();
	});

	it('shares one link across the request and ends it once', async () => {
		const end = vi.fn(async () => {});
		const link = fakeConnection(end);
		const connector = vi.fn(async () => link);
		const connection = createRequestConnection(settings, connector);

		expect(await connection.get()).toBe(link);
		expect(await connection.get()).toBe(link);
		expect(connector).toHaveBeenCalledExactlyOnceWith(settings);

		await connection.close();
		await connection.close();
		expect(end).toHaveBeenCalledTimes(1);
	});

	it('closes quietly when the link never opened', async () => {
		const connection = createRequestConnection(settings, () => Promise.reject(new Error('Access denied')));

		await expect(connection.get()).rejects.toThrow('Access denied');
		await expect(connection.close()).resolves.toBeUndefined();
	});
});

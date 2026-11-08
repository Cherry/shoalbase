// Writes .dev.vars for the servers of docker/compose.yaml: MySQL 8.4 plain and over TLS, MariaDB over TLS, MySQL 5.7 over TLS.
// Usage: node scripts/dev-vars.mjs   (after `npm run db:up`; fresh containers get fresh certificates, so run it again after recreating them)
// An existing PMA_COOKIE_SECRET is kept so running it again does not sign everyone out.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { pinFor } from './collect-tls-pins.mjs';

const file = path.join(import.meta.dirname, '..', '.dev.vars');
const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
const secret = /^PMA_COOKIE_SECRET=(.+)$/m.exec(existing)?.[1] ?? randomBytes(36).toString('base64url');

const mysql84 = await pinFor('127.0.0.1', 33306);
const mysql57 = await pinFor('127.0.0.1', 33308);
// Server numbers follow the host sort, so the plain 127.0.0.1 entry is server 1, like the oracle's MySQL 8.4.
const servers = [
	{ host: '127.0.0.1', port: 33306 },
	{ host: 'localhost', port: 33306, ssl: true, pin: mysql84.pin },
	{ host: 'localhost', port: 33307, ssl: true },
	{ host: 'localhost', port: 33308, ssl: true, pin: mysql57.pin },
];

writeFileSync(file, `PMA_COOKIE_SECRET=${secret}\nPMA_SERVERS=${JSON.stringify(servers)}\n`);
console.log(`Wrote ${file} with ${servers.length} servers.`);

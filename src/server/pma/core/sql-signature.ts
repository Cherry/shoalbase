// Core::signSqlQuery() and Core::checkSqlQuerySignature(): HMACs that let links carry SQL without trusting the client.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { PmaSession } from '../../../lib/pma/session.ts';

/** $_SESSION[' HMAC_secret '], the key name upstream uses. */
const SECRET_KEY = ' HMAC_secret ';

// Upstream creates the secret at login; here it is created on first use so sessions without signed links stay empty.
function sessionSecret(session: PmaSession): string {
	const existing = session.data[SECRET_KEY];
	if (typeof existing === 'string' && existing !== '') {
		return existing;
	}
	const secret = randomBytes(16).toString('hex');
	session.data[SECRET_KEY] = secret;
	return secret;
}

/** Core::signSqlQuery(). */
export function signSqlQuery(session: PmaSession, sqlQuery: string): string {
	return createHmac('sha256', sessionSecret(session)).update(sqlQuery, 'utf8').digest('hex');
}

/** Core::checkSqlQuerySignature(). */
export function checkSqlQuerySignature(session: PmaSession, sqlQuery: string, signature: unknown): boolean {
	if (typeof signature !== 'string') {
		return false;
	}
	const expected = Buffer.from(signSqlQuery(session, sqlQuery), 'utf8');
	const given = Buffer.from(signature, 'utf8');
	return expected.length === given.length && timingSafeEqual(expected, given);
}

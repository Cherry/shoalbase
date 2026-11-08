// Loads and stores PmaSession ($_SESSION) in its sealed cookies, next to the pmaAuth login cookie it belongs to.
import {
	PmaSession,
	SESSION_COOKIE,
	fitSession,
	readSessionChunks,
	sessionChunkName,
	splitSessionChunks,
} from '../../../lib/pma/session.ts';
import { cookieCipher } from '../../auth-runtime.ts';

/** Opens the session cookies of a request; anything unreadable or from another login yields an empty session. */
export async function loadPmaSession(read: (name: string) => string | undefined, token: string): Promise<PmaSession> {
	const { sealed, count } = readSessionChunks(read);
	if (count === 0) {
		return new PmaSession();
	}
	const cipher = await cookieCipher();
	return PmaSession.fromPayload(await cipher.open(SESSION_COOKIE, sealed), token, count);
}

// Session cookies (no expiry) like PHP's session cookie, with the flags of the pmaAuth cookie.
function cookieLine(name: string, value: string, isHttps: boolean): string {
	const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
	if (isHttps) {
		parts.push('Secure');
	}
	return parts.join('; ');
}

function deleteLine(name: string, isHttps: boolean): string {
	return cookieLine(name, '', isHttps).replace('; Path=/', '; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/');
}

/** The Set-Cookie lines that store a changed session, or none when nothing changed. */
export async function sessionCookieHeaders(session: PmaSession, token: string, isHttps: boolean): Promise<string[]> {
	if (!session.isChanged()) {
		return [];
	}
	let chunks: string[] = [];
	if (!session.isEmpty()) {
		const data = fitSession(token, session.data);
		// Too large even after pruning: the request keeps its previous cookies rather than losing everything.
		if (data === null) {
			return [];
		}
		const cipher = await cookieCipher();
		// The cipher stringifies the same { token, data } shape that fitSession() measured.
		chunks = splitSessionChunks(await cipher.seal(SESSION_COOKIE, { token, data }));
	}
	const lines = chunks.map((chunk, index) => cookieLine(sessionChunkName(index), chunk, isHttps));
	for (let index = chunks.length; index < session.chunkCount; index++) {
		lines.push(deleteLine(sessionChunkName(index), isHttps));
	}
	return lines;
}

/** Names of the session cookies a request carries, for logout to delete. */
export function sessionCookieNames(read: (name: string) => string | undefined): string[] {
	const { count } = readSessionChunks(read);
	return Array.from({ length: count }, (_, index) => sessionChunkName(index));
}

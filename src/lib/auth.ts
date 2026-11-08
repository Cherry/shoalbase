// phpMyAdmin defaults from libraries/config.default.php ($cfg['LoginCookieValidity'] and LoginCookieRecall's one-month cookie).
export const LOGIN_COOKIE_VALIDITY_SECONDS = 1440;
export const RECALL_COOKIE_MAX_AGE_SECONDS = 2_592_000;
/** PHP's session cookie, named by Session::setUp() through Config::getCookieName('phpMyAdmin'). */
export const SESSION_COOKIE = 'phpMyAdmin';
const MIN_SECRET_LENGTH = 32;
const IV_LENGTH = 12;
const KEY_BYTES = 32;

/** AuthenticationCookie's password cookie for a server, encrypted with the session's own key. */
export const authCookieName = (server: number): string => `pmaAuth-${server}`;

/** AuthenticationCookie's username cookie for a server, encrypted with PMA_COOKIE_SECRET. */
export const userCookieName = (server: number): string => `pmaUser-${server}`;

export type EntryPoint = 'index' | 'public';

/** The docroot's PHP scripts, with '/' serving index.php as Apache's DirectoryIndex does; any other path is a 404. */
export const entryPoint = (pathname: string): EntryPoint | null => {
	if (pathname === '/' || pathname === '/index.php') {
		return 'index';
	}
	// url.php runs with $isMinimumCommon and the login form loads js/messages.php, so neither needs a login.
	if (pathname === '/url.php' || pathname === '/js/messages.php') {
		return 'public';
	}
	return null;
};

const encodeBase64Url = (bytes: Uint8Array): string => btoa(String.fromCodePoint(...bytes)).replaceAll('+', '-').replaceAll('/', '_')
	.replace(/=+$/, '');

const decodeBase64Url = (value: string): Uint8Array<ArrayBuffer> => {
	const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
	return Uint8Array.from(atob(base64), character => character.codePointAt(0) as number);
};

const toHex = (bytes: Uint8Array): string => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

/** Same shape as phpMyAdmin's bin2hex(random_bytes(16)) session token. */
export const createSessionToken = (): string => toHex(crypto.getRandomValues(new Uint8Array(16)));

/** A PHP session id as the official image makes them (session.sid_length 32, 4 bits per character). */
export const createSessionId = (): string => toHex(crypto.getRandomValues(new Uint8Array(16)));

/** Only ids this port could have issued are looked up, so arbitrary cookie values never reach session storage. */
export const isSessionId = (value: unknown): value is string => typeof value === 'string' && /^[\da-f]{32}$/.test(value);

/** The session object's name: a SHA-256 of the id, so the cookie value never appears where object names are listed. */
export const sessionObjectName = async (id: string): Promise<string> => toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id))));

/** $_SESSION['encryption_key']: the random per-session key the password cookie is encrypted with. */
export const createEncryptionKey = (): string => encodeBase64Url(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));

export interface CookieCipher {
	/** Encrypts `value`, binding it to `context` (the cookie name and server) so it cannot be replayed elsewhere. */
	seal(context: string, value: unknown): Promise<string>;
	open(context: string, token: string | undefined): Promise<unknown>;
}

const cipherFromKey = (key: CryptoKey): CookieCipher => {
	return {
		async seal(context, value) {
			const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
			const plaintext = new TextEncoder().encode(JSON.stringify(value));
			const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(context) }, key, plaintext));
			const token = new Uint8Array(IV_LENGTH + ciphertext.length);
			token.set(iv);
			token.set(ciphertext, IV_LENGTH);
			return encodeBase64Url(token);
		},
		async open(context, token) {
			if (!token) {
				return null;
			}
			try {
				const bytes = decodeBase64Url(token);
				const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, IV_LENGTH), additionalData: new TextEncoder().encode(context) }, key, bytes.slice(IV_LENGTH));
				return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
			} catch {
				// Tampered, truncated, or rotated-key cookies are treated as absent, matching phpMyAdmin's failed cookieDecrypt.
				return null;
			}
		},
	};
};

/** Encrypts cookies with a key derived from PMA_COOKIE_SECRET, phpMyAdmin's blowfish_secret. */
export const createCookieCipher = async (secret: string | undefined): Promise<CookieCipher> => {
	if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
		throw new Error(`PMA_COOKIE_SECRET must be set to at least ${MIN_SECRET_LENGTH} characters.`);
	}
	const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'HKDF', false, ['deriveKey']);
	const key = await crypto.subtle.deriveKey(
		{ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('shoalbase cookie v1') },
		material,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt'],
	);
	return cipherFromKey(key);
};

/** Encrypts cookies with a session's encryption_key; null for anything createEncryptionKey() could not have made. */
export const createSessionCipher = async (encryptionKey: unknown): Promise<CookieCipher | null> => {
	if (typeof encryptionKey !== 'string' || !/^[\w-]{43}$/.test(encryptionKey)) {
		return null;
	}
	return cipherFromKey(await crypto.subtle.importKey('raw', decodeBase64Url(encryptionKey), 'AES-GCM', false, ['encrypt', 'decrypt']));
};

/** Compares tokens in constant time so response timing cannot reveal how much of a guess matched. */
export const tokensMatch = (expected: string, supplied: unknown): boolean => {
	if (typeof supplied !== 'string' || supplied.length !== expected.length) {
		return false;
	}
	let difference = 0;
	for (let index = 0; index < expected.length; index += 1) {
		difference |= (expected.codePointAt(index) as number) ^ (supplied.codePointAt(index) as number);
	}
	return difference === 0;
};

export type LoginFailure = 'empty-denied' | 'no-activity';

// Copied from phpMyAdmin 5.2.3 AuthenticationPlugin::getErrorMessage(); `validity` is the session's LoginCookieValidity.
export const loginFailureMessage = (failure: LoginFailure, validity = LOGIN_COOKIE_VALIDITY_SECONDS): string => {
	if (failure === 'empty-denied') {
		return 'Login without a password is forbidden by configuration (see AllowNoPassword)';
	}
	return `You have been automatically logged out due to inactivity of ${validity} seconds. Once you log in again, you should be able to resume the work where you left off.`;
};

export const CANNOT_LOG_IN_MESSAGE = 'Cannot log in to the MySQL server';

const CR_CONNECTION_ERROR = 2002;
const CR_SSL_CONNECTION_ERROR = 2026;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** Formats a driver connection error the way mysqli reports it on phpMyAdmin's login page. */
export const connectionErrorMessage = (error: unknown): string => {
	const details = isRecord(error) ? error : {};
	const message = typeof details.message === 'string' && details.message.length > 0 ? details.message : 'Unknown error';
	let errno = CR_CONNECTION_ERROR;
	if (typeof details.errno === 'number' && details.errno >= 1000) {
		errno = details.errno;
	} else if (details.code === 'HANDSHAKE_SSL_ERROR') {
		errno = CR_SSL_CONNECTION_ERROR;
	}
	return `mysqli::real_connect(): (HY000/${errno}): ${message}`;
};

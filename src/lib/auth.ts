// phpMyAdmin defaults from libraries/config.default.php ($cfg['LoginCookieValidity'] and LoginCookieRecall's one-month cookie).
export const LOGIN_COOKIE_VALIDITY_SECONDS = 1440;
export const RECALL_COOKIE_MAX_AGE_SECONDS = 2_592_000;
export const AUTH_COOKIE = 'pmaAuth';
export const RECALL_COOKIE = 'pmaUser';
const MIN_SECRET_LENGTH = 32;
const IV_LENGTH = 12;

export interface AuthSession {
	/** serverKey() of the signed-in server. */
	server: string;
	user: string;
	password: string;
	lastActivity: number;
	/** phpMyAdmin's per-session CSRF token, sent back as the `token` parameter on every request. */
	token: string;
}

export interface RecalledLogin {
	server: string;
	user: string;
}

export type AuthSessionState = { status: 'valid'; session: AuthSession; } | { status: 'expired'; } | { status: 'missing'; };

export type EntryPoint = 'index' | 'public';

/** The docroot's PHP scripts, with '/' serving index.php as Apache's DirectoryIndex does; any other path is a 404. */
export const entryPoint = (pathname: string): EntryPoint | null => {
	if (pathname === '/' || pathname === '/index.php') { return 'index'; }
	// url.php runs with $isMinimumCommon and the login form loads js/messages.php, so neither needs a login.
	if (pathname === '/url.php' || pathname === '/js/messages.php') { return 'public'; }
	return null;
};

const encodeBase64Url = (bytes: Uint8Array): string => btoa(String.fromCodePoint(...bytes)).replaceAll('+', '-').replaceAll('/', '_')
	.replace(/=+$/, '');

const decodeBase64Url = (value: string): Uint8Array => {
	const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
	return Uint8Array.from(atob(base64), character => character.codePointAt(0) as number);
};

export interface CookieCipher {
	seal(name: string, value: unknown): Promise<string>;
	open(name: string, token: string | undefined): Promise<unknown>;
}

/** Encrypts cookie payloads with AES-GCM, binding each ciphertext to its cookie name so values cannot be swapped between cookies. */
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
	return {
		async seal(name, value) {
			const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
			const plaintext = new TextEncoder().encode(JSON.stringify(value));
			const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(name) }, key, plaintext));
			const token = new Uint8Array(IV_LENGTH + ciphertext.length);
			token.set(iv);
			token.set(ciphertext, IV_LENGTH);
			return encodeBase64Url(token);
		},
		async open(name, token) {
			if (!token) { return null; }
			try {
				const bytes = decodeBase64Url(token);
				const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, IV_LENGTH), additionalData: new TextEncoder().encode(name) }, key, bytes.slice(IV_LENGTH));
				return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
			} catch {
				// Tampered, truncated, or rotated-secret cookies are treated as absent, matching phpMyAdmin's failed cookieDecrypt.
				return null;
			}
		},
	};
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

export const authSessionState = (value: unknown, nowSeconds: number): AuthSessionState => {
	if (!isRecord(value)) { return { status: 'missing' }; }
	const { server, user, password, lastActivity, token } = value;
	if (typeof server !== 'string' || typeof user !== 'string' || typeof password !== 'string' || typeof lastActivity !== 'number' || typeof token !== 'string') {
		return { status: 'missing' };
	}
	if (nowSeconds - lastActivity > LOGIN_COOKIE_VALIDITY_SECONDS) { return { status: 'expired' }; }
	return { status: 'valid', session: { server, user, password, lastActivity, token } };
};

export const recalledLogin = (value: unknown): RecalledLogin | null => {
	if (!isRecord(value) || typeof value.server !== 'string' || typeof value.user !== 'string') { return null; }
	return { server: value.server, user: value.user };
};

/** Same shape as phpMyAdmin's bin2hex(random_bytes(16)) session token. */
export const createSessionToken = (): string => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');

/** Compares tokens in constant time so response timing cannot reveal how much of a guess matched. */
export const tokensMatch = (expected: string, supplied: unknown): boolean => {
	if (typeof supplied !== 'string' || supplied.length !== expected.length) { return false; }
	let difference = 0;
	for (let index = 0; index < expected.length; index += 1) {
		difference |= (expected.codePointAt(index) as number) ^ (supplied.codePointAt(index) as number);
	}
	return difference === 0;
};

export type LoginFailure = 'empty-denied' | 'no-activity';

// Copied from phpMyAdmin 5.2.3 AuthenticationPlugin::getErrorMessage().
export const loginFailureMessage = (failure: LoginFailure): string => {
	if (failure === 'empty-denied') {
		return 'Login without a password is forbidden by configuration (see AllowNoPassword)';
	}
	return `You have been automatically logged out due to inactivity of ${LOGIN_COOKIE_VALIDITY_SECONDS} seconds. Once you log in again, you should be able to resume the work where you left off.`;
};

export const CANNOT_LOG_IN_MESSAGE = 'Cannot log in to the MySQL server';

const CR_CONNECTION_ERROR = 2002;
const CR_SSL_CONNECTION_ERROR = 2026;

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

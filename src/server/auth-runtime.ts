import { env } from 'cloudflare:workers';

import type { AstroCookieSetOptions, AstroCookies } from 'astro';

import { AUTH_COOKIE, type CookieCipher, createCookieCipher } from '~/lib/auth';
import { type ServerConfig, loadServers } from '~/lib/servers';

let cipher: Promise<CookieCipher> | undefined;
let servers: ServerConfig[] | undefined;

export const cookieCipher = (): Promise<CookieCipher> => {
	cipher ??= createCookieCipher(env.PMA_COOKIE_SECRET);
	return cipher;
};

export const configuredServers = (): ServerConfig[] => {
	servers ??= loadServers(env.PMA_SERVERS);
	return servers;
};

// Matches phpMyAdmin's $cfg['CookieSameSite'] = 'Strict' and its HttpOnly/secure-when-HTTPS cookie flags.
export const cookieOptions = (url: URL, maxAge?: number): AstroCookieSetOptions => {
	return { path: '/', httpOnly: true, secure: url.protocol === 'https:', sameSite: 'strict', maxAge };
};

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** phpMyAdmin's handlePasswordChange(): keep the session alive after the signed-in account changes its own password. */
export const storeChangedPassword = async (cookies: AstroCookies, url: URL, auth: NonNullable<App.Locals['auth']>, password: string): Promise<void> => {
	const cipher = await cookieCipher();
	const session = { server: auth.server, user: auth.user, password, lastActivity: nowSeconds(), token: auth.token };
	cookies.set(AUTH_COOKIE, await cipher.seal(AUTH_COOKIE, session), cookieOptions(url));
};

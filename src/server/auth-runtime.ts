import { env } from 'cloudflare:workers';

import { type CookieCipher, createCookieCipher } from '~/lib/auth';
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

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

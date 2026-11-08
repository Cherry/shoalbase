// Config::getCookieName() and the Set-Cookie lines PHP's setcookie() sends for Config::setCookie() and removeCookie().
import { urlencode } from '../twig/php.ts';

/** Config::getCookieName(): HTTPS cookies get the __Secure- prefix and an _https suffix. */
export function phpCookieName(name: string, isHttps: boolean): string {
	if (isHttps) {
		return `__Secure-${name}_https`;
	}
	return name;
}

// DATE_COOKIE as setcookie() formats it.
function cookieDate(date: Date): string {
	const [weekday, day, month, year, time] = date.toUTCString().split(' ', 5);
	return `${weekday} ${day} ${month} ${year} ${time} GMT`;
}

export interface CookieOptions {
	isHttps: boolean;
	now: Date;
	/** Seconds from now; 0 makes a session cookie. Config::setCookie() defaults to one month. */
	validity?: number;
	httpOnly?: boolean;
	sameSite?: string;
}

/** setcookie() with Config::setCookie()'s options: path is the root path, which is / here. */
export function setCookieHeader(name: string, value: string, options: CookieOptions): string {
	const parts = [`${name}=${urlencode(value)}`];
	const validity = options.validity ?? 2_592_000;
	if (validity > 0) {
		const expires = new Date(Math.floor(options.now.getTime() / 1000) * 1000 + validity * 1000);
		parts.push(`expires=${cookieDate(expires)}`, `Max-Age=${validity}`);
	}
	parts.push('path=/');
	if (options.isHttps) {
		parts.push('secure');
	}
	if (options.httpOnly ?? true) {
		parts.push('HttpOnly');
	}
	parts.push(`SameSite=${options.sameSite ?? 'Strict'}`);
	return parts.join('; ');
}

/** Config::removeCookie(): setcookie() with an empty value and a past expiry, which PHP sends as "deleted". */
export function removeCookieHeader(name: string, isHttps: boolean): string {
	const parts = [`${name}=deleted`, 'expires=Thu, 01 Jan 1970 00:00:01 GMT', 'Max-Age=0', 'path=/'];
	if (isHttps) {
		parts.push('secure');
	}
	return parts.join('; ');
}

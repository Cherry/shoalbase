// UrlRedirector::redirect() and Core::isAllowedDomain(): url.php only forwards https links to known sites.

const ALLOWED_DOMAINS = new Set([
	'wiki.phpmyadmin.net',
	'www.phpmyadmin.net',
	'phpmyadmin.net',
	'demo.phpmyadmin.net',
	'docs.phpmyadmin.net',
	'dev.mysql.com',
	'bugs.mysql.com',
	'mariadb.org',
	'mariadb.com',
	'php.net',
	'www.php.net',
	'github.com',
	'www.github.com',
	'www.percona.com',
	'www.cve.org',
	'mysqldatabaseadministration.blogspot.com',
]);

/** Core::isAllowedDomain() for an https URL: parse_url() must find a host on the allow list and no user, password or port. */
export function isAllowedDomain(url: string, serverName: string): boolean {
	const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(url)?.[1] ?? '';
	// parse_url() splits the user information off at the last "@".
	const at = authority.lastIndexOf('@');
	if (at !== -1 && authority.slice(0, at).replace(':', '') !== '') {
		return false;
	}
	const hostAndPort = authority.slice(at + 1);
	const colon = hostAndPort.lastIndexOf(':');
	let host = hostAndPort;
	if (colon !== -1) {
		// A port, or a malformed one that makes parse_url() fail, is refused either way.
		if (colon < hostAndPort.length - 1) {
			return false;
		}
		host = hostAndPort.slice(0, colon);
	}
	if (host === '') {
		return false;
	}
	return host === serverName || ALLOWED_DOMAINS.has(host);
}

/** Whether url.php may forward to the requested url parameter, which is the last value when it repeats. */
export function isRedirectAllowed(url: string | undefined, serverName: string): url is string {
	if (url === undefined || url === '') {
		return false;
	}
	// PCRE's $ also matches before a final newline.
	if (!/^https:\/\/[^\n\r]*\n?$/.test(url)) {
		return false;
	}
	return isAllowedDomain(url, serverName);
}

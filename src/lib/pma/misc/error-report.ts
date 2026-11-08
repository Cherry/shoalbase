// ErrorReport::getData() for JavaScript errors, with Config::checkClient() and the URL sanitizing it relies on.
import { httpBuildQuery } from '../../twig/php.ts';

type Nested = Record<string, unknown>;

// PHP arrays with keys 0..n-1 encode as JSON lists.
function listify(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(item => listify(item));
	}
	if (typeof value !== 'object' || value === null) {
		return value;
	}
	const entries = Object.entries(value).map(([key, item]): [string, unknown] => [key, listify(item)]);
	if (entries.length > 0 && entries.every(([key], index) => key === String(index))) {
		return entries.map(([, item]) => item);
	}
	return Object.fromEntries(entries);
}

/** PHP's parse_str()/$_POST nesting for keys such as exception[stack][0][func], given the flat request keys. */
export function nestedParam(post: Record<string, unknown>, name: string): unknown {
	const root: Nested = {};
	for (const [key, value] of Object.entries(post)) {
		if (key !== name && !key.startsWith(`${name}[`)) {
			continue;
		}
		const path = key.slice(name.length).matchAll(/\[([^\]]*)\]/g).map(match => match[1])
			.toArray();
		let node = root;
		let last = name;
		for (const part of path) {
			if (typeof node[last] !== 'object' || node[last] === null || Array.isArray(node[last])) {
				node[last] = {};
			}
			node = node[last] as Nested;
			last = part;
		}
		node[last] = value;
	}
	return listify(root[name]);
}

export interface ClientInfo {
	os: string;
	agent: string;
	version: string | number;
}

function clientPlatform(userAgent: string): string {
	for (const os of ['Win', 'Mac', 'Linux', 'Unix', 'OS/2']) {
		if (userAgent.includes(os)) {
			return os;
		}
	}
	return 'Other';
}

/** Config::checkClient(): PMA_USR_OS, PMA_USR_BROWSER_AGENT and PMA_USR_BROWSER_VER from the user agent. */
export function checkClient(userAgent: string): ClientInfo {
	const os = clientPlatform(userAgent);
	const mozilla = /Mozilla\/(\d\.\d{1,2})/.exec(userAgent);
	const browsers: [RegExp, string, (match: RegExpExecArray) => string | number][] = [
		[/Opera(\/| )(\d\.\d{1,2})/, 'OPERA', match => match[2]],
		[/(MS)?IE (\d{1,2}\.\d{1,2})/, 'IE', match => match[2]],
		[/Trident\/(7)\.0/, 'IE', match => Number(match[1]) + 4],
		[/OmniWeb\/(\d{1,3})/, 'OMNIWEB', match => match[1]],
		[/(Konqueror\/)(.*)(;)/, 'KONQUEROR', match => match[2]],
	];
	for (const [pattern, agent, version] of browsers) {
		const match = pattern.exec(userAgent);
		if (match) {
			return { os, agent, version: version(match) };
		}
	}
	if (mozilla) {
		const mozillaBrowsers: [RegExp, string, (match: RegExpExecArray) => string][] = [
			[/Chrome\/([\d.]*)/, 'CHROME', match => match[1]],
			[/Version\/(.*) Safari/, 'SAFARI', match => match[1]],
			[/Safari\/(\d*)/, 'SAFARI', match => `${mozilla[1]}.${match[1]}`],
		];
		for (const [pattern, agent, version] of mozillaBrowsers) {
			const match = pattern.exec(userAgent);
			if (match) {
				return { os, agent, version: version(match) };
			}
		}
	}
	const firefox = /Firefox\/([\w.]+)/.exec(userAgent);
	if (!userAgent.includes('compatible') && firefox) {
		return { os, agent: 'FIREFOX', version: firefox[1] };
	}
	if (/rv:1\.9.*Gecko/.test(userAgent)) {
		return { os, agent: 'GECKO', version: '1.9' };
	}
	if (mozilla) {
		return { os, agent: 'MOZILLA', version: mozilla[1] };
	}
	return { os, agent: 'OTHER', version: 0 };
}

/** parse_url() of an http(s) URL into path, query and fragment. */
function parseUrl(url: string): { path: string; query: string | null; fragment: string | null; } {
	let rest = url;
	let fragment: string | null = null;
	const hashAt = rest.indexOf('#');
	if (hashAt !== -1) {
		fragment = rest.slice(hashAt + 1);
		rest = rest.slice(0, hashAt);
	}
	let query: string | null = null;
	const queryAt = rest.indexOf('?');
	if (queryAt !== -1) {
		query = rest.slice(queryAt + 1);
		rest = rest.slice(0, queryAt);
	}
	return { path: rest.replace(/^[a-z][a-z\d+.-]*:\/\/[^/]*/i, ''), query, fragment };
}

/** parse_str(): the last value wins for repeated keys, and both keys and values are URL-decoded. */
function parseQuery(query: string): Record<string, string> {
	const result: Record<string, string> = Object.fromEntries(new URLSearchParams(query));
	return result;
}

/** ErrorReport::sanitizeUrl(): the script name and a URI without db, table, token, server and eq. */
export function sanitizeUrl(url: string): [string, string] {
	let parts = parseUrl(url);
	const marker = parts.fragment === null ? null : /PMAURL-\d+:/.exec(parts.fragment);
	if (parts.fragment !== null && marker) {
		parts = parseUrl(`https://example.com/${parts.fragment.replace(marker[0], '')}`);
	}
	const script = /([\w\-.]*\.php|js\/[\w\-/.]*\.js)$/.exec(parts.path);
	const scriptName = script ? script[1] : 'index.php';
	let query = '';
	if (parts.query !== null) {
		const values = parseQuery(parts.query);
		for (const key of ['db', 'table', 'token', 'server', 'eq']) {
			delete values[key];
		}
		query = httpBuildQuery(values);
	}
	return [`${scriptName}?${query}`, scriptName];
}

/** ErrorReport::translateStacktrace(): long context lines are cut and URLs sanitized. */
function translateStacktrace(stack: unknown): unknown {
	if (!Array.isArray(stack)) {
		return stack;
	}
	return stack.map((level: Nested) => {
		const translated: Nested = { ...level };
		if (Array.isArray(level.context)) {
			translated.context = level.context.map((line: string) => ([...line].length <= 80 ? line : `${[...line].slice(0, 75).join('')}//...`));
		}
		const [uri, scriptName] = sanitizeUrl(String(level.url ?? ''));
		delete translated.url;
		translated.uri = uri;
		translated.scriptname = scriptName;
		return translated;
	});
}

export interface ReportEnvironment {
	userAgent: string;
	serverSoftware: string;
	/** The pma_lang cookie, or null. */
	locale: string | null;
	phpVersion: string;
}

/** ErrorReport::getData('js'): empty when no exception was posted. */
export function jsErrorReport(exception: unknown, url: unknown, description: unknown, environment: ReportEnvironment): Nested {
	if ([undefined, null, '', '0'].includes(exception as string)) {
		return {};
	}
	const client = checkClient(environment.userAgent);
	const report: Nested = {
		pma_version: '5.2.3',
		browser_name: client.agent,
		browser_version: client.version,
		user_os: client.os,
		server_software: environment.serverSoftware,
		user_agent_string: environment.userAgent,
		locale: environment.locale,
		configuration_storage: 'disabled',
		php_version: environment.phpVersion,
	};
	const details: Nested = typeof exception === 'object' ? { ...exception as Nested } : {};
	if (details.stack !== undefined) {
		details.stack = translateStacktrace(details.stack);
	}
	if (details.url !== undefined) {
		const [uri, scriptName] = sanitizeUrl(String(details.url));
		details.uri = uri;
		report.script_name = scriptName;
		delete details.url;
	} else if (url !== undefined) {
		const [uri, scriptName] = sanitizeUrl(String(url));
		details.uri = uri;
		report.script_name = scriptName;
	} else {
		report.script_name = null;
	}
	report.exception_type = 'js';
	report.exception = details;
	if (description !== undefined && description !== '' && description !== '0') {
		report.steps = description;
	}
	return report;
}

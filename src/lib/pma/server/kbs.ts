// Port of MariaDbMySqlKbsProvider over williamdes/mariadb-mysql-kbs's merged-ultraslim.json, as bundled with phpMyAdmin 5.2.3.
import data from './kbs.json' with { type: 'json' };
import { type GeneratorState, showMySQLDocumentation } from '../../twig/html.ts';
import { linkUrl } from '../../twig/url.ts';

interface KbEntry {
	/** Index into urls. */
	u: number;
	/** Documentation flavour: 1 MySQL, 2 MariaDB, 3 Aurora MySQL. */
	t: number;
	/** Anchor. */
	a: string;
}

interface KbVariable {
	t?: number;
	a?: KbEntry[];
}

const MYSQL = 1;
const MARIADB = 2;
const AURORA_MYSQL = 3;

const kbs = data as unknown as { urls: string[]; varTypes: Record<string, string>; vars: Record<string, KbVariable>; };

function variable(name: string): KbVariable | undefined {
	if (!Object.hasOwn(kbs.vars, name)) {
		return undefined;
	}
	return kbs.vars[name];
}

/** Search::getByName() for one documentation flavour; null where it throws. */
function docLink(name: string, accept: (type: number) => boolean): string | null {
	for (const entry of variable(name)?.a ?? []) {
		if (accept(entry.t)) {
			return `${kbs.urls[entry.u]}#${entry.a}`;
		}
	}
	return null;
}

/** MariaDbMySqlKbsProvider::getVariableType(). */
export function getVariableType(name: string): string | null {
	const type = variable(name)?.t;
	if (type === undefined) {
		return null;
	}
	return kbs.varTypes[String(type)] as string;
}

/** MariaDbMySqlKbsProvider::getDocLinkByNameMysql(); Aurora pages count as MySQL ones. */
export function getDocLinkByNameMysql(name: string): string | null {
	return docLink(name, type => type === MYSQL || type === AURORA_MYSQL);
}

/** MariaDbMySqlKbsProvider::getDocLinkByNameMariaDb(). */
export function getDocLinkByNameMariaDb(name: string): string | null {
	return docLink(name, type => type === MARIADB);
}

/** Generator::linkToVarDocumentation(). */
export function linkToVarDocumentation(state: GeneratorState, name: string, useMariaDB = false, text: string | null = null): string {
	let link = getDocLinkByNameMysql(name);
	if (useMariaDB) {
		link = getDocLinkByNameMariaDb(name);
	}
	if (link !== null) {
		link = linkUrl(link);
	}
	return showMySQLDocumentation(state, name, false, link, text);
}

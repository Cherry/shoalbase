// Port of Controllers\Server\ShowEngineController (/server/engines/{engine}[/{page}]) with StorageEngine and the Engines\* classes.
import { selectMysqlForSuperUser } from './info-pages.ts';
import { renderServerTemplate } from './render.ts';
import serverData from '../../../../lib/pma/server/server-data.json' with { type: 'json' };
import { formatByteDown, formatNumber } from '../../../../lib/pma/util.ts';
import { showHint } from '../../../../lib/twig/html.ts';
import { htmlspecialchars, phpString } from '../../../../lib/twig/php.ts';
import { generatorState } from '../../core/generator.ts';
import { getStorageEngines, isValidStorageEngine } from '../../core/storage-engine.ts';

import type { PmaContext } from '../../core/context.ts';
import type { ControllerContext } from '../../dispatcher.ts';

const SUPPORT_NO = 0;
const SUPPORT_DISABLED = 1;
const SUPPORT_YES = 2;
const SUPPORT_DEFAULT = 3;

const DETAILS_TYPE_SIZE = 1;
const DETAILS_TYPE_NUMERIC = 2;

interface VariableDetails {
	title?: string;
	desc?: string;
	type?: number;
}

interface EngineData {
	variables: Record<string, VariableDetails | never[]>;
	like: string;
	infoPages: Record<string, string>;
	helpPage: string;
}

const ENGINE_DATA = serverData.engines as Record<string, EngineData>;

const SUPPORT_MESSAGES: Record<number, string> = {
	[SUPPORT_DEFAULT]: '%s is the default storage engine on this MySQL server.',
	[SUPPORT_YES]: '%s is available on this MySQL server.',
	[SUPPORT_DISABLED]: '%s has been disabled for this MySQL server.',
	[SUPPORT_NO]: 'This MySQL server does not support the %s storage engine.',
};

interface StorageEngine {
	engine: string;
	title: string;
	comment: string;
	support: number;
	/** The Engines\* class name, lowercased, or '' for the base StorageEngine. */
	kind: string;
	data: EngineData;
}

/** StorageEngine::getEngine(): the class picked by mb_strtolower($engine), whose name the JSON data is keyed by. */
function engineKind(engine: string): string {
	const name = engine.toLowerCase();
	if (name === 'mrg_myisam') {
		return 'mrgmyisam';
	}
	if (name === 'performance_schema') {
		return 'performanceschema';
	}
	if (name in ENGINE_DATA) {
		return name;
	}
	return '';
}

async function getEngine(context: PmaContext, engine: string): Promise<StorageEngine> {
	const kind = engineKind(engine);
	const data = ENGINE_DATA[kind] ?? { variables: {}, like: '', infoPages: {}, helpPage: '{engine}-storage-engine' };
	const engines = await getStorageEngines(context);
	const row = engines.get(engine);
	if (row === undefined) {
		return { engine: 'dummy', title: 'PMA Dummy Engine Class', comment: 'If you read this text inside phpMyAdmin, something went wrong...', support: SUPPORT_NO, kind, data };
	}
	let support = SUPPORT_NO;
	if (row.Support === 'DEFAULT') {
		support = SUPPORT_DEFAULT;
	} else if (row.Support === 'YES') {
		support = SUPPORT_YES;
	} else if (row.Support === 'DISABLED') {
		support = SUPPORT_DISABLED;
	}
	return { engine, title: phpString(row.Engine), comment: phpString(row.Comment), support, kind, data };
}

function getInfoPages(engine: StorageEngine): Record<string, string> {
	if ((engine.kind === 'innodb' || engine.kind === 'innobase') && engine.support < SUPPORT_YES) {
		return {};
	}
	return engine.data.infoPages;
}

/** Util::extractValueFromFormattedSize() for the PBXT sizes such as "32MB". */
function extractValueFromFormattedSize(size: string): number {
	const units: Record<string, number> = { KB: 1, MB: 2, GB: 3 };
	const match = /^(\d+)([KMG]B)$/.exec(size);
	if (match === null) {
		return -1;
	}
	return Number(match[1]) * (1024 ** units[match[2]]);
}

function resolveTypeSize(engine: StorageEngine, value: string): [string, string] | null {
	if (engine.kind === 'pbxt' && /^\d+[a-z]+$/i.test(value)) {
		return formatByteDown(extractValueFromFormattedSize(value));
	}
	return formatByteDown(value);
}

/** StorageEngine::getVariablesStatus(). */
async function getVariablesStatus(context: PmaContext, engine: StorageEngine): Promise<Map<string, Required<Omit<VariableDetails, 'desc'>> & { desc?: string; value: string; }>> {
	const { like } = engine.data;
	const result = await context.dbi.query(`SHOW GLOBAL VARIABLES ${like === '' ? '' : ` LIKE '${like}' `};`);
	const variables = new Map<string, Required<Omit<VariableDetails, 'desc'>> & { desc?: string; value: string; }>();
	for (const row of result.fetchAllAssoc()) {
		const name = phpString(row.Variable_name);
		const known = engine.data.variables[name] as VariableDetails | undefined;
		if (known === undefined && like === '' && !name.toLowerCase().startsWith(engine.engine.toLowerCase())) {
			continue;
		}
		const details = { ...known };
		variables.set(name, {
			...details,
			title: details.title === undefined || details.title === '' ? name : details.title,
			type: details.type ?? 0,
			value: phpString(row.Value),
		});
	}
	return variables;
}

/** StorageEngine::getHtmlVariables(). */
async function getHtmlVariables(context: PmaContext, engine: StorageEngine): Promise<string> {
	const state = generatorState(context);
	let output = '';
	const variables = await getVariablesStatus(context, engine);
	for (const details of variables.values()) {
		output += '<tr>\n    <td>\n';
		if (details.desc !== undefined && details.desc !== '') {
			output += `        ${showHint(state, details.desc)}\n`;
		}
		output += `    </td>\n    <th scope="row">${htmlspecialchars(details.title)}</th>\n    <td class="font-monospace text-end">`;
		if (details.type === DETAILS_TYPE_SIZE) {
			const size = resolveTypeSize(engine, details.value);
			if (size !== null) {
				output += `${size[0]}&nbsp;${size[1]}`;
			}
		} else if (details.type === DETAILS_TYPE_NUMERIC) {
			output += `${formatNumber(details.value)} `;
		} else {
			output += `${htmlspecialchars(details.value)}   `;
		}
		output += '</td>\n</tr>\n';
	}
	if (output === '') {
		return '<p>\n    There is no detailed status information available for this storage engine.\n</p>\n';
	}
	return `<table class="table table-striped table-hover w-auto">\n${output}</table>\n`;
}

function statusRow(label: string, value: string, newline = '\n'): string {
	return `        <tr>\n            <th scope="row">${label}</th>\n            <td class="font-monospace text-end">${value}${newline}</td>\n        </tr>`;
}

function percentage(part: number, whole: number): string {
	if (whole === 0) {
		return '---';
	}
	return `${htmlspecialchars(formatNumber(part * 100 / whole, 3, 2))} %`;
}

/** Innodb::getPageBufferpool(). */
async function getPageBufferpool(context: PmaContext): Promise<string> {
	const sql = String.raw`SHOW STATUS WHERE Variable_name LIKE 'Innodb\_buffer\_pool\_%' OR Variable_name = 'Innodb_page_size';`;
	const status = await context.dbi.fetchResult<string>(sql, 0, 1);
	const value = (name: string): number => Number(status.get(name) ?? 0);
	const count = (name: string): string => formatNumber(value(name), 0);
	const bytes = formatByteDown(value('Innodb_buffer_pool_pages_total') * value('Innodb_page_size')) ?? [];
	let output = '<table class="table table-striped table-hover w-auto float-start caption-top">\n'
		+ '    <caption>\n        Buffer Pool Usage\n    </caption>\n'
		+ '    <tfoot>\n        <tr>\n            <th colspan="2">\n'
		+ `                Total: ${count('Innodb_buffer_pool_pages_total')}&nbsp;pages / ${bytes.join('&nbsp;')}\n`
		+ '            </th>\n        </tr>\n    </tfoot>\n    <tbody>\n'
		+ `${statusRow('Free pages', count('Innodb_buffer_pool_pages_free'), '')}\n`
		+ `${statusRow('Dirty pages', count('Innodb_buffer_pool_pages_dirty'), '')}\n`
		+ `${statusRow('Pages containing data', count('Innodb_buffer_pool_pages_data'))}\n`
		+ `${statusRow('Pages to be flushed', count('Innodb_buffer_pool_pages_flushed'))}\n`
		+ statusRow('Busy pages', count('Innodb_buffer_pool_pages_misc'));
	if (status.has('Innodb_buffer_pool_pages_latched')) {
		output += '        <tr>            <th scope="row">Latched pages</th>            <td class="font-monospace text-end">'
			+ `${count('Innodb_buffer_pool_pages_latched')}</td>        </tr>`;
	}
	output += '    </tbody>\n</table>\n\n'
		+ '<table class="table table-striped table-hover w-auto ms-4 float-start caption-top">\n'
		+ '    <caption>\n        Buffer Pool Activity\n    </caption>\n    <tbody>\n'
		+ `${statusRow('Read requests', count('Innodb_buffer_pool_read_requests'))}\n`
		+ `${statusRow('Write requests', count('Innodb_buffer_pool_write_requests'))}\n`
		+ `${statusRow('Read misses', count('Innodb_buffer_pool_reads'))}\n`
		+ `${statusRow('Write waits', count('Innodb_buffer_pool_wait_free'))}\n`
		+ `${statusRow('Read misses in %', percentage(value('Innodb_buffer_pool_reads'), value('Innodb_buffer_pool_read_requests')))}\n`
		+ `${statusRow('Write waits in %', percentage(value('Innodb_buffer_pool_wait_free'), value('Innodb_buffer_pool_write_requests')))}\n`
		+ '    </tbody>\n</table>\n';
	return output;
}

/** Innodb::getPageStatus(). */
async function getPageStatus(context: PmaContext): Promise<string> {
	const status = await context.dbi.fetchValue('SHOW ENGINE INNODB STATUS;', 'Status');
	return `<pre id="pre_innodb_status">\n${htmlspecialchars(status === false ? '' : phpString(status))}\n</pre>\n`;
}

/** StorageEngine::getPage(). */
async function getPage(context: PmaContext, engine: StorageEngine, page: string): Promise<string> {
	if (!Object.hasOwn(getInfoPages(engine), page)) {
		return '';
	}
	if (page === 'Bufferpool') {
		return getPageBufferpool(context);
	}
	if (page === 'Status') {
		return getPageStatus(context);
	}
	return '<p>Documentation and further information about PBXT can be found on the '
		+ '<a href="./url.php?url=https%3A%2F%2Fmariadb.com%2Fkb%2Fen%2Fabout-pbxt%2F" rel="noopener noreferrer" target="_blank">'
		+ 'PrimeBase XT Home Page</a>.</p>\n';
}

async function showEngine(context: ControllerContext): Promise<Response> {
	await selectMysqlForSuperUser(context);
	const page = context.params.page ?? '';
	const name = context.params.engine ?? '';
	let engine: Record<string, unknown> | never[] = [];
	if (await isValidStorageEngine(context, name)) {
		const storageEngine = await getEngine(context, name);
		const pageHtml = page === '' || page === '0' ? '' : await getPage(context, storageEngine, page);
		engine = {
			engine: name,
			title: storageEngine.title,
			help_page: storageEngine.data.helpPage.replace('{engine}', () => storageEngine.engine),
			comment: storageEngine.comment,
			info_pages: getInfoPages(storageEngine),
			support: SUPPORT_MESSAGES[storageEngine.support].replace('%s', () => htmlspecialchars(storageEngine.title)),
			variables: await getHtmlVariables(context, storageEngine),
			page: pageHtml,
		};
	}
	context.response.addHTML(await renderServerTemplate(context, 'server/engines/show', { engine, page }));
	return context.response.response();
}

export const controllers = {
	'Server/ShowEngineController': showEngine,
};

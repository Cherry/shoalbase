// @vitest-environment node
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { renderHeaderMessage, renderLoadUserPreferences, renderRecentTable } from './header';
import { getGeneratorMessage, linkOrButton } from './header-message';
import { createConfig } from '../../../lib/pma/config';
import { Message } from '../../../lib/pma/message';
import { PmaSession } from '../../../lib/pma/session';
import { buildPmaRequest } from '../../../lib/pma-request';

import type { RequestParams } from '../../../lib/pma-request';
import type { PmaContext } from '../core/context';

const live = readFileSync(new URL('../../../../tests/fixtures/pma-5.2.3/home.live.html', import.meta.url), 'utf8');
const TOKEN = '304b74753071683670656e7632287b46';

interface FakeOptions {
	method?: 'GET' | 'POST';
	query?: RequestParams;
	post?: RequestParams;
	db?: string;
	table?: string;
	server?: number;
	sqlQuery?: string;
	haveProfiling?: string | false;
	config?: Record<string, unknown>;
	session?: PmaSession;
}

function fakeContext(options: FakeOptions = {}): PmaContext {
	const method = options.method ?? 'GET';
	const post = method === 'POST' ? { token: TOKEN, ...options.post } : {};
	const request = buildPmaRequest(method, options.query ?? {}, post, TOKEN);
	const config = { ...createConfig({ host: 'dbadmin-mysql', user: 'customer' }), ...options.config };
	const url = { server: options.server ?? 1, serverDefault: 1, lang: 'en', hasLangCookie: true, token: TOKEN };
	const profiling = options.haveProfiling ?? 'YES';
	return {
		request,
		config,
		db: options.db ?? '',
		table: options.table ?? '',
		server: url.server,
		urlState: () => url,
		templateState: async () => {
			return { url, config, mysqlVersion: 80413 };
		},
		session: options.session ?? new PmaSession(),
		dbi: { fetchValue: async () => profiling, getColumns: async (_db: string, table: string) => new Map(table === 'gone' ? [] : [['id', {}]]) },
		response: { isAjax: false, globals: { sqlQuery: options.sqlQuery ?? '' } },
	} as unknown as PmaContext;
}

describe('renderLoadUserPreferences', () => {
	it('offers the localStorage import like the 5.2.3 home page, since user preferences only live in the session', async () => {
		const html = await renderLoadUserPreferences(fakeContext({ query: { route: '/' } }));
		expect(html).toContain('id="prefs_autoload"');
		expect(live).toContain(html);
	});

	it('returns to the request with $_GET encoded by http_build_query, list parameters included', async () => {
		const html = await renderLoadUserPreferences(fakeContext({ query: { route: '/server/engines', x: ['1', 'b c'], e: '' } }));
		expect(html).toContain('name="return_url" value="index.php?route=%2Fserver%2Fengines&amp;x%5B0%5D=1&amp;x%5B1%5D=b+c&amp;e="');
	});

	it('drops $_GET when a POST has a bad token, as Sanitize::removeRequestVars() does', async () => {
		const context = fakeContext({ method: 'POST', query: { route: '/', ajax_request: '1' }, post: { token: 'bad' } });
		expect(await renderLoadUserPreferences(context)).toContain('name="return_url" value="index.php?ajax_request=1"');
		const withoutAjax = fakeContext({ method: 'POST', query: { route: '/' }, post: { token: 'bad' } });
		expect(await renderLoadUserPreferences(withoutAjax)).toContain('name="return_url" value="index.php?"');
	});

	it('stays hidden once the user declined the import, for the rest of the session', async () => {
		const session = new PmaSession();
		expect(await renderLoadUserPreferences(fakeContext({ query: { prefs_autoload: 'hide' }, session }))).toBe('');
		expect(session.data.userprefs_autoload).toBe(true);
		expect(await renderLoadUserPreferences(fakeContext({ session }))).toBe('');
		expect(await renderLoadUserPreferences(fakeContext({ server: 0 }))).toBe('');
	});
});

describe('renderRecentTable', () => {
	it('links to the recent-table refresh, since without pmadb adding to the list always succeeds', async () => {
		expect(await renderRecentTable(fakeContext({ db: 'customer_db', table: 'players' })))
			.toBe('<a class="hide" id="update_recent_tables" href="index.php?route=/recent-table&ajax_request=1&recent_table=1"></a>');
		expect(await renderRecentTable(fakeContext({ query: { recent_table: '0' } }))).toContain('update_recent_tables');
	});

	it('puts existing tables first in the session list, which is per server', async () => {
		const session = new PmaSession();
		await renderRecentTable(fakeContext({ db: 'customer_db', table: 'players', session }));
		await renderRecentTable(fakeContext({ db: 'customer_db', table: 'gone', session }));
		await renderRecentTable(fakeContext({ db: 'customer_db', table: 'scores', session }));
		expect(session.data.tmpval?.recentTables).toEqual({ 1: [{ db: 'customer_db', table: 'scores' }, { db: 'customer_db', table: 'players' }] });
	});

	it('skips the link for the recent-table request itself and when recent tables are turned off', async () => {
		expect(await renderRecentTable(fakeContext({ query: { recent_table: '1' } }))).toBe('');
		expect(await renderRecentTable(fakeContext({ query: { recent_table: ['1'] } }))).toBe('');
		expect(await renderRecentTable(fakeContext({ config: { NumRecentTables: 0 } }))).toBe('');
	});
});

describe('renderHeaderMessage', () => {
	it('shows the request message with BBCode applied and HTML escaped', async () => {
		expect(await renderHeaderMessage(fakeContext({ query: { message: 'Hi [em]there[/em] <b>' } })))
			.toBe('<div class="alert alert-primary" role="alert">Hi <em>there</em> &lt;b&gt;</div>');
	});

	it('prefers the controller message and ignores empty values the way PHP empty() does', async () => {
		const context = fakeContext({ query: { message: 'from request' } });
		expect(await renderHeaderMessage(context, Message.success('Saved'))).toContain('Saved');
		expect(await renderHeaderMessage(context, '0')).toContain('from request');
		expect(await renderHeaderMessage(fakeContext({ query: { message: '0' } }))).toBe('');
		expect(await renderHeaderMessage(fakeContext({ query: { message: ['x'] } }))).toBe('');
		expect(await renderHeaderMessage(fakeContext())).toBe('');
	});
});

describe('getGeneratorMessage', () => {
	it('matches 5.2.3 for a server-level SELECT, with Explain, Refresh and the profiling checkbox', async () => {
		const html = await getGeneratorMessage(fakeContext({ sqlQuery: 'SELECT 1' }), 'Hi');
		expect(html).toBe(`<div class="result_query">
<div class="alert alert-primary" role="alert">Hi</div><div class="sqlOuter"><code class="sql" dir="ltr"><pre>
SELECT 1
</pre></code></div><div class="tools d-print-none"><form action="index.php?route=/sql&db=&table=" method="post" class="disableAjax"><input type="hidden" name="token" value="${TOKEN}"><input type="hidden" name="sql_query" value="SELECT 1"><input type="hidden" name="profiling_form" value="1"><input type="checkbox" name="profiling" id="profilingCheckbox" class="autosubmit"> <label for="profilingCheckbox">Profiling</label></form> [&nbsp;<a href="#" class="inline_edit_sql">Edit inline</a>&nbsp;] [&nbsp;<a href="index.php" data-post="route=/server/sql&sql_query=SELECT+1&show_query=1">Edit</a>&nbsp;] [&nbsp;<a href="index.php" data-post="route=/import&sql_query=EXPLAIN+SELECT+1">Explain SQL</a>&nbsp;] [&nbsp;<a href="index.php" data-post="route=/import&sql_query=SELECT+1&show_query=1&show_as_php=1">Create PHP code</a>&nbsp;] [&nbsp;<a href="index.php" data-post="route=/sql&sql_query=SELECT+1&show_query=1">Refresh</a>&nbsp;]</div></div>`);
	});

	it('matches 5.2.3 for an EXPLAIN on a table, including the Skip Explain link without its closing space', async () => {
		const sqlQuery = 'EXPLAIN SELECT * FROM players WHERE name = \'a"b\' <x>';
		const html = await getGeneratorMessage(fakeContext({ sqlQuery, db: 'customer_db', table: 'players' }), 'Done');
		expect(html).toBe(`<div class="result_query">
<div class="alert alert-primary" role="alert">Done</div><div class="sqlOuter"><code class="sql" dir="ltr"><pre>
EXPLAIN SELECT * FROM players WHERE name = 'a&quot;b' &lt;x&gt;
</pre></code></div><div class="tools d-print-none"><form action="index.php?route=/sql&db=customer_db&table=players" method="post" class="disableAjax"><input type="hidden" name="db" value="customer_db"><input type="hidden" name="table" value="players"><input type="hidden" name="token" value="${TOKEN}"><input type="hidden" name="sql_query" value="EXPLAIN SELECT * FROM players WHERE name = &#039;a&quot;b&#039; &lt;x&gt;"></form> [&nbsp;<a href="#" class="inline_edit_sql">Edit inline</a>&nbsp;] [&nbsp;<a href="index.php" data-post="route=/table/sql&db=customer_db&table=players&sql_query=EXPLAIN+SELECT+%2A+FROM+players+WHERE+name+%3D+%27a%22b%27+%3Cx%3E&show_query=1">Edit</a>&nbsp;] [&nbsp;<a href="index.php" data-post="route=/import&db=customer_db&table=players&sql_query=SELECT+%2A+FROM+players+WHERE+name+%3D+%27a%22b%27+%3Cx%3E">Skip Explain SQL</a>] [&nbsp;<a href="index.php" data-post="route=/import&db=customer_db&table=players&sql_query=EXPLAIN+SELECT+%2A+FROM+players+WHERE+name+%3D+%27a%22b%27+%3Cx%3E&show_query=1&show_as_php=1">Create PHP code</a>&nbsp;]</div></div>`);
	});

	it('truncates queries over MaxCharactersInDisplayedSQL by characters and keeps only Edit and Refresh', async () => {
		const sqlQuery = `SELECT '${'é'.repeat(20)}'`;
		const html = await getGeneratorMessage(fakeContext({ sqlQuery, config: { MaxCharactersInDisplayedSQL: 10 } }), 'big');
		expect(html).toContain('<code class="sql" dir="ltr"><pre>\nSELECT \'éé[...]</pre></code>');
		expect(html).toContain('>Edit</a>');
		expect(html).toContain('>Refresh</a>');
		expect(html).not.toContain('Edit inline');
		expect(html).not.toContain('Explain SQL');
		expect(html).not.toContain('Create PHP code');
	});

	it('uses the database SQL page for edits and leaves out profiling and Refresh for writes', async () => {
		const html = await getGeneratorMessage(fakeContext({ sqlQuery: 'INSERT INTO t VALUES (1)', db: 'shop' }), 'ok');
		expect(html).toContain('data-post="route=/database/sql&db=shop&sql_query=INSERT+INTO+t+VALUES+%281%29&show_query=1">Edit</a>');
		expect(html).not.toContain('profiling');
		expect(html).not.toContain('Refresh');
	});

	it('leaves out the profiling checkbox when the server has no @@have_profiling', async () => {
		const html = await getGeneratorMessage(fakeContext({ sqlQuery: 'SHOW TABLES', haveProfiling: false }), 'ok');
		expect(html).toContain('>Refresh</a>');
		expect(html).not.toContain('profiling');
	});

	it('shows the query as PHP code with the matching links when show_as_php is set', async () => {
		const html = await getGeneratorMessage(fakeContext(), 'ok', { sqlQuery: 'SELECT "a"\nFROM t', showAsPhp: true });
		expect(html).toContain('<code class="php" dir="ltr"><pre>\n$sql = "SELECT \\&quot;a\\&quot;\\n"<br>\n&nbsp;&nbsp;&nbsp;&nbsp;. "FROM t";\n</pre></code>');
		expect(html).toContain('>Without PHP code</a>&nbsp;] [&nbsp;<a href="index.php" data-post="route=/import&sql_query=SELECT+%22a%22%0AFROM+t&show_query=1">Submit query</a>');
		expect(html).not.toContain('>Edit</a>');
		expect(html).not.toContain('Refresh');
		const slashed = await getGeneratorMessage(fakeContext(), 'ok', { sqlQuery: 'SELECT \'\\\0\'', showAsPhp: true });
		expect(slashed).toContain(String.raw`$sql = "SELECT \&#039;\\\0\&#039;";`);
	});

	it('keeps Refresh only while show_as_php is unset, even when it is set to an empty value', async () => {
		const html = await getGeneratorMessage(fakeContext(), 'ok', { sqlQuery: 'SELECT 1', showAsPhp: false });
		expect(html).toContain('Create PHP code');
		expect(html).not.toContain('Refresh');
	});

	it('renders only the message box for an error without a query, or for a lone semicolon', async () => {
		expect(await getGeneratorMessage(fakeContext(), 'bad', { type: 'error' })).toBe('<div class="alert alert-danger" role="alert">bad</div>');
		expect(await getGeneratorMessage(fakeContext({ sqlQuery: ';' }), 'ok', { type: 'success' })).toBe('<div class="alert alert-success" role="alert">ok</div>');
		expect(await getGeneratorMessage(fakeContext({ sqlQuery: 'SELECT 1', config: { ShowSQL: false } }), 'x')).not.toContain('result_query');
	});
});

describe('linkOrButton', () => {
	it('keeps short links as plain hrefs and posts long ones, unsigned queries and view[as] forms', () => {
		expect(linkOrButton('index.php?route=/a', 'A', 1000)).toBe('<a href="index.php?route=/a" >A</a>');
		expect(linkOrButton('index.php?route=/a&b=1', 'A', 10)).toBe('<a href="index.php" data-post="route=/a&b=1">A</a>');
		expect(linkOrButton('index.php?sql_query=1&sql_signature=x', 'A', 1000)).toBe('<a href="index.php?sql_query=1&sql_signature=x" >A</a>');
		expect(linkOrButton('index.php?view[as]=1', 'A', 1000, { title: 'a"b' })).toBe('<a href="index.php" data-post="view[as]=1" title="a&quot;b">A</a>');
		expect(linkOrButton('#'.repeat(5), 'A', 2)).toBe('<a href="#####" data-post="">A</a>');
	});
});

describe('getGeneratorMessage profiling', () => {
	it('ticks the profiling checkbox while the session has profiling on', async () => {
		const session = new PmaSession({ profiling: true });
		const html = await getGeneratorMessage(fakeContext({ sqlQuery: 'SELECT 1', session }), 'Hi');
		expect(html).toContain('<input type="checkbox" name="profiling" id="profilingCheckbox" class="autosubmit" checked>');
	});
});

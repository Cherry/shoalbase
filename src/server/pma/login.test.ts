// @vitest-environment node
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { renderLoginForm, renderLoginPage } from './login';

const fixture = (name: string): string => readFileSync(new URL(`../../../tests/fixtures/pma-5.2.3/${name}`, import.meta.url), 'utf8');

// Session-bound values in the capture: the CSRF token and the set_session field (a PHP session id).
function normalize(html: string): string {
	return html
		.replaceAll(/(name="token" value=")[0-9a-f]{32}"/g, '$1TOKEN"')
		.replaceAll(/(token:")[0-9a-f]{32}"/g, '$1TOKEN"')
		.replaceAll(/(name="set_session" value=")[0-9a-f]{32}"/g, '$1SESSION"');
}

const servers = [{ index: 1, host: 'dbadmin-mysql' }, { index: 2, host: 'dbadmin-mysql-b' }];
// The capture was a first visit: no pma_lang cookie yet.
const firstVisit = { url: { token: '0123456789abcdef0123456789abcdef', hasLangCookie: false } };

describe('login page', () => {
	it('reproduces the live phpMyAdmin 5.2.3 login page, apart from session-bound values', async () => {
		const html = await renderLoginPage({ servers, selectedServer: 1, state: firstVisit });
		expect(normalize(html)).toBe(normalize(fixture('login.page.html')));
	});

	it('uses the token as the set_session value', async () => {
		const html = await renderLoginForm({ servers, selectedServer: 1, state: firstVisit });
		expect(html).toContain('<input type="hidden" name="set_session" value="0123456789abcdef0123456789abcdef">');
	});

	it('shows connection errors raw above the form and display errors below it', async () => {
		const html = await renderLoginForm({
			servers,
			selectedServer: 2,
			defaultUser: 'bob',
			error: 'Cannot log in to the MySQL server<br>mysqli::real_connect(): (HY000/1045)',
			displayErrors: '<div class="alert alert-danger">E_WARNING</div>',
			db: 'shop',
			table: 'orders',
			state: firstVisit,
		});
		expect(html).toContain('<div class="alert alert-danger" role="alert">\n  <img src="themes/dot.gif" title="" alt="" class="icon ic_s_error"> Cannot log in to the MySQL server<br>mysqli::real_connect(): (HY000/1045)\n</div>');
		expect(html).toContain('<div id="pma_errors">\n    <div class="alert alert-danger">E_WARNING</div>\n  </div>');
		expect(html).toContain('value="bob"');
		expect(html).toContain('<input type="hidden" name="db" value="shop"><input type="hidden" name="table" value="orders">');
		expect(html).toMatch(/value="2"\s+selected="selected"/);
	});

	it('shows the session expired notice and the modal variant for AJAX re-login', async () => {
		const notice = await renderLoginForm({ servers, selectedServer: 1, sessionExpiredNotice: true, state: firstVisit });
		expect(notice).toContain('class="icon ic_s_error"> Your session has expired. Please log in again.');
		const modal = await renderLoginForm({ servers, selectedServer: 1, sessionTimedOut: true, state: firstVisit });
		expect(modal).toContain('<div id="modalOverlay">');
		expect(modal).toContain('<div class="container modal_form">');
		expect(modal).toContain('<input type="hidden" name="session_timedout" value="1">');
		expect(modal).toContain('class="js-show"');
	});

	it('uses a hidden server field when there is only one server', async () => {
		const html = await renderLoginForm({ servers: [servers[0]], selectedServer: 1, state: firstVisit });
		expect(html).toContain('<input type="hidden" name="server" value="1">');
		expect(html).not.toContain('select_server');
	});
});

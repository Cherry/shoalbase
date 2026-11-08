# Parity with phpMyAdmin 5.2.3

The target is the official `phpmyadmin:5.2.3` image with one fixed configuration: cookie authentication, no configuration storage database (pmadb), `ShowServerInfo = false`, `DisplayServersList = false` and `MaxExactCount = 0` (`docker/pma/config.user.inc.php`). A user should not be able to tell the two apart. The same URL returns the same status, headers and markup, and the same JavaScript runs on top of it. Comments in the code that say "production" mean this configuration.

## What is served

The Worker serves phpMyAdmin's docroot and nothing else:

| Path | Upstream | Port |
| --- | --- | --- |
| `/`, `/index.php` | `index.php` (`/` through Apache's `DirectoryIndex`) | `src/pages/index.ts`, `src/pages/index.php.ts` → `src/server/pma/dispatcher.ts` |
| `/url.php` | `url.php` (`UrlRedirector`) | `src/pages/url.php.ts` |
| `/js/messages.php` | `js/messages.php` (`JavaScriptMessagesController`) | `src/pages/js/messages.php.ts` |
| `/themes/…`, `/js/…`, `/doc/…`, `/favicon.ico` | static files | `public/` (vendored unmodified) |
| anything else | Apache 404 | plain 404 from `src/middleware.ts` |

Inside `index.php`, every route of `libraries/routes.php` (`src/server/pma/upstream-routes.ts`) maps to a controller under `src/server/pma/controllers/**`, keyed by the upstream class name. Unknown routes and wrong methods get phpMyAdmin's own "Error 404!" and "Error 405!" pages inside the normal shell. Signed-out requests get the login form at whatever URL was requested, and AJAX requests get `redirect_flag`, as in upstream. A route of the table without a controller module is answered as an unknown route.

## How parity is checked

All of these run against `docker/compose.yaml` (`npm run db:up`): MySQL 8.4, MariaDB 12.3 over TLS, MySQL 5.7, and the 5.2.3 oracle on port 8088. Its seed creates `customer_db` with a `players` table and these accounts:

| Account | Password | Privileges |
| --- | --- | --- |
| `customer` | `customerpw` | `ALL` on `customer_db` |
| `pma_grant` | `grantpw` | `ALL` on `customer_db` `WITH GRANT OPTION` |
| `pma_creator` | `creatorpw` | `CREATE USER`, plus `ALL` on `customer_db` |
| `root` | `DBADMIN_ROOT_PASSWORD` (default `dbadmin-root`) | everything; the harnesses read it from the container |

- **Oracle diffs.** `scripts/pma-diff.mjs` requests the same route from the oracle and from our dispatcher in Node (`scripts/render-route.ts`), signed in as the same account on the same database, and diffs status, headers and body. `--server` picks the database server, `--user` the account and `--before` replays earlier steps of a session flow first. This is the main check for each ported controller.
- **Fixtures.** `tests/fixtures/pma-5.2.3/` holds captures from a live 5.2.3 instance (login page, home page, messages) that unit tests compare byte for byte.
- **Unit tests.** `src/lib/**` holds the pure logic (template helpers, request parsing, routing, auth, TLS, and the PHP class ports) under a 100% statements, branches, functions and lines gate. Rendering and database code lives in `src/server/**`.
- **Worker build.** The Node harness does not catch bundling problems, so routes are also checked in workerd: `npm run build`, `npx wrangler dev -c dist/server/wrangler.json`, then `npm run test:live -- <baseUrl>` (`tests/live-smoke.ts`). It covers the docroot, login, tampered cookies, logout and cookies copied before logout, then crawls every GET route through `index.php`. With `npm run dev-vars`, servers 1 to 4 are MySQL 8.4 plain and over TLS, MariaDB over TLS and MySQL 5.7 over TLS.
- **Screens.** `tests/visual` (`npm run test:visual`, after `npm run build`) compares full-page screenshots of 52 screens pixel by pixel against the oracle with Playwright, including the root-only Privileges and Replication pages, plus interaction checks (inline edit, sorting, paging, console, navigation tree, insert, drop).
- **Crawl.** `npm run parity:crawl` creates scratch objects on each server, runs about 270 `pma-diff` cases per server and writes `tests/parity-report/summary.md` with a diff for each case that is not identical. `-- --user root` runs it as root, so the administrator pages are covered too. Live counters, process lists and InnoDB monitor output differ between any two requests and show up as noise.

CI (`.github/workflows/ci.yml`) runs lint, types, the unit tests and the build on every push. A second job starts the Docker stack and runs the live smoke on all four servers and the visual suite. Run it manually with `crawl` checked to add both crawls; the reports are uploaded as artifacts.

## Known differences

- A small "via Shoalbase" credit sits under phpMyAdmin's logo in the navigation panel and on the login page, so users can tell the two apart. The Worker adds it to full HTML pages on the way out (`src/server/branding.ts`), so the oracle diffs never see it, and the visual suite hides it.
- No pmadb. Features that need it (bookmarks, history, relations stored in pmadb, tracking, designer pages, user groups) behave as upstream does when it is not configured.
- Sessions follow upstream's model with a Durable Object in place of the PHP session file: the `phpMyAdmin` cookie holds a session id in PHP's format, the session object holds `$_SESSION` (including `encryption_key` and `browser_access_time`), `pmaAuth-<n>` holds the password encrypted with the session's key and `pmaUser-<n>` the username encrypted with `PMA_COOKIE_SECRET`, with upstream's names (`__Secure-…_https` over HTTPS), lifetimes and flags. Login starts a new session, logout deletes it, and inactivity follows `browser_access_time` and `LoginCookieValidity` as in `AuthenticationCookie::readCredentials()`. What still differs:
  - Cookie values are AES-GCM in base64url rather than sodium secretbox in base64, so they are not interchangeable with phpMyAdmin's. The login cookies are also bound to the server's host and port, so renumbering servers in `PMA_SERVERS` signs their users out.
  - PHP sends the `phpMyAdmin` cookie up to three times in one response (session start, then `Session::secure()`); the port sends the final value once. A signed-out page gets a fresh id but no session object until someone logs in.
  - When the idle poll finds a session expired, upstream answers with its AJAX re-login dialog, which is not ported. The port answers with `redirect_flag`, and the page that reloads shows the login form with the same inactivity notice.
  - PHP deletes expired session files at random (`session.gc_probability`); the session object's alarm deletes its storage 5 minutes after the session expired. Until then the next request still gets the inactivity notice.
  - A session larger than 1 MiB is not stored again (upstream has no limit); phpMyAdmin's own data stays far below it.
  - The login form POST is accepted without the login page's token, since the port creates no session before login. Astro's `Origin` check (below) still refuses cross-site posts.
- Upstream only treats an account as a grant or create-user account when it can also read `mysql.user`, so an account with `WITH GRANT OPTION` on its own database alone gets "No Privileges", in 5.2.3 and here alike. Accounts that pass the check get the full Privileges UI.
- Replication's change-primary branch for `$cfg['AllowArbitraryServer'] = true` (connecting to the new primary) is not ported. With the supported value (false) the port shows upstream's "Connection to server is disabled" error.
- Two-factor authentication setup is not ported.
- PDF exports and PDF schemas use Helvetica instead of embedded DejaVu subsets, so characters outside WinAnsi print as "?". Layout, wrapping and page breaks follow DejaVu widths and match TCPDF.
- Zip, gzip, ODS and ODT exports use a port of zlib's deflate (`src/lib/pma/export-import/zlib-deflate.ts`) so the bytes match PHP. It is slower than native compression, so very large compressed exports use more CPU time.
- Astro's `checkOrigin` rejects cross-origin form POSTs with 403. Upstream relies on its token alone. Browsers send a matching `Origin` on same-origin POSTs, so this only affects scripted clients.
- PHP warnings that upstream shows in the AJAX `errors` block (for example after a fresh session) are not emulated.
- `$cfg` defaults come from 5.2.3's `config.default.php` (`src/lib/pma/config-defaults.ts`, regenerated by `scripts/generate-pma-config.mjs`) with the configuration above applied in code. PHP settings such as `upload_max_filesize` are constants matching the official image.

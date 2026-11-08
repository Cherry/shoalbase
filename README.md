# Shoalbase

phpMyAdmin 5.2.3, ported to TypeScript and running on Cloudflare Workers. It renders phpMyAdmin's own templates, themes and JavaScript, so it looks and behaves like the PHP version, but needs no PHP or web server: each phpMyAdmin session lives in its own Durable Object. Users sign in with their own MySQL or MariaDB credentials, and the Worker connects to the database over TCP from Cloudflare's network.

Every route of phpMyAdmin 5.2.3 is ported and checked against a live 5.2.3 instance, page by page and pixel by pixel. [docs/PARITY.md](docs/PARITY.md) describes how, and lists the known differences.

> [!NOTE]
> **Heads-up:** this project was primarily AI-authored. The port, tests, tooling, and this README were written by AI coding agents in interactive sessions, with a human operator directing the work, reviewing output, and validating pages against a real phpMyAdmin 5.2.3. Read the code before trusting it in production.

## Get started

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Cherry/shoalbase)

The button copies this repository to your GitHub account and deploys it with Workers Builds. It asks for the two secrets described under [Configuration](#configuration).

Or set it up from a terminal:

```sh
npx shoalbase my-shoalbase
```

This clones the latest release into `my-shoalbase`, installs it, asks for your servers (and checks the certificate of each MySQL server over TLS), writes `.dev.vars` with a new cookie secret, and offers to deploy it to your Cloudflare account.

You need:

- Node.js 24 or later, and git.
- A Cloudflare account to deploy. Local development runs in workerd through `wrangler dev`, without an account.
- MySQL or MariaDB servers reachable from the internet over TCP. The tests run against MySQL 5.7 and 8.4 and MariaDB 12.3.
- Docker, only to run the tests that compare against phpMyAdmin.

## Configuration

The Worker reads two secrets. Locally they go in `.dev.vars` (see `.dev.vars.example`). For a deployment, set them with `npx wrangler secret put <name>`, or pass the whole file with `npm run deploy -- --secrets-file .dev.vars`.

| Name | Required | Value |
| --- | --- | --- |
| `PMA_COOKIE_SECRET` | yes | At least 32 random characters. It encrypts the username cookie, like phpMyAdmin's `blowfish_secret`. Changing it signs everyone out. |
| `PMA_SERVERS` | yes | A JSON array of the servers users can sign in to. |

Sessions also need the `PMA_SESSIONS` Durable Object binding. It is declared in `wrangler.jsonc` together with its migration, so `wrangler deploy`, `wrangler dev` and the Deploy button create it, and there is nothing to set up. See [Authentication and connections](#authentication-and-connections).

Each `PMA_SERVERS` entry has these fields:

| Field | Default | Meaning |
| --- | --- | --- |
| `host` | | Host name or IP address. |
| `port` | `3306` | TCP port. |
| `ssl` | `false` | Connect over TLS. |
| `pin` | | For a MySQL server over TLS: the base64 SHA-256 of its certificate's public key. See [TLS](#tls). |

For example:

```json
[
	{ "host": "mysql.example.com" },
	{ "host": "secure.example.com", "ssl": true, "pin": "Gy789bwh929fkWB/9h3N1oUYTB78tiH3waOuO1sGVQw=" },
	{ "host": "mariadb.example.com", "port": 3307, "ssl": true }
]
```

The login form lists the servers sorted by host. A server's number is its place in that order, and the login cookies are bound to its host and port, so a change to `PMA_SERVERS` that renumbers a server signs its users out rather than sending their password to another server. phpMyAdmin's own settings are fixed to the configuration this port reproduces: cookie login, no configuration storage database (pmadb), no empty passwords, and server details hidden on the home page. They are in `src/lib/pma/config.ts`.

### TLS

Many MySQL and MariaDB servers present self-signed certificates, which the Workers runtime's TLS rejects. So TLS runs in-process (`src/lib/tls/`, driven by `src/server/mysql-connector.ts`) over a plain TCP socket: TLS 1.3, and TLS 1.2 with (EC)DHE and AES-GCM only. Every handshake signature is verified against the certificate's key, and that key is trusted in one of two ways:

- **MySQL** servers need a `pin`. MySQL's auto-generated certificates persist across restarts and upgrades. Get the pin with `node scripts/collect-tls-pins.ts <host>[:port]`. If a server's certificate is regenerated, logins fail with a pin mismatch until the pin is updated.
- **MariaDB** 11.4 and later regenerate their zero-config certificate on every restart, so they are not pinned. Instead the client checks the proof MariaDB sends after authentication, made from the password hash, the scramble and the certificate fingerprint. A man-in-the-middle certificate is rejected before any query runs. This needs a `mysql_native_password` account with a password.
- A TLS server with neither is refused.

## Development

```sh
npm install
npm run db:up      # MySQL 8.4, MariaDB 12.3, MySQL 5.7 and a phpMyAdmin 5.2.3 oracle in Docker
npm run dev-vars   # writes .dev.vars for those servers
npm run dev
```

Sign in as `customer` with password `customerpw`. [docs/PARITY.md](docs/PARITY.md) lists the other test accounts. `npm run db:down` removes the containers and their data.

`npm run dev` runs Astro's dev server in workerd through the Cloudflare Vite plugin, with the session Durable Object. Bundling problems only show up in the built Worker, so check that too: `npm run build`, then `npx wrangler dev -c dist/server/wrangler.json`. The build copies `.dev.vars` into `dist/server/`, so build again after changing it.

To deploy, run `npm run build`, then `npm run deploy` (which runs `wrangler deploy`). Set the two secrets first, or add `-- --secrets-file .dev.vars` to upload them with the deployment.

### How it works

The app is shaped like phpMyAdmin's docroot behind Apache:

- `/` and `/index.php` both run phpMyAdmin's front controller. `src/server/pma/dispatcher.ts` routes `index.php?route=…` against the upstream route table (`src/server/pma/upstream-routes.ts`, generated from `libraries/routes.php` by `scripts/generate-upstream-routes.ts`). It enforces phpMyAdmin's CSRF token rules, renders the login form when signed out, handles logout, and answers unknown routes and methods with phpMyAdmin's own 404 and 405 pages.
- `/url.php` and `/js/messages.php` are the two scripts that run without a login.
- Themes, JavaScript and docs are static files in `public/`, at the same URLs phpMyAdmin uses.
- Any other path is a plain 404, as Apache would answer.

Controllers live in `src/server/pma/controllers/**`. Each module exports `controllers`, keyed by the upstream controller class, and the dispatcher discovers them. The shared foundation (request context, `DatabaseInterface`, `ResponseRenderer`, session, and the Table, Index, Util and Generator ports) is described in `src/server/pma/core/README.md`. The SQL parser port is in `src/sql-parser`.

Pages render phpMyAdmin's own Twig templates (`vendor/phpmyadmin-5.2.3/templates`) with Twing. `npm run templates` precompiles them to ASTs at build time, because parsing them at runtime would need `eval`, which Workers forbid. It runs automatically before build, dev, test and lint.

### Authentication and connections

Sessions follow phpMyAdmin's cookie authentication, with a Durable Object in place of PHP's session file:

- The `phpMyAdmin` cookie holds a random session id. It names one SQLite-backed Durable Object (`src/server/session-object.ts`, bound as `PMA_SESSIONS`) through a SHA-256 of the id, and that object holds the whole `$_SESSION`: the CSRF token, the access times, user preferences, browse settings and so on.
- `pmaAuth-<server>` holds the password, AES-GCM encrypted with a random key that only the session object knows, and ends with the browser session. `pmaUser-<server>` holds the username, encrypted with `PMA_COOKIE_SECRET`, for a month, so the login form can fill it in again. Both are `HttpOnly` and `SameSite=Strict`, and are encrypted again on every request, as upstream does.
- A session expires after `LoginCookieValidity` (1440 seconds, or the user's own preference) without activity in any browser window, and the next request shows phpMyAdmin's inactivity notice. An alarm deletes the object's storage 5 minutes after that, like PHP's session garbage collection.
- Logging in starts a new session with a new id. Logging out deletes the session object and the password cookies, so copies of the cookies stop working at once.

`src/middleware.ts` loads the session with one call to its object at the start of each `index.php` request, and the dispatcher stores what changed with a second call only when `$_SESSION` changed. `npm run test:workers` tests the session object and this request side in workerd, with the real SQLite storage and alarms. Node has no Durable Objects, so `scripts/render-route.ts` (used by `pma-diff` and the crawl) runs the same class on an in-memory stand-in (`scripts/stubs/durable-objects.ts`).

For a signed-in request, the middleware also prepares one TCP connection with `cloudflare:sockets`. It opens on the first query, every query of the request reuses it, and it closes once the response body has been sent.

## Testing

| Command | Needs | What it checks |
| --- | --- | --- |
| `npm run lint` | | ESLint and `astro check`. |
| `npm test` | | Unit tests in Node. `npm run test:coverage` adds the 100% coverage gate for `src/lib/**`. |
| `npm run test:workers` | | The session Durable Object and session cookies in workerd, with `@cloudflare/vitest-plugin` (`vitest.workers.config.ts`, `tests/workers/`). |
| `node scripts/pma-diff.ts <route> [key=value ...]` | Docker stack | One route, rendered by the oracle and by our dispatcher in Node, diffed. See the header of `scripts/pma-oracle.ts` for the options. |
| `npm run test:live -- <baseUrl>` | Docker stack, a running build | The docroot, login, tampered cookies, logout, and every GET route, in the built Worker. `LIVE_SERVER` picks the server (1-based). |
| `npm run test:visual` | Docker stack, `npm run build` | Pixel comparison of screens and interactions against the oracle, with Playwright. |
| `npm run parity:crawl` | Docker stack | About 270 diffed cases per server, written to `tests/parity-report/`. |

On every push and pull request, CI runs lint, the unit tests with coverage, the workerd tests, the build, the live smoke on all four servers and the visual suite. The crawl runs when the workflow is started by hand. See `.github/workflows/ci.yml`.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Please report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).

## License

GPL-3.0-or-later. This project translates and includes phpMyAdmin (GPL-2.0-or-later) and translates parts of TCPDF (LGPL-3.0-or-later); see [NOTICE](NOTICE) for these and the other third-party licenses. phpMyAdmin is a trademark of the phpMyAdmin project, and this project is not affiliated with or endorsed by it.

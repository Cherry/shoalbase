# Contributing

The goal of this project is parity: for the same request, the Worker should answer exactly as phpMyAdmin 5.2.3 does. A change is correct when it brings a route closer to the oracle, not when it improves on phpMyAdmin. Bugs that phpMyAdmin 5.2.3 also has are kept, unless they are security issues.

## Setup

```sh
npm install
npm run db:up
npm run dev-vars
```

This starts MySQL 8.4, MariaDB 12.3, MySQL 5.7 and a phpMyAdmin 5.2.3 oracle at http://127.0.0.1:8088/ in Docker, seeded with the test accounts listed in [docs/PARITY.md](docs/PARITY.md).

## Porting or fixing a route

1. Find the upstream controller in `vendor/phpmyadmin-5.2.3/libraries/classes/` and the route in `src/server/pma/upstream-routes.ts`.
2. Port it under `src/server/pma/controllers/`, reusing the shared classes in `src/server/pma/core/` and `src/lib/pma/`. Put logic that does not touch the database in `src/lib/` with unit tests.
3. Compare against the oracle with `node scripts/pma-diff.mjs`. Check other servers (`--server 2`, `--server 3`) and accounts (`--user root`) where the page differs by server or privilege.
4. Run the gates below.

## Before opening a pull request

```sh
npm run lint
npm run test:coverage
npm run test:workers
npm run build
```

For changes to pages, also run `npm run test:live` against `npx wrangler dev -c dist/server/wrangler.json`, and `npm run test:visual`. CI runs all of these.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).

## Releases

Every push to `main` that passes CI runs semantic-release. A `feat` or `fix` commit tags a new version, writes the GitHub release notes, and publishes the `shoalbase` package to npm with trusted publishing. Commits that only touch `website/` never release, since the site deploys on its own (`scripts/release-commits.mjs`).

The npm package is only the installer in `bin/`, which clones the tag of its own version. Everything the Worker needs, including `mysql2` and `twing`, is a devDependency: the build bundles it, and `npx shoalbase` installs nothing.

By contributing, you agree that your contribution is licensed under GPL-3.0-or-later, the license of this project.

# Shared phpMyAdmin core

Ports of the upstream classes every controller family needs. Look here before writing a helper. DB-touching code lives in this folder; pure logic lives in `src/lib/pma/`.

## Request context (`context.ts`)

`PmaContext` holds `request`, `config` (`$cfg` after user preferences), `baseConfig` (`$cfg` before them), `dbi`, `db`, `table`, `server`, `token`, `user`, `theme`, `session`, `templateState()` and `response`.

## Session (`$_SESSION`)

- `context.session` is a `PmaSession` (`src/lib/pma/session.ts`). Read and change `context.session.data` synchronously, using upstream key names (`tmpval`, `userconfig`, `userprefs_autoload`, `profiling`, `edit_next`, `pma_switch_to_new`, ...). `context.session.tmpval` creates `$_SESSION['tmpval']` on first use.
- The dispatcher loads it from sealed, chunked `pmaSession*` cookies. `ResponseRenderer::response()` stores it again only when it changed. It belongs to one login (new login = empty session, logout deletes it).
- Size is capped at 4 cookies. `fitSession()` drops the oldest `tmpval.query` entries first, then `tmpval.table_uiprefs`. Keep values small and never store query text.
- Do not create keys just by reading. `tableList(session, type, server)` only creates the list when called with `create = true`.
- Helpers:
  - `rememberQuerySettings(tmpval, md5, settings)` keeps up to 10 browse settings, like `setConfigParamsForDisplayTable()`.
  - `md5()` is in `src/lib/pma/md5.ts`.

## User preferences (no pmadb, so they live in the session)

- `src/lib/pma/user-preferences.ts` has `loadUserPreferences`, `saveUserPreferences`, `persistOption` and `setUserValue(session, config, path, value, default, now)`, which is `Config::setUserValue(null, ...)`.
- Stored preferences are merged into `context.config` when the context is created, as `Config::loadUserPreferences()` does, including the ThemeDefault bookkeeping.
- `src/lib/pma/config-forms.ts` (data in `config-forms.json`) holds every user and page form: field types, descriptions, select values, validators, POST parsing (`readPostedForms`), `validateValues` and `userPreferencesToSave`.
- `src/lib/pma/misc/user-config.ts` has `UserConfigFile` (ConfigFile after `UserPreferences::pageInit()`, keeping PHP's key order) plus `saveForms`, `castFieldValue` and `fixErrors` (FormDisplay::save()). The preference pages save through it; `controllers/misc/preferences-forms.ts` exports `pageInit`, `reloadUserPreferences` and `redirectSaved`.
- After a save, rebuild `context.config` in place with `reloadUserPreferences(context)`, since the renderer and dbi hold the same object.

## Page settings (`page-settings.ts`)

- `getPageSettings(context, group, elemId?)` ports `new PageSettings($group)` for Browse, DbStructure, Edit, Export, Import, Navi, Sql and TableStructure. It returns `{ html, errorHtml, saved }`.
- Callers add `errorHtml` to the response with `addHTML()`.
- When `saved` is true, a Location header back to the page is already set, so the controller must `return context.response.response()` at once, as upstream exits there.
- `renderFormDisplay` and `renderErrors` are exported for other FormDisplay users; `action`, `hiddenFields` and `showButtons` select the user preference form variant.

## Profiling (`profiling.ts`)

- The dispatcher runs `checkProfiling()` for every request.
- Use `isProfilingEnabled`, `enableProfiling` (before running the query) and `getProfilingInformation`.

## Recent and favorite tables (`recent-favorite-table.ts`)

- `getTables`, `addTable`, `removeTable`, `removeIfInvalid`, `getHtmlList` and `getHtmlUpdateRecentTables`. These are session-backed for each server.
- The header adds the current table to the recent list automatically.

## Table (`table.ts`)

- Get one with `Table.get(context, table, db)`.
- Methods: `isView`, `isUpdatableView`, `isMerge`, `isEngine`, `getStatus`, `getStatusInfo(key)` (`''` without status, `false` for an unknown key), `getStorageEngine`, `getComment`, `getCollation`, `getRowFormat`, `getAutoIncrement`, `getCreateOptions`, `getNumRows`, `countRecords(forceExact)` (`MaxExactCount = 0` semantics), `getUniqueColumns`, `getIndexedColumns`, `getColumns`, `getColumnsMeta`, `getNonGeneratedColumns`, `checkIfMinRecordsExist`, `showCreate`, `getRealRowCountTable`, `Table.isValidName`, and `getUiProp` / `setUiProp` / `removeUiProp` (session only).
- To check that a database exists, use `(await dbi.getDatabaseList()).includes(db)`.

## Index (`index.ts`, `src/lib/pma/index.ts`)

- Loaders: `getIndexesFromTable`, `getIndexesByChoice`, `getPrimaryIndex`, `getIndexSingleton` and `findDuplicates`.
- `Index` and `IndexColumn` objects can be passed straight to templates such as `indexes.twig`.

## Charsets, storage engines and transformations

- `charsets.ts`: `getCharsets`, `getCollations`, `findCollationByName` and `getServerCharset`. They return `Charset` and `Collation` objects (`src/lib/pma/charsets.ts`).
- `storage-engine.ts`: `getStorageEngines`, `getStorageEngineArray`, `isValidStorageEngine` and `hasMroongaEngine`.
- `src/lib/pma/transformations.ts`: `getAvailableMimeTypes`, `getName`, `getDescription`, `getOptions` and `fixUpMime`. `getMime()` is always `null` because there is no pmadb.

## Generator, Util and documentation links

- `generator.ts`:
  - `getMessage` (Generator::getMessage with the SQL query box)
  - `linkOrButton(context, ...)`, `getIcon(context, ...)` and `generatorState(context)`
  - re-exports of `getImage`, `showHint`, `showMySQLDocumentation`, `getMySQLDocuUrl` and `getDocumentationLink` (`src/lib/twig/html.ts`)
- `src/lib/pma/util.ts`: `formatByteDown`, `formatNumber`, `numberFormat`, `phpRound`, `localisedDate`, `timespanFormat`, `getFormattedMaximumUploadSize`, `getUrlForOption`, `getScriptNameForOption` and `getTitleForTarget`.
- `src/lib/pma/generator.ts`: `linkOrButton` and `sortableTableHeader`.
- These Twig functions are registered: `link_or_button`, `sortable_table_header`, `format_byte_down`, `format_number`, `localised_date`, `timespan_format`, `get_name` and `get_description`.
- `renderTemplate` runs templates with `twig/php-loop-scope.ts`, so a variable first set inside a `{% for %}` loop is gone after it, as in Twig (Twing alone keeps it; `table/chart/tbl_chart.twig` depends on this).

## Responses (`response.ts`)

- `ResponseRenderer` adds the session cookies to every response it builds.
- `ResponseExit` models PHP's `exit` inside `Header::getDisplay()`: the headers go out without a body.
- Unknown routes (404) and wrong methods (405) are rendered by the dispatcher through the renderer.
- On a disabled response, a controller's own `Content-Type` header replaces PHP's default one.
- `response.naviSettingsDisabled = true` is `define('PMA_DISABLE_NAVI_SETTINGS', true)`.
- `ControllerContext.files` is `$_FILES` (uploaded `File`s by field name); `request.post` keeps `name[]` lists.
- The Twig `json_encode` filter honours `JSON_PRETTY_PRINT` (128) and `JSON_UNESCAPED_SLASHES` (64) when the template passes them as `constant()` variables in its context.

## Diffing session flows

`pma-diff.mjs`, `pma-oracle.mjs` and `render-route.ts` accept repeated `--before "[POST] <route> [k=v ...]"` steps that run first in the same login. Leave out the leading slash, because Git Bash rewrites it. For example:

```sh
node scripts/pma-diff.mjs --ajax --before "POST db=customer_db table=players" recent-table recent_table=1
```

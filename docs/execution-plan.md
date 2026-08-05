# Custos — execution plan

Status snapshot as of the initial build. Legend: ✅ done · 🟡 partial · ⬜ not started.

## Phase 0 — Foundations ✅

- ✅ npm-workspace monorepo, TypeScript project references, strict config.
- ✅ MIT license, `.gitignore`, repo hygiene.
- ✅ CI workflow (build + test backend, build renderer).

## Phase 1 — Backend core ✅

- ✅ `@custos/core`: `DatabaseDriver`/`DriverConnection` contract, `DriverRegistry`,
  domain types, result normalization, typed errors.
- ✅ **Guardian safety guards**: statement classification, unguarded-`UPDATE`/`DELETE`
  /`TRUNCATE`/`DROP` detection, read-only batch check, comment/quote-aware splitter.
- ✅ Tests: 20 passing (`packages/core/test`).

## Phase 2 — Drivers ✅ (with follow-ups)

- ✅ `@custos/driver-mysql` (mysql2): connect/test, schema introspection, multi-result
  batches, cancel via `KILL QUERY`.
- ✅ `@custos/driver-azuresql` (mssql): SQL auth **and** Azure AD access-token auth,
  schema/FK introspection, multi-recordset, cancel via `request.cancel()`.
- 🟡 **Row streaming for `maxRows`** — both drivers currently fetch then truncate.
  Switch to streaming so large results stop fetching early. (`toResultSet` already
  flags `truncated`.)
- 🟡 **Server-side statement timeout** — mysql2 v3 dropped per-query `timeout`; enforce
  via the AbortSignal path. mssql: wire `requestTimeout`.

## Phase 3 — Engine & IPC ✅

- ✅ `ConnectionManager` (Electron-free): connection CRUD, open/close, read-only
  enforcement, destructive-confirmation flow, query cancellation.
- ✅ `JsonConnectionStore` (metadata) + `SafeStorageSecretStore` (keychain).
- ✅ Single-channel typed IPC with `IpcResult<T>` envelope; `contextBridge` preload.
- ✅ Tests: 7 passing (`main/test`).
- ⬜ Test `JsonConnectionStore` / `SafeStorageSecretStore` against a temp dir.

## Phase 4 — Renderer foundation ✅

- ✅ Angular 18 standalone workspace.
- ✅ **Design token layer** (`tokens.css`) — exact light/dark values from the handoff.
- ✅ `ThemeService` (Light/Dark/System, follows OS, persisted) — **verified live**.
- ✅ `CustosClient` — typed wrapper over `window.custos`, degrades gracefully in a
  plain browser.
- ✅ Guardian shield logo asset.
- ✅ **Main window** (design 1c/1d) implemented and building; renders faithfully in
  both themes.

## Phase 5 — Renderer screens (from the design handoff) 🟡

The design (`docs/design/screens/`) provides 10 screens. Remaining to componentize
and wire to live data:

- ⬜ **Connection form** (1e) — engine-adaptive form built from `connectionFields`,
  test-connection states, read-only toggle.
- ⬜ **Welcome / first launch** (1f) — empty state + "New connection" CTA.
- ⬜ **Safety dialog** (1g) — the confirm-before-unbounded-write moment; consumes
  `ConfirmationRequiredError.analyses`.
- ⬜ **Query history** (1h) — searchable, per connection.
- ⬜ **Component states** (1i) — connection/query/empty/error states.
- 🟡 **Main window → live data** — replace the representative content with real calls:
  tree from `listDatabases/Schemas/Tables/Columns`, run via `runQuery`, grid from
  `QueryResult`, breadcrumb/read-only badge from the active `ConnectionConfig`.

## Phase 6 — Editor & grid depth ⬜

- ⬜ **Monaco** SQL editor with schema-aware autocomplete; Monaco theme mapped to the
  `--syn-*` tokens.
- ⬜ **Virtualized results grid** (CDK virtual scroll) for 10k+ rows; sort, resize,
  copy-as CSV/TSV/JSON, export.
- ⬜ Cancel button wired to `cancelQuery`; run/run-selection keyboard shortcuts.

## Phase 7 — Packaging & polish ⬜

- ⬜ `electron-builder` config; signed-ready macOS/Windows/Linux artifacts.
- ⬜ Dev orchestration script (serve renderer + launch Electron in one command).
- ⬜ Bundle Inter / JetBrains Mono locally (drop the Google Fonts request) and set a
  strict `Content-Security-Policy`.
- ⬜ App icon set from the guardian shield.

## Immediate next step

Wire the **main window to live data** end-to-end against a local MySQL container:
connection tree → run query → results grid, using the already-built `CustosClient`
and engine. That turns the faithful shell into a working client and exercises the full
stack (driver → engine → IPC → UI) for the first time.

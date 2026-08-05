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
- ✅ `@custos/driver-azuresql` (mssql): SQL auth, **Windows/NTLM (domain)** auth, and
  Azure AD access-token auth; schema/FK introspection, multi-recordset, cancel via
  `request.cancel()`.
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

The design (`docs/design/screens/`) provides 10 screens.

- ✅ **Main window → live data** — the sidebar tree, editor, and results grid are now
  data-driven components backed by `WorkspaceStore`. A `DemoBackend` implements the
  exact `CustosApi` (reusing core's `analyzeBatch`/`firstMutatingKind` for guardrails)
  and is used when the Electron bridge is absent, so the whole loop is exercisable in a
  browser. **Verified live:** lazy multi-level tree, run → `QueryResult` → grid (200
  rows), read-only guard error, and destructive-confirmation dialog.
- ✅ **Safety dialog** (1g) — implemented (`safety-dialog.component.ts`); consumes the
  `CONFIRMATION_REQUIRED` analyses and re-runs on confirm.
- ✅ **Connection form** (1e) — modal built entirely from each driver's
  `connectionFields` (types, secrets, `select` options, `visibleWhen`), live
  test-connection status, read-only toggle. **Verified:** Azure↔MySQL field
  adaptation, test success, save → new node in tree.
- ✅ **Welcome / first launch** (1f) — empty state + "New connection" CTA
  (exercisable via `?empty`).
- ✅ **Edit / delete connections** — hover a connection in the tree for edit/delete
  actions. Edit reopens the form pre-filled from the saved config (title "Edit
  connection"); secrets merge on save (blank password keeps the current one), so
  imported connections can have their password added. Saving drops any live
  connection so it reconnects with the new credentials.
- ✅ **Import from DataGrip** — parse a JetBrains `dataSources.xml` (SQL Server
  native + jTDS, MySQL/MariaDB; others flagged) into Custos connections, minus
  the password (DataGrip doesn't store it). Import dialog with file-picker + paste,
  per-connection notes. A `DOMAIN` in the file maps straight to the Azure SQL
  driver's **Windows (NTLM)** auth mode. `parseDataGripSources` lives in
  `@custos/core` with 9 tests; **verified** on a real NHA `dataSources.xml`.
- ✅ **Context breadcrumb** — bound to the active connection, database, and
  read-only flag, plus a Live/Demo indicator (amber "Demo data" in the browser
  preview, green "Live connection" under Electron) so it's always clear whether
  a real database is attached. The bottom status bar binds the same.
- 🟡 **Component states** (1i) — grid empty/error/loading + connection-test
  states done; remaining: tree connecting/error chips, query cancel state.
- ✅ **Connect without a database + pick one from the tree** — database is now
  optional on Azure SQL; the tree lists every database on the server and browses
  each one's own schemas/tables (three-part names for SQL Server, db-scoped
  `information_schema` for MySQL). Selecting a database issues a server-side
  `USE` so queries target it. Verified in-browser (multi-db tree) and against
  real MySQL (13-check harness: connect with no db → list dbs → db-scoped tables
  → `USE` shopdb/warehouse and query each).
- ⬜ **Query history** (1h) — searchable, per connection.
- ✅ **Live against a real database** — the real `@custos/driver-mysql` + engine are
  verified end-to-end against a running MySQL by `main/integration/mysql-live.js`
  (`npm run test:integration:mysql -w @custos/app`, DB via `db/docker-compose.yml`).
  **9/9 checks pass** on MySQL 9.7: handshake, introspection with real column types,
  `SELECT`, `maxRows` truncation, a real `UPDATE ... WHERE` (row actually mutated),
  the confirmation guard pausing an unbounded `UPDATE`, and the read-only guard
  refusing writes. Remaining: launch the packaged Electron app against it (the
  IPC↔UI shim is thin and already proven via the in-browser demo of the same
  `CustosApi`).

## Phase 6 — Editor & grid depth ⬜

- ⬜ **Monaco** SQL editor with schema-aware autocomplete; Monaco theme mapped to the
  `--syn-*` tokens.
- ⬜ **Virtualized results grid** (CDK virtual scroll) for 10k+ rows; sort, resize,
  copy-as CSV/TSV/JSON, export.
- ⬜ Cancel button wired to `cancelQuery`; run/run-selection keyboard shortcuts.

## Phase 7 — Hosts, packaging & polish 🟡

The engine and UI are host-agnostic; a host is a thin shell around the shared
dispatcher (`main/src/dispatch.ts`).

- ✅ **Web host** (`npm run web`) — a zero-dep Node HTTP server (`main/src/server.js`)
  that serves the built UI and brokers real DB connections over `/api`. Runs Custos
  in a browser with **no native binary** — the answer for managed machines that block
  an unsigned Electron app. localhost-only; secrets in memory; metadata under
  `~/.custos`. **Verified**: browser → HTTP → real MySQL (listed real databases, ran
  `SELECT` on real rows, breadcrumb shows "Live connection").
- ✅ **Electron host** — the desktop shell (blocked on some managed machines by
  endpoint security; see below).
- ⬜ `electron-builder` config; signed macOS/Windows/Linux artifacts (needs a signing
  identity to clear Gatekeeper/EDR).
- 🟡 **Secret storage for the web host** — currently in-memory; add an encrypted
  at-rest option (OS keychain via the desktop host is already done via `safeStorage`).
- ⬜ Bundle Inter / JetBrains Mono locally (drop the Google Fonts request) and set a
  strict `Content-Security-Policy`.
- ⬜ App icon set from the guardian shield.

## Immediate next step

Two good directions: **query history (1h)** (last unbuilt design screen), or deepen
the editor (Monaco + schema autocomplete, Phase 6). The web host means the app is now
fully usable against real databases without the desktop shell.

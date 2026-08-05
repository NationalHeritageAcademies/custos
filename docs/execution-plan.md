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
- 🟡 **Component states** (1i) — grid empty/error/loading + connection-test
  states done; remaining: tree connecting/error chips, query cancel state.
- ⬜ **Query history** (1h) — searchable, per connection.
- ⬜ **Live against a real database** — the components already call `CustosApi`; run the
  Electron app against a local MySQL container to exercise driver → engine → IPC → UI
  for real (the demo backend proves the UI contract; this proves the wire).

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

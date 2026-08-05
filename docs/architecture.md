# Custos architecture

Custos is a layered Electron + Angular application whose defining decision is a
**pluggable driver contract** that keeps every database engine behind one interface.

## Process model & trust boundary

```
┌───────────────────────────── Electron main process ─────────────────────────────┐
│                                                                                  │
│  bootstrap.ts ── builds ──► DriverRegistry ── holds ──► DatabaseDriver plugins   │
│       │                          ▲                         (mysql, azuresql, …)  │
│       ▼                          │                                               │
│  ConnectionManager (engine) ─────┘   opens ► DriverConnection (live sockets)     │
│       │   • read-only enforcement                                                │
│       │   • destructive-statement confirmation                                   │
│       │   • query cancellation (AbortController)                                 │
│       ▼                                                                          │
│  stores:  JsonConnectionStore (metadata)   SafeStorageSecretStore (keychain)     │
│       ▲                                                                          │
│  ipc/register.ts  ── single channel 'custos:invoke', IpcResult<T> envelope       │
└───────┬──────────────────────────────────────────────────────────────────────────┘
        │  contextBridge (preload.ts) exposes window.custos : CustosApi
┌───────▼──────────────────────────── Renderer (Angular) ──────────────────────────┐
│  CustosClient  ──►  window.custos  (the ONLY way out; no Node, no drivers here)   │
│  ThemeService  ──►  data-theme on <html>  ──►  tokens.css (light/dark)            │
│  Components (main window, tree, editor, results grid, dialogs)                    │
└──────────────────────────────────────────────────────────────────────────────────┘
```

The renderer runs with `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true`. It can only reach the main process through the narrow, typed
`window.custos` surface. Drivers, credentials, and file access live exclusively in
the main process.

## Packages

- **`@custos/core`** (zero runtime deps) — the contract everything agrees on:
  - `DatabaseDriver` / `DriverConnection` interfaces.
  - `DriverRegistry`.
  - Domain types (`ConnectionConfig`, `ConnectionField`, `QueryResult`, …).
  - Result normalization (`toResultSet`, …).
  - **Safety guards** (`analyzeStatement`, `firstMutatingKind`, `isReadOnlyBatch`) —
    the lightweight, dependency-free heuristics behind the "guardian" behavior.
  - Typed errors (`ReadOnlyViolationError`, `ConfirmationRequiredError`, …).
- **`@custos/shared`** (types only) — the IPC contract: `CustosApi`, request/response
  types, the `IpcResult<T>` envelope, and the `window.custos` global augmentation.
- **`@custos/driver-*`** — one package per engine, each implementing `DatabaseDriver`.
- **`@custos/app`** (`main/`) — Electron main: the engine, IPC glue, stores, preload,
  and window lifecycle.
- **`custos`** (`renderer/`) — the Angular UI.

## Key decisions

- **Engine is Electron-free.** `ConnectionManager` takes its registry and stores via
  constructor injection, so it is fully unit-tested with in-memory stores and a fake
  driver (`main/test/connection-manager.test.js`). Electron-specific code (safeStorage,
  BrowserWindow, ipcMain) is isolated in thin shell files.
- **Positional rows, not keyed objects.** Result sets are row-major arrays aligned to
  a `columns` array, preserving column order and duplicate names and letting the
  virtualized grid index positionally.
- **One IPC channel, one envelope.** Every renderer→main call goes through
  `custos:invoke` and resolves to `IpcResult<T>`; the preload unwraps it and throws a
  reconstructed error (with `code` and, for confirmations, `analyses`) so the public
  API still reads as "returns value / throws" while surviving Electron's structured
  clone (which strips custom Error fields).
- **Secrets are separate from config, always.** `ConnectionConfig` (persisted as JSON)
  never contains secrets; `ConnectionSecrets` go to the keychain via `safeStorage`,
  which refuses to write plaintext if OS encryption is unavailable.

## Theming

A single token layer (`renderer/src/styles/tokens.css`) defines light and dark values
for every color, plus type/spacing/radius/elevation, taken verbatim from the design
handoff. `:root` is light; the OS preference applies dark unless the user forced light;
`data-theme` (set by `ThemeService`) always wins. Because every component reads only
CSS variables, one attribute flip re-themes the whole app — Monaco and the grid
included.

See [design/README.md](design/README.md) for how the design screens map to code.

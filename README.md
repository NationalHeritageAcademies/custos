<div align="center">

# Custos

**Keeper of your queries.**

A lightweight, open-source desktop database client for Azure SQL, MySQL, and more —
a calmer alternative to DataGrip that *guards* your data as much as it queries it.

</div>

---

Custos is an Electron + Angular desktop app built around a **pluggable driver
architecture**: every database engine is a self-contained plugin behind one
contract, so adding a new engine is one package plus one line of registration.

It ships light and dark themes as first-class citizens (driven by a single design
token layer), and its "guardian" features — keychain-stored credentials, per-connection
read-only mode, and confirmation prompts before unbounded writes — are built in, not
bolted on.

> **Status:** early. The backend (driver contract, MySQL + Azure SQL drivers,
> engine, IPC) is implemented and tested; the renderer implements the main window
> from the design system with live theming. See [docs/execution-plan.md](docs/execution-plan.md)
> for exactly what's done and what's next.

## Features

- **Pluggable drivers** — Azure SQL and MySQL today; any engine tomorrow. See
  [CONTRIBUTING.md](CONTRIBUTING.md#how-to-add-a-driver).
- **Light & dark themes from day one** — one design-token layer, switched via a
  Light / Dark / System toggle that follows the OS.
- **Guardian safety** — OS-keychain credential storage (never plaintext),
  per-connection **read-only** mode, and confirm-before-run for `UPDATE`/`DELETE`
  without a `WHERE`, `TRUNCATE`, and `DROP`.
- **Schema-aware workspace** — connection tree, tabbed SQL editor, virtualized
  results grid, multiple result sets, query history.
- **Import from DataGrip** — bring in existing connections from a JetBrains
  `dataSources.xml` (metadata only; passwords are never in that file and go to
  your keychain on first connect).
- **No telemetry** — Custos makes no network calls except to the databases you
  configure. See [Privacy](#privacy).

## Architecture at a glance

```
packages/core            @custos/core          Driver contract, registry, result
                                                normalization, SQL safety guards (0 deps)
packages/shared          @custos/shared        Typed IPC contract (main <-> renderer)
packages/driver-mysql    @custos/driver-mysql  MySQL driver (mysql2)
packages/driver-azuresql @custos/driver-azuresql  Azure SQL driver (mssql)
main/                    @custos/app           Electron main: engine, IPC, stores, shell
renderer/                custos                Angular app (design-system UI, theming)
```

The engine (`ConnectionManager`) is deliberately Electron-free and unit-tested with
in-memory stores; drivers and credentials never touch the renderer. Full detail in
[docs/architecture.md](docs/architecture.md).

## Quickstart

Requires **Node 20+**. The backend uses npm workspaces; the renderer is a
standalone Angular workspace, so it installs separately.

```bash
# One-time install
npm install                 # backend workspace (packages/* + main)
npm --prefix renderer install   # Angular renderer

# Option A — run in the browser (no desktop app):
npm run web            # builds, then serves http://127.0.0.1:4174

# Option B — run as an Electron desktop app:
npm run app            # builds, then opens the desktop window
```

**Web mode** (`npm run web`) starts a small local Node server that serves the UI
and brokers the real database connections, then you open `http://127.0.0.1:4174`
in your browser. No native app, no code signing — useful on managed machines
where an unsigned desktop binary is blocked. The server binds to localhost only;
connection metadata persists under `~/.custos`, and secrets are kept in memory
(re-enter after a restart).

**Desktop mode** (`npm run app`) loads the same UI in an Electron window.

Either way, on first launch there are no connections, so you get the welcome
screen: add one, or **Import from DataGrip**.

### Live-reload development

For UI work with hot reload, run the Angular dev server and point Electron at it:

```bash
# Terminal 1 — Angular dev server on http://localhost:4200
npm --prefix renderer start

# Terminal 2 — Electron against the dev server
npm run build        # compile the main process
npm run app:dev      # launches Electron with CUSTOS_DEV_SERVER_URL set
```

### Tests

```bash
npm test                                   # unit suites (no DB needed)
npm run test:integration:mysql -w @custos/app   # live MySQL harness (see CONTRIBUTING)
```

## Privacy

Custos stores connection metadata locally in your user-data directory and secrets in
the OS keychain (via Electron `safeStorage`). It sends **no analytics or telemetry**
and makes no outbound network requests other than the database connections you set up.
The only current exception is web-font loading in the renderer, which is tracked for
removal (bundling fonts locally) in the execution plan.

## Compliance note

Custos can connect to databases that may contain regulated data (e.g. student or
staff PII). The read-only mode, keychain storage, and no-telemetry guarantees are
designed to help it pass a security review, but whether it is approved for use against
a given production system is a policy decision for that system's data owner — not
something the tool can grant on its own.

## License

[MIT](LICENSE)

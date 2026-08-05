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

## Quickstart (development)

Requires **Node 20+**. The backend uses npm workspaces; the renderer is a
standalone Angular workspace.

```bash
# 1. Backend: install, build, and test the workspace
npm install
npm run build
npm test

# 2. Renderer: install and run the Angular dev server
cd renderer
npm install
npm start          # ng serve on http://localhost:4200

# 3. In another terminal, from the repo root, launch Electron against the dev server
npm run build      # ensure main/ is compiled
cd main && npm start
```

To build the renderer for a packaged app: `cd renderer && npm run build` (outputs to
`renderer/dist/custos/browser`, which the Electron main process loads in production).

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

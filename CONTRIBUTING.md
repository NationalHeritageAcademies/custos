# Contributing to Custos

Thanks for helping build Custos. This guide covers local setup, the repo layout,
and — most importantly — how to add support for a new database engine, which is the
single most valuable kind of contribution.

## Local setup

Requires **Node 20+**.

```bash
npm install          # installs the workspace (packages/* + main)
npm run build        # tsc -b across the graph
npm test             # runs core + engine test suites (node:test, no extra deps)
```

The renderer is a separate Angular workspace:

```bash
cd renderer
npm install
npm start            # ng serve
npm run build        # production build
```

## Repo layout

| Path | Package | Responsibility |
| --- | --- | --- |
| `packages/core` | `@custos/core` | Driver **contract**, `DriverRegistry`, result normalization, SQL safety guards. Zero runtime deps. |
| `packages/shared` | `@custos/shared` | Typed IPC contract shared by main and renderer. Types only. |
| `packages/driver-mysql` | `@custos/driver-mysql` | MySQL driver. |
| `packages/driver-azuresql` | `@custos/driver-azuresql` | Azure SQL driver. |
| `main` | `@custos/app` | Electron main process: engine (`ConnectionManager`), IPC, credential/connection stores, window shell. |
| `renderer` | `custos` | Angular UI. Reads design tokens; talks to main only through `window.custos`. |

## How to add a driver

A driver is one package implementing `DatabaseDriver` from `@custos/core`. **Nothing
else in the app needs to change** except one registration line.

### 1. Create the package

Copy `packages/driver-mysql` as a starting point:

```
packages/driver-<engine>/
  package.json        # name: @custos/driver-<engine>, deps: @custos/core + the DB client lib
  tsconfig.json       # extends ../../tsconfig.base.json, references ../core
  src/index.ts        # your driver
```

### 2. Implement the contract

```ts
import { type DatabaseDriver, type DriverConnection /* ... */ } from '@custos/core';

export class MyEngineDriver implements DatabaseDriver {
  readonly metadata = { id: 'myengine', displayName: 'My Engine', iconId: 'myengine' };
  readonly capabilities = {
    supportsSchemas: true,
    supportsTransactions: true,
    supportsMultipleResultSets: false,
    supportsCancel: true,
    paramStyle: 'positional',   // or 'named' / 'none'
    defaultPort: 5432,
  };
  // Drives the dynamically-rendered "New connection" form. Mark secrets so they
  // go to the OS keychain and are never written to disk.
  readonly connectionFields = [
    { key: 'host', label: 'Host', type: 'string', required: true },
    { key: 'port', label: 'Port', type: 'number', default: 5432 },
    { key: 'password', label: 'Password', type: 'password', secret: true },
  ];

  async connect(config, secrets): Promise<DriverConnection> { /* open a connection */ }
  async testConnection(config, secrets) { /* return { ok, message, serverVersion? } */ }
}
```

Your `DriverConnection` implements `listDatabases`, `listSchemas`, `listTables`,
`getColumns`, `getForeignKeys`, `query`, and `close`. Use the `toResultSet` /
`toResultSetFromArrays` / `emptyResultSet` helpers from `@custos/core` so your
results match the shape the grid expects. Honor `QueryOptions` (`signal` for cancel,
`maxRows` for the row cap, `timeoutMs`).

### 3. Register it

Add one line to `main/src/bootstrap.ts`:

```ts
import { MyEngineDriver } from '@custos/driver-myengine';
// ...
registry.register(new MyEngineDriver());
```

Add the package to `main`'s dependencies and to the root `tsconfig.json` references.
That's it — the connection form, tree, editor, and results grid all adapt to your
driver's declared `capabilities` and `connectionFields` automatically.

### 4. Test it

Follow `packages/core/test` and `main/test` for the style: `node:test` + `node:assert`,
importing compiled `dist`. Prefer testing your result-normalization and metadata
queries against a throwaway container.

## Live integration test (real MySQL)

The unit suites mock the DB; there is also a live harness that drives the real driver
through the engine against an actual MySQL server:

```bash
docker compose -f db/docker-compose.yml up -d      # MySQL on 127.0.0.1:3307, seeded
npm run build
npm run test:integration:mysql -w @custos/app       # 9 checks against real MySQL
docker compose -f db/docker-compose.yml down        # tear down
```

The harness (`main/integration/mysql-live.js`) reads `CUSTOS_MYSQL_*` env vars and
defaults to the compose settings. It is intentionally not part of `npm test` so CI and
day-to-day runs don't require a database.

## Conventions

- TypeScript strict mode; no `any` in public surfaces.
- Match the surrounding comment density and naming.
- Drivers and credentials live in the **main process only** — never import them into
  the renderer. The renderer's only bridge is `window.custos` (`@custos/shared`).
- Never log passwords, tokens, or full connection strings.

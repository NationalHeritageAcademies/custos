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
| `packages/driver-mongodb` | `@custos/driver-mongodb` | MongoDB driver: a mongosh-subset parser plus its own safety analyzer. |
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

### 2b. (Optional) interactive sign-in

If some of your auth modes get their credentials from an identity provider (SSO, OAuth,
Entra ID with MFA) rather than a stored secret, also implement `InteractiveAuthDriver`:

```ts
import { type InteractiveAuthDriver, type SignInPrompt } from '@custos/core';

export class MyEngineDriver implements DatabaseDriver, InteractiveAuthDriver {
  // Does this params bag sign in interactively, and who is signed in already?
  signInRequirement(params) { return { required: true, account: null }; }

  // Run the sign-in. Call onPrompt as soon as you know what to show the user
  // (a device code, or "your browser is opening") — well before you resolve.
  async signIn(params, onPrompt: (p: SignInPrompt) => void, signal?: AbortSignal) {
    onPrompt({ kind: 'device-code', message: '…', userCode: 'ABC-123', verificationUri: 'https://…' });
    return 'user@example.com'; // resolves once the provider confirms
  }
}
```

The engine and UI take it from there: `ConnectionManager` owns the flow
(`beginSignIn`/`pollSignIn`/`cancelSignIn`), the sign-in dialog renders whatever your
prompt says, and a `connect` that throws `SignInRequiredError` (code
`SIGN_IN_REQUIRED`) makes the UI sign the user in and retry the interrupted call. See
`packages/driver-azuresql/src/entra.ts` for a worked example.

### 2c. (Optional) an engine that doesn't speak SQL

Custos analyzes every batch before it runs — that is how the read-only flag and the
confirm-before-destructive prompt work — and the default analyzer reads SQL keywords.
An engine with another language must supply its own, or its writes will classify as
`unknown` and slip past the read-only check:

```ts
import { type StatementAnalyzer } from '@custos/core';

export const myAnalyzer: StatementAnalyzer = {
  analyzeBatch: (source) => /* one StatementAnalysis per statement */,
};

export class MyEngineDriver implements DatabaseDriver {
  readonly capabilities = { /* … */ queryLanguage: 'mongodb' };  // editor language
  readonly analyzer = myAnalyzer;                                 // safety rules
}
```

Two rules for an analyzer: never throw (it runs on half-typed text — report
`unknown` instead), and classify conservatively, since a false positive only costs
the user a confirmation while a false negative loses data. `packages/driver-mongodb`
is the worked example — `src/parse.ts` turns shell text into statements and
`src/analyze.ts` classifies them.

`queryLanguage` is separate: it only picks the editor's highlighting and
autocomplete (`renderer/src/app/components/code-editor.component.ts`), and defaults
to `'sql'`.

### 3. Register it

Add one line to `main/src/bootstrap.ts`:

```ts
import { MyEngineDriver } from '@custos/driver-myengine';
// ...
registry.register(new MyEngineDriver());
```

Add the package to `main`'s dependencies (and `package.json` / `main/tsconfig.json`
references, plus a badge entry in `renderer/src/app/driver-presentation.ts`).
That's it — the connection form, tree, editor, and results grid all adapt to your
driver's declared `capabilities` and `connectionFields` automatically. (The form's
engine picker is a row of buttons up to `ENGINE_BUTTON_LIMIT` engines and a dropdown
beyond it, so a fourth driver does not squeeze the row.)

### 4. Test it

Follow `packages/core/test` and `main/test` for the style: `node:test` + `node:assert`,
importing compiled `dist`. Prefer testing your result-normalization and metadata
queries against a throwaway container.

## Live integration tests (real databases)

The unit suites mock the DB; there is also a live harness that drives the real driver
through the engine against an actual MySQL server:

```bash
docker compose -f db/docker-compose.yml up -d      # MySQL on 127.0.0.1:3307, seeded
npm run build
npm run test:integration:mysql -w @custos/app       # 9 checks against real MySQL
docker compose -f db/docker-compose.yml down        # tear down
```

The harness (`main/integration/mysql-live.js`) reads `CUSTOS_MYSQL_*` env vars and
defaults to the compose settings. It assumes a **fresh** container (one check asserts
an absolute value after a write), so recreate it before a re-run.

There is an equivalent for MongoDB, which seeds and drops its own database and so is
safe to re-run against the same container:

```bash
docker compose -f db/docker-compose.yml up -d mongo  # MongoDB on 127.0.0.1:27018
npm run test:integration:mongo -w @custos/app        # 15 checks against real MongoDB
docker compose -f db/docker-compose.yml down
```

`main/integration/mongo-live.js` reads `CUSTOS_MONGO_*` env vars. Neither harness is
part of `npm test`, so CI and day-to-day runs don't require a database.

## Conventions

- TypeScript strict mode; no `any` in public surfaces.
- Match the surrounding comment density and naming.
- Drivers and credentials live in the **main process only** — never import them into
  the renderer. The renderer's only bridge is `window.custos` (`@custos/shared`).
- Never log passwords, tokens, or full connection strings.

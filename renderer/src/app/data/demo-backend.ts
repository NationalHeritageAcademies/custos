import {
  analyzeBatch,
  type ResultSet,
  type SqlValue,
} from '@custos/core';
import type {
  ColumnMeta,
  ConnectionConfig,
  CustosApi,
  DriverInfo,
  ForeignKey,
  QueryResult,
  RunQueryInput,
  SaveConnectionInput,
  SignInInput,
  SignInRequirement,
  SignInState,
  StatementAnalysis,
  TableRef,
  TestConnectionResult,
} from '@custos/shared';

/** Build an Error carrying the same `code`/`analyses` the real preload bridge attaches. */
function bridgeError(code: string, message: string, analyses?: StatementAnalysis[]): Error {
  const err = new Error(message) as Error & { code?: string; analyses?: StatementAnalysis[] };
  err.code = code;
  if (analyses) err.analyses = analyses;
  return err;
}

const DEMO_CONNECTIONS: ConnectionConfig[] = [
  { id: 'sales-prod', name: 'sales-prod', driverId: 'azuresql', readOnly: true, params: { server: 'sales.database.windows.net', database: 'analytics' } },
  { id: 'shop-mysql', name: 'shop-mysql', driverId: 'mysql', readOnly: false, params: { host: 'shop.internal', database: 'shopdb' } },
  { id: 'events-mongo', name: 'events-mongo', driverId: 'mongodb', readOnly: false, params: { mode: 'fields', host: 'events.internal', port: 27017, database: 'appdb' } },
];

// Each connection exposes several databases, each with its own tables — so the
// "connect to the server, then pick a database from the tree" flow is exercised.
const DATABASES: Record<string, string[]> = {
  'sales-prod': ['analytics', 'reporting', 'staging'],
  'shop-mysql': ['shopdb', 'legacy_orders'],
  'events-mongo': ['appdb', 'telemetry'],
};

const az = (database: string, name: string, kind: 'table' | 'view' = 'table'): TableRef => ({ database, schema: 'dbo', name, kind });
const my = (database: string, name: string): TableRef => ({ database, schema: null, name, kind: 'table' });
// Mongo collections sit directly under a database, like MySQL tables.
const mg = my;

const TABLES_BY_DB: Record<string, Record<string, TableRef[]>> = {
  'sales-prod': {
    analytics: [az('analytics', 'customers'), az('analytics', 'orders'), az('analytics', 'order_items'), az('analytics', 'refunds'), az('analytics', 'reporting', 'view')],
    reporting: [az('reporting', 'cohorts', 'view'), az('reporting', 'kpis'), az('reporting', 'daily_rollup', 'view')],
    staging: [az('staging', 'raw_events'), az('staging', 'import_log')],
  },
  'shop-mysql': {
    shopdb: [my('shopdb', 'products'), my('shopdb', 'carts'), my('shopdb', 'inventory')],
    legacy_orders: [my('legacy_orders', 'orders_2019'), my('legacy_orders', 'orders_2020')],
  },
  'events-mongo': {
    appdb: [mg('appdb', 'users'), mg('appdb', 'sessions'), mg('appdb', 'feature_flags')],
    telemetry: [mg('telemetry', 'page_views'), mg('telemetry', 'errors')],
  },
};

/** Documents for the MongoDB demo connection — deliberately ragged, as a
 * schemaless collection is: `plan` and `traits` are not on every document. */
const DEMO_DOCUMENTS: Record<string, unknown>[] = [
  { _id: '66f1a0c2e13b4a0b8c1d2e01', email: 'ada@example.com', plan: 'team', signedUpAt: new Date('2026-01-14T09:12:00Z'), traits: { region: 'eu-west', beta: true } },
  { _id: '66f1a0c2e13b4a0b8c1d2e02', email: 'grace@example.com', plan: 'business', signedUpAt: new Date('2026-02-03T16:40:00Z'), traits: { region: 'us-east', beta: false } },
  { _id: '66f1a0c2e13b4a0b8c1d2e03', email: 'linus@example.com', signedUpAt: new Date('2026-02-19T11:05:00Z') },
  { _id: '66f1a0c2e13b4a0b8c1d2e04', email: 'barbara@example.com', plan: 'solo', signedUpAt: new Date('2026-03-07T08:22:00Z'), traits: { region: 'ap-south', beta: true } },
];

/** Build a result set from documents the way the real driver does: columns are
 * the union of top-level fields, and a missing field reads as null. */
function documentResultSet(count: number): ResultSet {
  const documents = DEMO_DOCUMENTS.slice(0, Math.max(1, count));
  const names: string[] = [];
  for (const doc of documents) for (const key of Object.keys(doc)) if (!names.includes(key)) names.push(key);
  const columns: ColumnMeta[] = names.map((name) => ({ name, dataType: MONGO_TYPES[name] ?? 'object', nullable: true }));
  const rows = documents.map((doc) => names.map((name) => (doc[name] ?? null) as SqlValue));
  return { columns, rows, truncated: false };
}
const MONGO_TYPES: Record<string, string> = { _id: 'objectId', email: 'string', plan: 'string', signedUpAt: 'date', traits: 'object' };

/** Whether text is a MongoDB shell statement rather than SQL. */
function isMongoSource(source: string): boolean {
  return /^\s*(db\.|use\s|show\s)/.test(source);
}

/**
 * The demo's stand-in for the MongoDB analyzer. The real one parses the
 * statement (see @custos/driver-mongodb); this only has to be right about the
 * cases the demo shows, so it matches on the method name.
 */
function analyzeMongoDemo(source: string): StatementAnalysis[] {
  return source
    .split(/;|\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((statement) => {
      const method = /\.([A-Za-z]+)\s*\(/.exec(statement)?.[1] ?? statement.split(/\s+/)[0] ?? '';
      const write = /^(insert|update|replace|delete|remove|save|findOneAnd|bulkWrite)/.test(method);
      const ddl = /^(create|drop|rename)/i.test(method);
      const unfilteredDelete = /\.(deleteMany|updateMany)\(\s*\{\s*\}/.test(statement);
      const drops = /^drop/i.test(method);
      return {
        sql: statement,
        kind: ddl ? ('ddl' as const) : write ? ('write' as const) : ('read' as const),
        keyword: method,
        requiresConfirmation: unfilteredDelete || drops,
        reason: unfilteredDelete
          ? `${method}() has an empty filter and will affect every document in the collection.`
          : drops
            ? `${method}() permanently removes data.`
            : undefined,
      };
    });
}

const CHURN_COLUMNS: ColumnMeta[] = [
  { name: 'id', dataType: 'int' },
  { name: 'email', dataType: 'varchar' },
  { name: 'plan', dataType: 'varchar' },
  { name: 'mrr', dataType: 'decimal' },
  { name: 'region', dataType: 'varchar' },
  { name: 'cohort_month', dataType: 'date' },
  { name: 'churned_at', dataType: 'date' },
];

const PLANS = ['solo', 'team', 'business'];
const MRR = { solo: 39, team: 480, business: 1890 } as const;
const REGIONS = ['eu-west', 'us-east', 'ap-south', 'eu-north', 'us-west'];

/** Deterministically generate a churn-cohort dataset so the grid has real content. */
function churnRows(count: number): SqlValue[][] {
  const rows: SqlValue[][] = [];
  for (let i = 0; i < count; i++) {
    const plan = PLANS[i % PLANS.length]!;
    const region = REGIONS[i % REGIONS.length]!;
    const month = 7 - (i % 5);
    const cohort = `2026-0${month}-01`;
    const churned = i % 4 === 0 ? null : `2026-0${month}-${String(10 + (i % 18)).padStart(2, '0')}`;
    rows.push([
      10241 - i,
      `user${10241 - i}@example.com`,
      plan,
      MRR[plan as keyof typeof MRR].toFixed(2),
      region,
      cohort,
      churned,
    ]);
  }
  return rows;
}

/**
 * In-browser stand-in for the Electron main process. Implements the exact
 * {@link CustosApi} surface with representative data, and reuses the real
 * {@link analyzeBatch} guard from @custos/core (with a MongoDB stand-in for the
 * one connection that does not speak SQL) so read-only and
 * destructive-confirmation behavior matches the engine. Used automatically when
 * `window.custos` is absent (i.e. running outside Electron).
 */
export class DemoBackend implements CustosApi {
  private readonly connections: ConnectionConfig[];

  constructor() {
    // ?empty exercises the first-launch / welcome screen.
    const empty = typeof location !== 'undefined' && new URLSearchParams(location.search).has('empty');
    this.connections = empty ? [] : [...DEMO_CONNECTIONS];
  }

  async listDrivers(): Promise<DriverInfo[]> {
    // Field specs mirror the real drivers (they are pure data — no DB deps).
    return [
      {
        metadata: { id: 'azuresql', displayName: 'Azure SQL', iconId: 'azuresql' },
        capabilities: { supportsSchemas: true, supportsTransactions: true, supportsMultipleResultSets: true, supportsCancel: true, paramStyle: 'named', defaultPort: 1433 },
        connectionFields: [
          { key: 'server', label: 'Server', type: 'string', required: true, placeholder: 'myserver.database.windows.net' },
          { key: 'port', label: 'Port', type: 'number', required: true, default: 1433 },
          { key: 'database', label: 'Database', type: 'string', placeholder: 'optional — browse and pick from the tree' },
          { key: 'authMode', label: 'Authentication', type: 'select', required: true, default: 'sql', options: [ { value: 'sql', label: 'SQL login' }, { value: 'ntlm', label: 'Windows (NTLM)' }, { value: 'entra-mfa', label: 'Microsoft Entra ID \u2014 sign in with MFA' }, { value: 'entra-browser', label: 'Microsoft Entra ID \u2014 sign in via browser' }, { value: 'entra-azure-cli', label: 'Microsoft Entra ID \u2014 use the Azure CLI login' }, { value: 'azuread-token', label: 'Azure AD access token (paste)' } ] },
          { key: 'tenantId', label: 'Tenant', type: 'string', placeholder: 'optional \u2014 contoso.onmicrosoft.com or a tenant GUID', visibleWhen: { field: 'authMode', in: ['entra-mfa', 'entra-browser', 'entra-azure-cli'] }, help: 'Leave blank to sign in to your account\u2019s own tenant.' },
          { key: 'clientId', label: 'App registration (client ID)', type: 'string', placeholder: 'optional \u2014 GUID of your Entra app registration', visibleWhen: { field: 'authMode', in: ['entra-mfa', 'entra-browser'] }, help: 'Leave blank to sign in through the Microsoft developer sign-on app.' },
          { key: 'domain', label: 'Domain', type: 'string', placeholder: 'e.g. CORP', visibleWhen: { field: 'authMode', equals: 'ntlm' }, help: 'Windows domain for NTLM (integrated) authentication.' },
          { key: 'user', label: 'User', type: 'string', visibleWhen: { field: 'authMode', in: ['sql', 'ntlm'] } },
          { key: 'password', label: 'Password', type: 'password', secret: true, visibleWhen: { field: 'authMode', in: ['sql', 'ntlm'] } },
          { key: 'accessToken', label: 'Access token', type: 'password', secret: true, visibleWhen: { field: 'authMode', equals: 'azuread-token' }, help: 'An Entra ID access token for https://database.windows.net/.' },
          { key: 'encrypt', label: 'Encrypt', type: 'boolean', default: true },
          { key: 'trustServerCertificate', label: 'Trust server certificate', type: 'boolean', default: false },
        ],
      },
      {
        metadata: { id: 'mysql', displayName: 'MySQL', iconId: 'mysql' },
        capabilities: { supportsSchemas: false, supportsTransactions: true, supportsMultipleResultSets: true, supportsCancel: true, paramStyle: 'positional', defaultPort: 3306 },
        connectionFields: [
          { key: 'host', label: 'Host', type: 'string', required: true, default: 'localhost' },
          { key: 'port', label: 'Port', type: 'number', required: true, default: 3306 },
          { key: 'user', label: 'User', type: 'string', required: true },
          { key: 'password', label: 'Password', type: 'password', secret: true },
          { key: 'database', label: 'Database', type: 'string', placeholder: 'optional' },
          { key: 'ssl', label: 'Use TLS', type: 'boolean', default: false, help: 'Require an encrypted connection to the server.' },
        ],
      },
      {
        metadata: { id: 'mongodb', displayName: 'MongoDB', iconId: 'mongodb' },
        capabilities: { supportsSchemas: false, supportsTransactions: true, supportsMultipleResultSets: true, supportsCancel: true, paramStyle: 'none', defaultPort: 27017, queryLanguage: 'mongodb' },
        connectionFields: [
          { key: 'mode', label: 'Connect using', type: 'select', required: true, default: 'fields', options: [ { value: 'fields', label: 'Host and port' }, { value: 'uri', label: 'Connection string' } ] },
          { key: 'uri', label: 'Connection string', type: 'password', secret: true, required: true, placeholder: 'mongodb+srv://user:password@cluster.example.net/mydb', help: 'Kept in the OS keychain, because a connection string usually carries the password.', visibleWhen: { field: 'mode', equals: 'uri' } },
          { key: 'srv', label: 'DNS seed list (mongodb+srv)', type: 'boolean', default: false, help: 'For Atlas and other clusters advertised through SRV records. The port is taken from DNS.', visibleWhen: { field: 'mode', equals: 'fields' } },
          { key: 'host', label: 'Host', type: 'string', required: true, default: 'localhost', visibleWhen: { field: 'mode', equals: 'fields' } },
          { key: 'port', label: 'Port', type: 'number', default: 27017, visibleWhen: { field: 'mode', equals: 'fields' } },
          { key: 'database', label: 'Database', type: 'string', placeholder: 'optional \u2014 pick one from the tree later' },
          { key: 'user', label: 'User', type: 'string', visibleWhen: { field: 'mode', equals: 'fields' } },
          { key: 'password', label: 'Password', type: 'password', secret: true, visibleWhen: { field: 'mode', equals: 'fields' } },
          { key: 'authSource', label: 'Auth database', type: 'string', placeholder: 'admin', help: 'The database the user is defined in. Defaults to admin.', visibleWhen: { field: 'mode', equals: 'fields' } },
          { key: 'replicaSet', label: 'Replica set', type: 'string', placeholder: 'optional', visibleWhen: { field: 'mode', equals: 'fields' } },
          { key: 'tls', label: 'Use TLS', type: 'boolean', default: false, help: 'Require an encrypted connection. Always on for mongodb+srv.', visibleWhen: { field: 'mode', equals: 'fields' } },
        ],
      },
    ];
  }

  async listConnections(): Promise<ConnectionConfig[]> {
    return [...this.connections];
  }

  async saveConnection(input: SaveConnectionInput): Promise<ConnectionConfig> {
    const idx = this.connections.findIndex((c) => c.id === input.config.id);
    if (idx >= 0) this.connections[idx] = input.config;
    else this.connections.push(input.config);
    return input.config;
  }

  async deleteConnection(id: string): Promise<void> {
    const idx = this.connections.findIndex((c) => c.id === id);
    if (idx >= 0) this.connections.splice(idx, 1);
  }

  async testConnection(): Promise<TestConnectionResult> {
    return { ok: true, message: 'Connected successfully.', serverVersion: 'Demo 1.0', latencyMs: 12 };
  }

  async openConnection(): Promise<void> {}
  async closeConnection(): Promise<void> {}
  async setActiveDatabase(): Promise<void> {}

  // --- Interactive sign-in, simulated ---
  // The demo has no identity provider, so a flow runs on a timer: the code
  // appears immediately and "completes" a few seconds later. Enough to exercise
  // the dialog while designing, obviously fake in use.
  private signInStartedAt = 0;
  private signedInAs: string | null = null;

  async signInStatus(input: SignInInput): Promise<SignInRequirement> {
    const mode = String(input.params['authMode'] ?? '');
    const interactive = mode === 'entra-mfa' || mode === 'entra-browser';
    return { required: interactive, account: interactive ? this.signedInAs : null };
  }

  async beginSignIn(input: SignInInput): Promise<SignInState> {
    if (input.switchAccount) this.signedInAs = null;
    this.signInStartedAt = Date.now();
    return {
      flowId: 'demo-flow',
      status: 'pending',
      prompt: {
        kind: 'device-code',
        message: 'Demo sign-in — no real account is involved.',
        userCode: 'DEMO-CODE',
        verificationUri: 'https://microsoft.com/devicelogin',
      },
    };
  }

  async pollSignIn(flowId: string): Promise<SignInState> {
    if (Date.now() - this.signInStartedAt < 6_000) {
      return { flowId, status: 'pending' };
    }
    this.signedInAs = 'demo.user@example.com';
    return { flowId, status: 'complete', account: this.signedInAs };
  }

  async cancelSignIn(): Promise<void> {}

  async openSignInPage(): Promise<boolean> {
    return false;
  }

  async listDatabases(connectionId: string): Promise<string[]> {
    return DATABASES[connectionId] ?? [];
  }

  async listSchemas(connectionId: string): Promise<string[]> {
    // Azure connections have a schema level (dbo); MySQL does not.
    return connectionId === 'sales-prod' ? ['dbo'] : [];
  }

  async listTables(connectionId: string, database?: string, schema?: string): Promise<TableRef[]> {
    const byDb = TABLES_BY_DB[connectionId] ?? {};
    const all = database ? (byDb[database] ?? []) : Object.values(byDb).flat();
    return schema ? all.filter((t) => (t.schema ?? '') === schema) : all;
  }

  async listColumns(connectionId: string): Promise<ColumnMeta[]> {
    // A collection has no declared columns; the real driver infers them by
    // sampling documents, so the demo shows the same inferred shape.
    return connectionId === 'events-mongo' ? documentResultSet(DEMO_DOCUMENTS.length).columns : CHURN_COLUMNS;
  }

  async listForeignKeys(): Promise<ForeignKey[]> {
    return [];
  }

  async runQuery(input: RunQueryInput): Promise<QueryResult> {
    const conn = this.connections.find((c) => c.id === input.connectionId);
    const start = Date.now();

    // Same guardrails the engine enforces, read in the same language the
    // connection speaks — MongoDB statements are not SQL.
    const mongo = conn?.driverId === 'mongodb' || isMongoSource(input.sql);
    const analyses = mongo ? analyzeMongoDemo(input.sql) : analyzeBatch(input.sql);
    if (conn?.readOnly) {
      const mutating = analyses.find((a) => a.kind === 'write' || a.kind === 'ddl');
      if (mutating) {
        throw bridgeError('READ_ONLY_VIOLATION', `This connection is read-only; refusing to run a "${mutating.keyword}" statement.`);
      }
    }
    if (!input.confirmDestructive) {
      const needsConfirm = analyses.filter((a) => a.requiresConfirmation);
      if (needsConfirm.length > 0) {
        throw bridgeError('CONFIRMATION_REQUIRED', 'This statement requires confirmation before it can run.', needsConfirm);
      }
    }

    if (mongo) {
      if (analyses[0]?.kind !== 'read') {
        return { resultSets: [{ columns: [{ name: 'acknowledged', dataType: 'bool' }, { name: 'modifiedCount', dataType: 'int' }], rows: [[true, 3]], truncated: false }], rowsAffected: 3, executionMs: Date.now() - start + 6 };
      }
      return { resultSets: [documentResultSet(input.maxRows ?? 200)], rowsAffected: null, executionMs: Date.now() - start + 18 };
    }

    const keyword = analyses[0]?.keyword ?? '';
    const isRead = ['select', 'with', 'show', 'describe', 'explain'].includes(keyword);

    if (isRead) {
      const total = 1284;
      const fetched = Math.min(input.maxRows ?? 200, total);
      const rs: ResultSet = { columns: CHURN_COLUMNS, rows: churnRows(fetched), truncated: fetched < total };
      return { resultSets: [rs], rowsAffected: null, executionMs: Date.now() - start + 41 };
    }

    // A write/DDL statement (already confirmed if it needed it).
    return { resultSets: [{ columns: [], rows: [], truncated: false }], rowsAffected: 3, executionMs: Date.now() - start + 7 };
  }

  async cancelQuery(): Promise<void> {}

  async analyzeSql(sql: string, connectionId?: string): Promise<StatementAnalysis[]> {
    const conn = connectionId ? this.connections.find((c) => c.id === connectionId) : undefined;
    return conn?.driverId === 'mongodb' || isMongoSource(sql) ? analyzeMongoDemo(sql) : analyzeBatch(sql);
  }
}

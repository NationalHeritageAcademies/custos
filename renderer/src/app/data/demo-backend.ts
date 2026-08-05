import {
  analyzeBatch,
  firstMutatingKind,
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
];

const DATABASES: Record<string, string[]> = {
  'sales-prod': ['analytics'],
  'shop-mysql': ['shopdb'],
};

const TABLES: Record<string, TableRef[]> = {
  'sales-prod': [
    { schema: 'dbo', name: 'customers', kind: 'table' },
    { schema: 'dbo', name: 'orders', kind: 'table' },
    { schema: 'dbo', name: 'order_items', kind: 'table' },
    { schema: 'dbo', name: 'refunds', kind: 'table' },
    { schema: 'dbo', name: 'reporting', kind: 'view' },
  ],
  'shop-mysql': [
    { schema: null, name: 'products', kind: 'table' },
    { schema: null, name: 'carts', kind: 'table' },
    { schema: null, name: 'inventory', kind: 'table' },
  ],
};

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
 * {@link analyzeBatch}/{@link firstMutatingKind} guards from @custos/core so
 * read-only and destructive-confirmation behavior matches the engine. Used
 * automatically when `window.custos` is absent (i.e. running outside Electron).
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
          { key: 'database', label: 'Database', type: 'string', required: true },
          { key: 'authMode', label: 'Authentication', type: 'select', required: true, default: 'sql', options: [ { value: 'sql', label: 'SQL login' }, { value: 'ntlm', label: 'Windows (NTLM)' }, { value: 'azuread-token', label: 'Azure AD access token' } ] },
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

  async listDatabases(connectionId: string): Promise<string[]> {
    return DATABASES[connectionId] ?? [];
  }

  async listSchemas(connectionId: string): Promise<string[]> {
    return connectionId === 'sales-prod' ? ['dbo', 'reporting'] : [];
  }

  async listTables(connectionId: string, schema?: string): Promise<TableRef[]> {
    const all = TABLES[connectionId] ?? [];
    return schema ? all.filter((t) => (t.schema ?? '') === schema) : all;
  }

  async listColumns(): Promise<ColumnMeta[]> {
    return CHURN_COLUMNS;
  }

  async listForeignKeys(): Promise<ForeignKey[]> {
    return [];
  }

  async runQuery(input: RunQueryInput): Promise<QueryResult> {
    const conn = this.connections.find((c) => c.id === input.connectionId);
    const start = Date.now();

    // Same guardrails the engine enforces, powered by the same core functions.
    if (conn?.readOnly) {
      const mutating = firstMutatingKind(input.sql);
      if (mutating) {
        throw bridgeError('READ_ONLY_VIOLATION', `This connection is read-only; refusing to run a "${mutating.keyword}" statement.`);
      }
    }
    if (!input.confirmDestructive) {
      const needsConfirm = analyzeBatch(input.sql).filter((a) => a.requiresConfirmation);
      if (needsConfirm.length > 0) {
        throw bridgeError('CONFIRMATION_REQUIRED', 'This statement requires confirmation before it can run.', needsConfirm);
      }
    }

    const keyword = analyzeBatch(input.sql)[0]?.keyword ?? '';
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

  async analyzeSql(sql: string): Promise<StatementAnalysis[]> {
    return analyzeBatch(sql);
  }
}

import * as sql from 'mssql';
import type { TokenCredential } from '@azure/identity';
import {
  ConnectionError,
  QueryError,
  SignInRequiredError,
  canStreamSelect,
  emptyResultSet,
  toResultSet,
  type ColumnMeta,
  type ConnectionConfig,
  type ConnectionField,
  type ConnectionSecrets,
  type DatabaseDriver,
  type DriverCapabilities,
  type DriverConnection,
  type DriverMetadata,
  type ForeignKey,
  type QueryOptions,
  type InteractiveAuthDriver,
  type QueryResult,
  type ResultSet,
  type SignInPrompt,
  type SignInRequirement,
  type SqlValue,
  type TableRef,
  type TestConnectionResult,
} from '@custos/core';
import {
  ensureEntraToken,
  entraSignIn,
  forgetEntraCredential,
  entraSignInRequirement,
  getEntraCredential,
} from './entra';

const METADATA: DriverMetadata = {
  id: 'azuresql',
  displayName: 'Azure SQL',
  iconId: 'azuresql',
};

const CAPABILITIES: DriverCapabilities = {
  supportsSchemas: true,
  supportsTransactions: true,
  supportsMultipleResultSets: true,
  supportsCancel: true,
  paramStyle: 'named',
  defaultPort: 1433,
};

const CONNECTION_FIELDS: ConnectionField[] = [
  { key: 'server', label: 'Server', type: 'string', required: true, placeholder: 'myserver.database.windows.net' },
  { key: 'port', label: 'Port', type: 'number', required: true, default: 1433 },
  { key: 'database', label: 'Database', type: 'string', placeholder: 'optional — browse and pick from the tree', help: 'Leave blank to connect to the server and choose a database from the tree.' },
  {
    key: 'authMode',
    label: 'Authentication',
    type: 'select',
    required: true,
    default: 'sql',
    options: [
      { value: 'sql', label: 'SQL login' },
      { value: 'ntlm', label: 'Windows (NTLM)' },
      { value: 'entra-mfa', label: 'Microsoft Entra ID \u2014 sign in with MFA' },
      { value: 'entra-browser', label: 'Microsoft Entra ID \u2014 sign in via browser' },
      { value: 'entra-azure-cli', label: 'Microsoft Entra ID \u2014 use the Azure CLI login' },
      { value: 'azuread-token', label: 'Azure AD access token (paste)' },
    ],
  },
  {
    key: 'tenantId',
    label: 'Tenant',
    type: 'string',
    placeholder: 'optional \u2014 contoso.onmicrosoft.com or a tenant GUID',
    visibleWhen: { field: 'authMode', in: ['entra-mfa', 'entra-browser', 'entra-azure-cli'] },
    help: 'Leave blank to sign in to your account\u2019s own tenant.',
  },
  {
    key: 'clientId',
    label: 'App registration (client ID)',
    type: 'string',
    placeholder: 'optional \u2014 GUID of your Entra app registration',
    visibleWhen: { field: 'authMode', in: ['entra-mfa', 'entra-browser'] },
    help: 'Leave blank to sign in through the Microsoft developer sign-on app. Tenants that block it need their own registered public client (redirect URI http://localhost).',
  },
  {
    key: 'domain',
    label: 'Domain',
    type: 'string',
    placeholder: 'e.g. CORP',
    visibleWhen: { field: 'authMode', equals: 'ntlm' },
    help: 'Windows domain for NTLM (integrated) authentication.',
  },
  { key: 'user', label: 'User', type: 'string', visibleWhen: { field: 'authMode', in: ['sql', 'ntlm'] } },
  {
    key: 'password',
    label: 'Password',
    type: 'password',
    secret: true,
    visibleWhen: { field: 'authMode', in: ['sql', 'ntlm'] },
  },
  {
    key: 'accessToken',
    label: 'Access token',
    type: 'password',
    secret: true,
    visibleWhen: { field: 'authMode', equals: 'azuread-token' },
    help: 'An Entra ID access token for https://database.windows.net/.',
  },
  { key: 'encrypt', label: 'Encrypt', type: 'boolean', default: true },
  { key: 'trustServerCertificate', label: 'Trust server certificate', type: 'boolean', default: false },
];

/** Build the mssql/tedious config from a Custos connection. Exported for tests. */
export function buildConfig(config: ConnectionConfig, secrets: ConnectionSecrets): sql.config {
  const p = config.params;
  const base: sql.config = {
    server: String(p.server ?? ''),
    port: Number(p.port ?? CAPABILITIES.defaultPort),
    database: p.database ? String(p.database) : undefined,
    options: {
      encrypt: p.encrypt !== false,
      trustServerCertificate: p.trustServerCertificate === true,
    },
    // Single pooled connection so a `USE [db]` sticks for later queries.
    pool: { max: 1, min: 0, idleTimeoutMillis: 30_000 },
  };

  const entra = getEntraCredential(p);
  if (entra) {
    // tedious asks this credential for a token at every login, so tokens
    // refresh themselves for the life of the sign-in — no stale-token pool.
    return {
      ...base,
      authentication: {
        type: 'token-credential',
        options: { credential: entra.credential },
      },
    };
  }

  if (p.authMode === 'azuread-token') {
    return {
      ...base,
      authentication: {
        type: 'azure-active-directory-access-token',
        options: { token: secrets.accessToken ?? '' },
      },
    };
  }

  if (p.authMode === 'ntlm') {
    // node-mssql (via tedious) performs NTLM / Windows-integrated auth when a
    // `domain` is supplied alongside user + password.
    return {
      ...base,
      user: p.user ? String(p.user) : undefined,
      password: secrets.password,
      domain: p.domain ? String(p.domain) : undefined,
    };
  }

  return { ...base, user: p.user ? String(p.user) : undefined, password: secrets.password };
}

/** The live credential in a built config, when the connection uses an Entra mode. */
function credentialOf(config: sql.config): TokenCredential | undefined {
  const auth = config.authentication as { type?: string; options?: { credential?: TokenCredential } };
  return auth?.type === 'token-credential' ? auth.options?.credential : undefined;
}

/**
 * Build the connection pool, re-attaching the live token credential afterwards.
 *
 * node-mssql deep-clones its config (rfdc) inside the ConnectionPool
 * constructor, which flattens a class instance into a plain object — the
 * credential arrives at tedious with its prototype (and so its `getToken`)
 * stripped, and tedious rejects it: "The
 * config.authentication.options.credential property must be an instance of the
 * token credential class." Putting the real credential back on the pool's own
 * config fixes it for good: mssql re-reads that config every time it opens a
 * connection, so token refresh keeps working on reconnects too.
 *
 * Exported for tests — building a pool opens no socket.
 */
export function buildPool(config: ConnectionConfig, secrets: ConnectionSecrets): sql.ConnectionPool {
  const built = buildConfig(config, secrets);
  const pool = new sql.ConnectionPool(built);
  const credential = credentialOf(built);
  if (credential) {
    // `config` is mssql's own (undeclared in @types/mssql) copy of what it was
    // given; it is what mssql maps to tedious options on every connect.
    const cloned = (pool as unknown as { config: sql.config }).config;
    const auth = cloned.authentication as { options?: { credential?: TokenCredential } } | undefined;
    if (auth?.options) auth.options.credential = credential;
  }
  return pool;
}

/** Human-readable label for an auth mode, used in error messages. */
function authModeLabel(mode: string): string {
  switch (mode) {
    case 'ntlm':
      return 'Windows (NTLM) authentication';
    case 'azuread-token':
      return 'Azure AD token authentication';
    case 'entra-mfa':
    case 'entra-browser':
    case 'entra-azure-cli':
      return 'Microsoft Entra ID authentication';
    default:
      return 'SQL login';
  }
}

/**
 * Fail fast with a clear message when the secrets an auth mode needs are absent,
 * instead of handing tedious an undefined password. With NTLM that would throw
 * deep in the login handshake (`ERR_INVALID_ARG_TYPE`) on a code path that
 * escapes the awaited `connect()` and crashes the host process. The web host
 * keeps secrets in memory only, so a saved connection loses its password across
 * restarts — this turns that into a friendly "re-enter it" rather than a crash.
 *
 * Exported for direct unit testing (no network required).
 */
export function assertRequiredSecrets(config: ConnectionConfig, secrets: ConnectionSecrets): void {
  const mode = String(config.params.authMode ?? 'sql');
  const missing = (field: string): never => {
    throw new ConnectionError(
      `This Azure SQL connection uses ${authModeLabel(mode)} but its ${field} is missing. ` +
        `Re-enter it in the connection form and try again. ` +
        `(The web host keeps secrets in memory only, so they are cleared when it restarts.)`,
    );
  };
  if (mode === 'azuread-token') {
    if (!secrets.accessToken) missing('access token');
    return;
  }
  // Entra modes hold no secret of ours: the token comes from the signed-in
  // credential (see entra.ts), which `ensureEntraToken` checks instead.
  if (getEntraCredential(config.params)) return;
  // SQL login and NTLM both authenticate with a user + password.
  if (!config.params.user) missing('user name');
  if (!secrets.password) missing('password');
}

/** Quote a SQL Server identifier: [name], with ] doubled. */
function bracket(name: string): string {
  return '[' + name.replace(/]/g, ']]') + ']';
}

/** `[db].` prefix for three-part names, or '' to use the current database. */
function dbPrefix(database?: string): string {
  return database ? `${bracket(database)}.` : '';
}

function columnsOf(recordset: sql.IRecordSet<Record<string, unknown>> | undefined): ColumnMeta[] {
  return columnMetaFrom(recordset?.columns);
}

/** ColumnMeta from an mssql column-metadata object (as the `recordset` stream event delivers). */
function columnMetaFrom(columns: sql.IColumnMetadata | undefined): ColumnMeta[] {
  if (!columns) return [];
  return Object.values(columns)
    .sort((a, b) => a.index - b.index)
    .map((c) => ({
      name: c.name,
      dataType: (c.type as unknown as { declaration?: string })?.declaration ?? 'unknown',
      nullable: c.nullable,
    }));
}

class AzureSqlConnection implements DriverConnection {
  constructor(private readonly pool: sql.ConnectionPool) {}

  private async rows<T extends Record<string, unknown>>(query: string): Promise<T[]> {
    const result = await this.pool.request().query<T>(query);
    return result.recordset ?? [];
  }

  async listDatabases(): Promise<string[]> {
    const rows = await this.rows<{ name: string }>(
      'SELECT name FROM sys.databases WHERE database_id > 4 ORDER BY name',
    );
    return rows.map((r) => r.name);
  }

  async listSchemas(database?: string): Promise<string[]> {
    const rows = await this.rows<{ name: string }>(
      `SELECT name FROM ${dbPrefix(database)}sys.schemas
        WHERE name NOT IN ('sys','INFORMATION_SCHEMA','guest')
        ORDER BY name`,
    );
    return rows.map((r) => r.name);
  }

  async listTables(database?: string, schema?: string): Promise<TableRef[]> {
    const request = this.pool.request();
    let where = '';
    if (schema) {
      request.input('schema', sql.NVarChar, schema);
      where = 'WHERE TABLE_SCHEMA = @schema';
    }
    // Three-part name reads any database without changing the session context.
    const result = await request.query<{ TABLE_SCHEMA: string; TABLE_NAME: string; TABLE_TYPE: string }>(
      `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
         FROM ${dbPrefix(database)}INFORMATION_SCHEMA.TABLES ${where}
        ORDER BY TABLE_SCHEMA, TABLE_NAME`,
    );
    return (result.recordset ?? []).map((r) => ({
      database: database ?? null,
      schema: r.TABLE_SCHEMA,
      name: r.TABLE_NAME,
      kind: r.TABLE_TYPE === 'VIEW' ? 'view' : 'table',
    }));
  }

  async getColumns(table: TableRef): Promise<ColumnMeta[]> {
    const request = this.pool.request();
    request.input('schema', sql.NVarChar, table.schema ?? 'dbo');
    request.input('table', sql.NVarChar, table.name);
    const result = await request.query<{ COLUMN_NAME: string; DATA_TYPE: string; IS_NULLABLE: string }>(
      `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
         FROM ${dbPrefix(table.database ?? undefined)}INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table
        ORDER BY ORDINAL_POSITION`,
    );
    return (result.recordset ?? []).map((r) => ({
      name: r.COLUMN_NAME,
      dataType: r.DATA_TYPE,
      nullable: r.IS_NULLABLE === 'YES',
    }));
  }

  async getForeignKeys(table: TableRef): Promise<ForeignKey[]> {
    const request = this.pool.request();
    request.input('schema', sql.NVarChar, table.schema ?? 'dbo');
    request.input('table', sql.NVarChar, table.name);
    const p = dbPrefix(table.database ?? undefined);
    const result = await request.query<{
      name: string;
      col: string;
      refSchema: string;
      refTable: string;
      refCol: string;
    }>(
      `SELECT fk.name AS name,
              pc.name AS col,
              rs.name AS refSchema,
              rt.name AS refTable,
              rc.name AS refCol
         FROM ${p}sys.foreign_keys fk
         JOIN ${p}sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
         JOIN ${p}sys.tables pt ON pt.object_id = fk.parent_object_id
         JOIN ${p}sys.schemas ps ON ps.schema_id = pt.schema_id
         JOIN ${p}sys.columns pc ON pc.object_id = pt.object_id AND pc.column_id = fkc.parent_column_id
         JOIN ${p}sys.tables rt ON rt.object_id = fk.referenced_object_id
         JOIN ${p}sys.schemas rs ON rs.schema_id = rt.schema_id
         JOIN ${p}sys.columns rc ON rc.object_id = rt.object_id AND rc.column_id = fkc.referenced_column_id
        WHERE ps.name = @schema AND pt.name = @table
        ORDER BY fk.name, fkc.constraint_column_id`,
    );
    const byName = new Map<string, ForeignKey>();
    for (const r of result.recordset ?? []) {
      const existing = byName.get(r.name);
      if (existing) {
        existing.columns.push(r.col);
        existing.referencedColumns.push(r.refCol);
      } else {
        byName.set(r.name, {
          name: r.name,
          columns: [r.col],
          referencedSchema: r.refSchema,
          referencedTable: r.refTable,
          referencedColumns: [r.refCol],
        });
      }
    }
    return [...byName.values()];
  }

  async useDatabase(database: string): Promise<void> {
    // Pool max is 1, so this USE persists for subsequent queries.
    await this.pool.request().query(`USE ${bracket(database)}`);
  }

  async query(query: string, options: QueryOptions = {}): Promise<QueryResult> {
    const start = Date.now();
    // A single capped SELECT streams and stops fetching once the cap is hit,
    // rather than buffering the whole result set and then truncating.
    if (canStreamSelect(query, options.maxRows)) {
      return this.queryStreaming(query, options, start);
    }
    return this.queryBuffered(query, options, start);
  }

  private applyParams(request: sql.Request, options: QueryOptions): void {
    // Named parameters (@name) are supplied as an object under paramStyle 'named'.
    if (options.params && !Array.isArray(options.params)) {
      for (const [key, value] of Object.entries(options.params)) {
        request.input(key, value);
      }
    }
  }

  /**
   * Stream a single result-set statement, keeping at most `maxRows` rows and
   * cancelling the request as soon as one more arrives (which stops SQL Server
   * sending the rest). Only reached via {@link canStreamSelect}. Peak memory is
   * bounded to ~`maxRows` rows regardless of table size.
   */
  private queryStreaming(query: string, options: QueryOptions, start: number): Promise<QueryResult> {
    const cap = options.maxRows && options.maxRows > 0 ? options.maxRows : Infinity;
    const request = this.pool.request();
    request.stream = true;
    this.applyParams(request, options);

    return new Promise<QueryResult>((resolve, reject) => {
      let columns: ColumnMeta[] = [];
      const rowObjects: Record<string, unknown>[] = [];
      let truncated = false;
      let settled = false;
      let onAbort: (() => void) | undefined;

      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        if (options.signal && onAbort) options.signal.removeEventListener('abort', onAbort);
        fn();
      };
      const done = (): void => {
        const rows: SqlValue[][] = rowObjects.map((obj) =>
          columns.map((col) => (obj[col.name] ?? null) as SqlValue),
        );
        settle(() =>
          resolve({
            resultSets: [{ columns, rows, truncated }],
            rowsAffected: null,
            executionMs: Date.now() - start,
          }),
        );
      };

      request.on('recordset', (cols: sql.IColumnMetadata) => {
        columns = columnMetaFrom(cols);
      });
      request.on('row', (row: Record<string, unknown>) => {
        if (settled) return;
        if (rowObjects.length < cap) {
          rowObjects.push(row);
        } else {
          // One row past the cap: mark truncated and stop the server sending more.
          truncated = true;
          request.cancel();
          done();
        }
      });
      request.on('done', done);
      request.on('error', (err: Error) => {
        // The cancel we issue at the cap surfaces here too; it's already settled.
        settle(() => reject(new QueryError(err.message, { cause: err })));
      });

      if (options.signal) {
        onAbort = () => {
          request.cancel();
          settle(() => reject(new QueryError('Query cancelled.')));
        };
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener('abort', onAbort, { once: true });
      }

      // With stream:true the promise settles on 'done'/'error'; guard anyway.
      request.query(query).catch((err: Error) => settle(() => reject(new QueryError(err.message, { cause: err }))));
    });
  }

  private async queryBuffered(query: string, options: QueryOptions, start: number): Promise<QueryResult> {
    const request = this.pool.request();
    request.multiple = true;
    this.applyParams(request, options);

    let onAbort: (() => void) | undefined;
    if (options.signal) {
      onAbort = () => request.cancel();
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const result = await request.query(query);
      return this.normalize(result, options.maxRows, start);
    } catch (err) {
      throw new QueryError((err as Error).message, { cause: err });
    } finally {
      if (options.signal && onAbort) options.signal.removeEventListener('abort', onAbort);
    }
  }

  private normalize(result: sql.IResult<unknown>, maxRows: number | undefined, start: number): QueryResult {
    const recordsets = (result.recordsets as unknown as sql.IRecordSet<Record<string, unknown>>[]) ?? [];
    const resultSets: ResultSet[] = recordsets.map((rs) =>
      toResultSet(columnsOf(rs), rs as unknown as Record<string, unknown>[], maxRows),
    );
    if (resultSets.length === 0) resultSets.push(emptyResultSet());

    const affected = Array.isArray(result.rowsAffected)
      ? result.rowsAffected.reduce((a, b) => a + b, 0)
      : null;

    return { resultSets, rowsAffected: affected, executionMs: Date.now() - start };
  }

  async close(): Promise<void> {
    await this.pool.close();
  }
}

export class AzureSqlDriver implements DatabaseDriver, InteractiveAuthDriver {
  readonly metadata = METADATA;
  readonly capabilities = CAPABILITIES;
  readonly connectionFields = CONNECTION_FIELDS;

  /** Whether these params sign in interactively, and who is signed in now. */
  signInRequirement(params: ConnectionConfig['params']): SignInRequirement {
    return entraSignInRequirement(params);
  }

  /**
   * Sign in to Microsoft Entra ID (MFA included — Microsoft runs the whole
   * challenge). Resolves with the account once the user finishes; `onPrompt`
   * fires earlier, with the device code to show them.
   */
  signIn(
    params: ConnectionConfig['params'],
    onPrompt: (prompt: SignInPrompt) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    return entraSignIn(params, onPrompt, signal);
  }

  /** Forget the token session so the next sign-in can pick another account. */
  forgetSignIn(params: ConnectionConfig['params']): void {
    forgetEntraCredential(params);
  }

  async connect(config: ConnectionConfig, secrets: ConnectionSecrets): Promise<DriverConnection> {
    assertRequiredSecrets(config, secrets);
    // Entra modes: confirm a token is in hand before tedious tries to log in,
    // so "you need to sign in" is a clear SIGN_IN_REQUIRED rather than a
    // federated-auth failure from the middle of the handshake.
    await ensureEntraToken(config.params);
    try {
      const pool = buildPool(config, secrets);
      await pool.connect();
      return new AzureSqlConnection(pool);
    } catch (err) {
      throw new ConnectionError((err as Error).message, { cause: err });
    }
  }

  async testConnection(
    config: ConnectionConfig,
    secrets: ConnectionSecrets,
  ): Promise<TestConnectionResult> {
    const start = Date.now();
    let pool: sql.ConnectionPool | undefined;
    try {
      assertRequiredSecrets(config, secrets);
      await ensureEntraToken(config.params);
      pool = buildPool(config, secrets);
      await pool.connect();
      const result = await pool.request().query<{ v: string }>('SELECT @@VERSION AS v');
      return {
        ok: true,
        message: 'Connected successfully.',
        serverVersion: result.recordset?.[0]?.v?.split('\n')[0],
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      // A missing sign-in is not a test failure to report inline — it is an
      // action the user can take, so let it travel as SIGN_IN_REQUIRED and the
      // UI will offer the sign-in dialog and retry.
      if (err instanceof SignInRequiredError) throw err;
      return { ok: false, message: (err as Error).message };
    } finally {
      await pool?.close().catch(() => undefined);
    }
  }
}

export { forgetEntraCredential, isInteractiveEntraMode, resetEntraCredentials } from './entra';

export default AzureSqlDriver;

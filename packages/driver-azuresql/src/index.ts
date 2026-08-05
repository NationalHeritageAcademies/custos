import * as sql from 'mssql';
import {
  ConnectionError,
  QueryError,
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
  type QueryResult,
  type ResultSet,
  type TableRef,
  type TestConnectionResult,
} from '@custos/core';

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
  { key: 'database', label: 'Database', type: 'string', required: true },
  {
    key: 'authMode',
    label: 'Authentication',
    type: 'select',
    required: true,
    default: 'sql',
    options: [
      { value: 'sql', label: 'SQL login' },
      { value: 'azuread-token', label: 'Azure AD access token' },
    ],
  },
  { key: 'user', label: 'User', type: 'string', visibleWhen: { field: 'authMode', equals: 'sql' } },
  {
    key: 'password',
    label: 'Password',
    type: 'password',
    secret: true,
    visibleWhen: { field: 'authMode', equals: 'sql' },
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

function buildConfig(config: ConnectionConfig, secrets: ConnectionSecrets): sql.config {
  const p = config.params;
  const base: sql.config = {
    server: String(p.server ?? ''),
    port: Number(p.port ?? CAPABILITIES.defaultPort),
    database: p.database ? String(p.database) : undefined,
    options: {
      encrypt: p.encrypt !== false,
      trustServerCertificate: p.trustServerCertificate === true,
    },
    pool: { max: 4, min: 0, idleTimeoutMillis: 30_000 },
  };

  if (p.authMode === 'azuread-token') {
    return {
      ...base,
      authentication: {
        type: 'azure-active-directory-access-token',
        options: { token: secrets.accessToken ?? '' },
      },
    };
  }
  return { ...base, user: p.user ? String(p.user) : undefined, password: secrets.password };
}

function columnsOf(recordset: sql.IRecordSet<Record<string, unknown>> | undefined): ColumnMeta[] {
  if (!recordset?.columns) return [];
  return Object.values(recordset.columns)
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

  async listSchemas(): Promise<string[]> {
    const rows = await this.rows<{ name: string }>(
      `SELECT name FROM sys.schemas
        WHERE name NOT IN ('sys','INFORMATION_SCHEMA','guest')
        ORDER BY name`,
    );
    return rows.map((r) => r.name);
  }

  async listTables(schema?: string): Promise<TableRef[]> {
    const request = this.pool.request();
    let where = '';
    if (schema) {
      request.input('schema', sql.NVarChar, schema);
      where = 'WHERE TABLE_SCHEMA = @schema';
    }
    const result = await request.query<{ TABLE_SCHEMA: string; TABLE_NAME: string; TABLE_TYPE: string }>(
      `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
         FROM INFORMATION_SCHEMA.TABLES ${where}
        ORDER BY TABLE_SCHEMA, TABLE_NAME`,
    );
    return (result.recordset ?? []).map((r) => ({
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
         FROM INFORMATION_SCHEMA.COLUMNS
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
         FROM sys.foreign_keys fk
         JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
         JOIN sys.tables pt ON pt.object_id = fk.parent_object_id
         JOIN sys.schemas ps ON ps.schema_id = pt.schema_id
         JOIN sys.columns pc ON pc.object_id = pt.object_id AND pc.column_id = fkc.parent_column_id
         JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id
         JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
         JOIN sys.columns rc ON rc.object_id = rt.object_id AND rc.column_id = fkc.referenced_column_id
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

  async query(query: string, options: QueryOptions = {}): Promise<QueryResult> {
    const start = Date.now();
    const request = this.pool.request();
    request.multiple = true;

    // Named parameters (@name) are supplied as an object under paramStyle 'named'.
    if (options.params && !Array.isArray(options.params)) {
      for (const [key, value] of Object.entries(options.params)) {
        request.input(key, value);
      }
    }

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

export class AzureSqlDriver implements DatabaseDriver {
  readonly metadata = METADATA;
  readonly capabilities = CAPABILITIES;
  readonly connectionFields = CONNECTION_FIELDS;

  async connect(config: ConnectionConfig, secrets: ConnectionSecrets): Promise<DriverConnection> {
    try {
      const pool = new sql.ConnectionPool(buildConfig(config, secrets));
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
      pool = new sql.ConnectionPool(buildConfig(config, secrets));
      await pool.connect();
      const result = await pool.request().query<{ v: string }>('SELECT @@VERSION AS v');
      return {
        ok: true,
        message: 'Connected successfully.',
        serverVersion: result.recordset?.[0]?.v?.split('\n')[0],
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    } finally {
      await pool?.close().catch(() => undefined);
    }
  }
}

export default AzureSqlDriver;

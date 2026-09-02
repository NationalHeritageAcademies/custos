import mysql from 'mysql2/promise';
import {
  ConnectionError,
  QueryError,
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
  type QueryResult,
  type ResultSet,
  type SqlValue,
  type TableRef,
  type TestConnectionResult,
} from '@custos/core';

// `canStreamSelect` (the single-capped-SELECT gate) lives in @custos/core so the
// MySQL and Azure SQL drivers share one definition; re-exported for tests.
export { canStreamSelect } from '@custos/core';

// The row-stream / event API lives on mysql2's callback connection, not the
// promise wrapper. These are the only members the streaming path touches.
interface RowStream {
  on(event: 'data', cb: (row: Record<string, unknown>) => void): RowStream;
  on(event: 'end', cb: () => void): RowStream;
  on(event: 'error', cb: (err: Error) => void): RowStream;
  destroy(): void;
}
interface RawQuery {
  on(event: 'fields', cb: (fields: mysql.FieldPacket[]) => void): RawQuery;
  stream(): RowStream;
}
interface RawConnection {
  query(opts: { sql: string; values?: unknown[] }): RawQuery;
}

const METADATA: DriverMetadata = {
  id: 'mysql',
  displayName: 'MySQL',
  iconId: 'mysql',
};

const CAPABILITIES: DriverCapabilities = {
  // In MySQL a "schema" is a database, so there is no separate schema level.
  supportsSchemas: false,
  supportsTransactions: true,
  supportsMultipleResultSets: true,
  supportsCancel: true,
  paramStyle: 'positional',
  defaultPort: 3306,
};

const CONNECTION_FIELDS: ConnectionField[] = [
  { key: 'host', label: 'Host', type: 'string', required: true, default: 'localhost' },
  { key: 'port', label: 'Port', type: 'number', required: true, default: 3306 },
  { key: 'user', label: 'User', type: 'string', required: true },
  { key: 'password', label: 'Password', type: 'password', secret: true },
  { key: 'database', label: 'Database', type: 'string', placeholder: 'optional' },
  {
    key: 'ssl',
    label: 'Use TLS',
    type: 'boolean',
    default: false,
    help: 'Require an encrypted connection to the server.',
  },
];

function buildConnectionOptions(
  config: ConnectionConfig,
  secrets: ConnectionSecrets,
): mysql.ConnectionOptions {
  const p = config.params;
  const options: mysql.ConnectionOptions = {
    host: String(p.host ?? 'localhost'),
    port: Number(p.port ?? CAPABILITIES.defaultPort),
    user: p.user ? String(p.user) : undefined,
    password: secrets.password ?? undefined,
    database: p.database ? String(p.database) : undefined,
    multipleStatements: true,
    dateStrings: false,
    supportBigNumbers: true,
    bigNumberStrings: false,
  };
  if (p.ssl === true || p.ssl === 'true') {
    options.ssl = { rejectUnauthorized: true };
  }
  return options;
}

/** Map a mysql2 column type id to a readable label. */
function typeLabel(columnType: number | undefined): string {
  return columnType != null ? (MYSQL_TYPE_NAMES[columnType] ?? `type_${columnType}`) : 'unknown';
}

// A pragmatic subset of the MySQL protocol type ids; unknown ids fall back to
// `type_<id>` so nothing is lost.
const MYSQL_TYPE_NAMES: Record<number, string> = {
  0: 'decimal',
  1: 'tinyint',
  2: 'smallint',
  3: 'int',
  4: 'float',
  5: 'double',
  7: 'timestamp',
  8: 'bigint',
  9: 'mediumint',
  10: 'date',
  11: 'time',
  12: 'datetime',
  13: 'year',
  15: 'varchar',
  16: 'bit',
  245: 'json',
  246: 'decimal',
  252: 'blob',
  253: 'varchar',
  254: 'char',
};

function fieldsToColumns(fields: mysql.FieldPacket[] | undefined): ColumnMeta[] {
  if (!fields) return [];
  return fields.map((f) => ({
    name: f.name,
    // FieldPacket exposes `columnType` at runtime; the public type is loose.
    dataType: typeLabel((f as unknown as { columnType?: number }).columnType),
  }));
}

class MySqlConnection implements DriverConnection {
  constructor(
    private readonly conn: mysql.Connection,
    private readonly killerFactory: () => Promise<mysql.Connection>,
  ) {}

  async listDatabases(): Promise<string[]> {
    const [rows] = await this.conn.query<mysql.RowDataPacket[]>('SHOW DATABASES');
    return rows.map((r) => String(Object.values(r)[0]));
  }

  // MySQL has no schema level below the database.
  async listSchemas(): Promise<string[]> {
    return [];
  }

  // In MySQL a "database" is the browsing unit; `schema` is unused.
  async listTables(database?: string): Promise<TableRef[]> {
    const [rows] = await this.conn.query<mysql.RowDataPacket[]>(
      `SELECT table_schema AS db, table_name AS name, table_type AS type
         FROM information_schema.tables
        WHERE table_schema = COALESCE(?, DATABASE())
        ORDER BY table_name`,
      [database ?? null],
    );
    return rows.map((r) => ({
      database: String(r.db),
      schema: null,
      name: String(r.name),
      kind: String(r.type).includes('VIEW') ? 'view' : 'table',
    }));
  }

  async getColumns(table: TableRef): Promise<ColumnMeta[]> {
    const [rows] = await this.conn.query<mysql.RowDataPacket[]>(
      `SELECT column_name AS name, data_type AS dataType, is_nullable AS nullable
         FROM information_schema.columns
        WHERE table_schema = COALESCE(?, DATABASE()) AND table_name = ?
        ORDER BY ordinal_position`,
      [table.database ?? null, table.name],
    );
    return rows.map((r) => ({
      name: String(r.name),
      dataType: String(r.dataType),
      nullable: String(r.nullable).toUpperCase() === 'YES',
    }));
  }

  async getForeignKeys(table: TableRef): Promise<ForeignKey[]> {
    const [rows] = await this.conn.query<mysql.RowDataPacket[]>(
      `SELECT constraint_name AS name, column_name AS col,
              referenced_table_name AS refTable, referenced_column_name AS refCol
         FROM information_schema.key_column_usage
        WHERE table_schema = COALESCE(?, DATABASE())
          AND table_name = ?
          AND referenced_table_name IS NOT NULL
        ORDER BY constraint_name, ordinal_position`,
      [table.database ?? null, table.name],
    );
    const byName = new Map<string, ForeignKey>();
    for (const r of rows) {
      const name = String(r.name);
      const existing = byName.get(name);
      if (existing) {
        existing.columns.push(String(r.col));
        existing.referencedColumns.push(String(r.refCol));
      } else {
        byName.set(name, {
          name,
          columns: [String(r.col)],
          referencedSchema: null,
          referencedTable: String(r.refTable),
          referencedColumns: [String(r.refCol)],
        });
      }
    }
    return [...byName.values()];
  }

  async query(sql: string, options: QueryOptions = {}): Promise<QueryResult> {
    const start = Date.now();
    // A single capped SELECT streams and stops fetching once the cap is hit,
    // instead of pulling the whole result set into memory and then truncating.
    if (canStreamSelect(sql, options.maxRows)) {
      return this.queryStreaming(sql, options, start);
    }
    return this.queryBuffered(sql, options, start);
  }

  /**
   * Stream a single result-set statement, keeping at most `maxRows` rows and
   * destroying the stream as soon as one more arrives (which stops MySQL sending
   * the rest). Only reached via {@link canStreamSelect}, so the stream always
   * terminates. Peak memory is bounded to ~`maxRows` rows regardless of table
   * size.
   */
  private queryStreaming(sql: string, options: QueryOptions, start: number): Promise<QueryResult> {
    const cap = options.maxRows && options.maxRows > 0 ? options.maxRows : Infinity;
    const threadId = (this.conn as unknown as { threadId?: number }).threadId;

    return new Promise<QueryResult>((resolve, reject) => {
      let columns: ColumnMeta[] = [];
      const rowObjects: Record<string, unknown>[] = [];
      let truncated = false;
      let settled = false;
      let onAbort: (() => void) | undefined;

      const raw = (this.conn as unknown as { connection: RawConnection }).connection;
      const query = raw.query({
        sql,
        values: Array.isArray(options.params) ? options.params : undefined,
      });
      const stream = query.stream();

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

      query.on('fields', (fields: mysql.FieldPacket[]) => {
        columns = fieldsToColumns(fields);
      });
      stream.on('data', (row: Record<string, unknown>) => {
        if (rowObjects.length < cap) {
          rowObjects.push(row);
        } else {
          // One row past the cap: mark truncated and stop the server sending more.
          truncated = true;
          stream.destroy();
          done();
        }
      });
      stream.on('end', done);
      stream.on('error', (err: Error) => settle(() => reject(new QueryError(err.message, { cause: err }))));

      if (options.signal && threadId != null) {
        onAbort = () => {
          stream.destroy();
          void this.kill(threadId);
          settle(() => reject(new QueryError('Query cancelled.')));
        };
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  private async queryBuffered(sql: string, options: QueryOptions, start: number): Promise<QueryResult> {
    const threadId = (this.conn as unknown as { threadId?: number }).threadId;
    let onAbort: (() => void) | undefined;

    try {
      // NOTE: mysql2 v3 dropped per-query `timeout`; enforce timeouts via the
      // engine/AbortSignal path instead (tracked in docs/execution-plan.md).
      const queryPromise = this.conn.query({
        sql,
        values: Array.isArray(options.params) ? options.params : undefined,
      });

      if (options.signal && threadId != null) {
        onAbort = () => {
          void this.kill(threadId);
        };
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener('abort', onAbort, { once: true });
      }

      const [rawResult, rawFields] = (await queryPromise) as [unknown, unknown];
      return this.normalize(rawResult, rawFields, options.maxRows, start);
    } catch (err) {
      throw new QueryError((err as Error).message, { cause: err });
    } finally {
      if (options.signal && onAbort) options.signal.removeEventListener('abort', onAbort);
    }
  }

  private normalize(
    rawResult: unknown,
    rawFields: unknown,
    maxRows: number | undefined,
    start: number,
  ): QueryResult {
    const resultSets: ResultSet[] = [];
    let rowsAffected: number | null = null;

    // multipleStatements yields arrays-of-arrays; a single statement yields one.
    const isMulti =
      Array.isArray(rawResult) &&
      Array.isArray(rawFields) &&
      rawFields.length > 0 &&
      Array.isArray(rawFields[0]);

    const resultChunks = isMulti ? (rawResult as unknown[]) : [rawResult];
    const fieldChunks = isMulti ? (rawFields as unknown[]) : [rawFields];

    resultChunks.forEach((chunk, i) => {
      if (Array.isArray(chunk)) {
        const columns = fieldsToColumns(fieldChunks[i] as mysql.FieldPacket[] | undefined);
        resultSets.push(toResultSet(columns, chunk as Record<string, unknown>[], maxRows));
      } else if (chunk && typeof chunk === 'object' && 'affectedRows' in chunk) {
        rowsAffected =
          (rowsAffected ?? 0) + Number((chunk as { affectedRows: number }).affectedRows);
        resultSets.push(emptyResultSet());
      }
    });

    if (resultSets.length === 0) resultSets.push(emptyResultSet());
    return { resultSets, rowsAffected, executionMs: Date.now() - start };
  }

  async useDatabase(database: string): Promise<void> {
    // Single-connection driver, so `USE` persists for subsequent queries.
    const escaped = '`' + String(database).replace(/`/g, '``') + '`';
    await this.conn.query(`USE ${escaped}`);
  }

  private async kill(threadId: number): Promise<void> {
    try {
      const killer = await this.killerFactory();
      await killer.query('KILL QUERY ?', [threadId]);
      await killer.end();
    } catch {
      // Best effort — the query may have already finished.
    }
  }

  async close(): Promise<void> {
    await this.conn.end();
  }
}

export class MySqlDriver implements DatabaseDriver {
  readonly metadata = METADATA;
  readonly capabilities = CAPABILITIES;
  readonly connectionFields = CONNECTION_FIELDS;

  async connect(
    config: ConnectionConfig,
    secrets: ConnectionSecrets,
  ): Promise<DriverConnection> {
    const options = buildConnectionOptions(config, secrets);
    try {
      const conn = await mysql.createConnection(options);
      return new MySqlConnection(conn, () => mysql.createConnection(options));
    } catch (err) {
      throw new ConnectionError((err as Error).message, { cause: err });
    }
  }

  async testConnection(
    config: ConnectionConfig,
    secrets: ConnectionSecrets,
  ): Promise<TestConnectionResult> {
    const start = Date.now();
    let conn: mysql.Connection | undefined;
    try {
      conn = await mysql.createConnection(buildConnectionOptions(config, secrets));
      const [rows] = await conn.query<mysql.RowDataPacket[]>('SELECT VERSION() AS v');
      return {
        ok: true,
        message: 'Connected successfully.',
        serverVersion: rows[0] ? String(rows[0].v) : undefined,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    } finally {
      await conn?.end().catch(() => undefined);
    }
  }
}

export default MySqlDriver;

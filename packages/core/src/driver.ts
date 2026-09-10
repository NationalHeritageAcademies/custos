import type {
  ColumnMeta,
  ConnectionConfig,
  ConnectionField,
  ConnectionSecrets,
  DriverCapabilities,
  DriverMetadata,
  ForeignKey,
  QueryOptions,
  QueryResult,
  TableRef,
  TestConnectionResult,
} from './types';
import type { StatementAnalyzer } from './safety';

/**
 * A live connection to a database. Obtained from {@link DatabaseDriver.connect}.
 * All schema-introspection methods feed the connection tree; `query` runs SQL.
 *
 * Implementations run exclusively in the Electron main process — never the
 * renderer — because they hold credentials and open sockets.
 */
export interface DriverConnection {
  listDatabases(): Promise<string[]>;
  /** Schemas within a database; drivers without schemas return `[]`. */
  listSchemas(database?: string): Promise<string[]>;
  /** Tables/views, optionally scoped to a database and schema (for browsing). */
  listTables(database?: string, schema?: string): Promise<TableRef[]>;
  getColumns(table: TableRef): Promise<ColumnMeta[]>;
  getForeignKeys(table: TableRef): Promise<ForeignKey[]>;
  /**
   * Set the current database for subsequent queries on this connection (the
   * server-side `USE`). Lets a user connect to a server without picking a
   * database up front, then choose one from the tree.
   */
  useDatabase(database: string): Promise<void>;
  /** Run a (possibly multi-statement) batch and return normalized results. */
  query(sql: string, options?: QueryOptions): Promise<QueryResult>;
  close(): Promise<void>;
}

/**
 * The contract every database engine implements. Adding support for a new
 * engine means implementing this interface and registering it with a
 * {@link DriverRegistry} — no changes anywhere else in the app.
 *
 * See CONTRIBUTING.md → "How to add a driver".
 */
export interface DatabaseDriver {
  readonly metadata: DriverMetadata;
  readonly capabilities: DriverCapabilities;
  /** Drives the dynamically-rendered "New connection" form. */
  readonly connectionFields: ConnectionField[];
  /**
   * How this driver's query text is split into statements and classified for
   * the guardian rules (read-only enforcement, destructive confirmation).
   * Omit it for SQL engines — the engine falls back to the SQL analyzer. A
   * driver whose query language is not SQL MUST supply one, or its writes will
   * read as `unknown` and slip past the read-only check.
   */
  readonly analyzer?: StatementAnalyzer;

  connect(config: ConnectionConfig, secrets: ConnectionSecrets): Promise<DriverConnection>;
  testConnection(
    config: ConnectionConfig,
    secrets: ConnectionSecrets,
  ): Promise<TestConnectionResult>;
}

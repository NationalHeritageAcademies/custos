/**
 * Core domain types shared by every driver and by the app engine.
 *
 * These types are intentionally engine-agnostic: they contain no Electron,
 * Node, or driver-library imports so they can be consumed by the main process,
 * the renderer (via @custos/shared), and by tests alike.
 */

/** A single cell value as normalized by a driver. */
export type SqlValue =
  | string
  | number
  | boolean
  | bigint
  | Date
  | Uint8Array
  | null
  | Record<string, unknown>
  | unknown[];

/** Metadata for one column of a result set or table. */
export interface ColumnMeta {
  readonly name: string;
  /** Driver-normalized type label, e.g. "int", "varchar", "datetime2". */
  readonly dataType: string;
  readonly nullable?: boolean;
}

/**
 * One result set. Rows are row-major arrays aligned to `columns` (not keyed
 * objects) so that duplicate column names and column order are both preserved,
 * and so the renderer's virtualized grid can index cells positionally.
 */
export interface ResultSet {
  readonly columns: ColumnMeta[];
  readonly rows: SqlValue[][];
  /** True when the driver stopped fetching because `maxRows` was reached. */
  readonly truncated: boolean;
}

/** The full result of running a (possibly multi-statement) batch. */
export interface QueryResult {
  readonly resultSets: ResultSet[];
  /** Total rows affected by DML in the batch, or null when not reported. */
  readonly rowsAffected: number | null;
  readonly executionMs: number;
}

/** Reference to a table or view in the connection tree. */
export interface TableRef {
  readonly schema: string | null;
  readonly name: string;
  readonly kind: 'table' | 'view';
}

/** A foreign-key relationship, used to render relations in the schema tree. */
export interface ForeignKey {
  readonly name: string;
  readonly columns: string[];
  readonly referencedSchema: string | null;
  readonly referencedTable: string;
  readonly referencedColumns: string[];
}

export type ConnectionFieldType =
  | 'string'
  | 'number'
  | 'password'
  | 'boolean'
  | 'select';

export interface ConnectionFieldOption {
  readonly value: string;
  readonly label: string;
}

/**
 * Declarative spec for one field in a driver's connection form. The renderer
 * builds the "New connection" UI entirely from a driver's `connectionFields`,
 * so no engine is special-cased in the UI layer.
 */
export interface ConnectionField {
  readonly key: string;
  readonly label: string;
  readonly type: ConnectionFieldType;
  readonly required?: boolean;
  /** Secret fields are stored in the OS keychain and never written to disk. */
  readonly secret?: boolean;
  readonly default?: string | number | boolean;
  readonly placeholder?: string;
  readonly help?: string;
  /** Options for `select` fields. */
  readonly options?: ConnectionFieldOption[];
  /** Show this field only when another field currently equals a given value. */
  readonly visibleWhen?: { readonly field: string; readonly equals: string };
}

/**
 * Non-secret connection metadata. This is what gets persisted to disk. Secret
 * values (passwords, tokens) live in {@link ConnectionSecrets} and the keychain.
 */
export interface ConnectionConfig {
  readonly id: string;
  readonly name: string;
  readonly driverId: string;
  readonly readOnly: boolean;
  /** Non-secret params keyed by {@link ConnectionField.key}. */
  readonly params: Readonly<Record<string, string | number | boolean>>;
}

/** Secret connection values keyed by {@link ConnectionField.key}. */
export type ConnectionSecrets = Readonly<Record<string, string>>;

export type ParamStyle = 'positional' | 'named' | 'none';

/** What a driver can and cannot do, so the UI adapts rather than assumes. */
export interface DriverCapabilities {
  readonly supportsSchemas: boolean;
  readonly supportsTransactions: boolean;
  readonly supportsMultipleResultSets: boolean;
  readonly supportsCancel: boolean;
  readonly paramStyle: ParamStyle;
  readonly defaultPort: number;
}

export interface DriverMetadata {
  readonly id: string;
  readonly displayName: string;
  /** Icon id the renderer maps to a bundled asset, e.g. "azuresql", "mysql". */
  readonly iconId: string;
}

export interface TestConnectionResult {
  readonly ok: boolean;
  readonly message: string;
  readonly serverVersion?: string;
  readonly latencyMs?: number;
}

/** Options passed to a single query execution. */
export interface QueryOptions {
  /** Positional or named parameters, per the driver's `paramStyle`. */
  readonly params?: SqlValue[] | Record<string, SqlValue>;
  /** Abort signal; drivers that support cancel will cancel the DB request. */
  readonly signal?: AbortSignal;
  /** Stop fetching after this many rows per result set. */
  readonly maxRows?: number;
  /** Server-side statement timeout in milliseconds. */
  readonly timeoutMs?: number;
}

/**
 * @custos/shared — the typed contract between the Electron main process and the
 * Angular renderer. Both sides import from here so the IPC surface is a single
 * source of truth. This package contains ONLY types and constants (no runtime
 * driver or Electron code), so it is safe to bundle into the renderer.
 */
import type {
  ColumnMeta,
  ConnectionConfig,
  ConnectionField,
  ConnectionSecrets,
  DriverCapabilities,
  DriverMetadata,
  ForeignKey,
  QueryResult,
  StatementAnalysis,
  TableRef,
  TestConnectionResult,
} from '@custos/core';

export type {
  ColumnMeta,
  ConnectionConfig,
  ConnectionField,
  ConnectionFieldOption,
  ConnectionFieldType,
  ConnectionSecrets,
  DriverCapabilities,
  DriverMetadata,
  ForeignKey,
  ParamStyle,
  QueryResult,
  ResultSet,
  SqlValue,
  StatementAnalysis,
  StatementKind,
  TableRef,
  TestConnectionResult,
} from '@custos/core';

/** A driver as advertised to the renderer (no executable code crosses IPC). */
export interface DriverInfo {
  readonly metadata: DriverMetadata;
  readonly capabilities: DriverCapabilities;
  readonly connectionFields: ConnectionField[];
}

export interface SaveConnectionInput {
  readonly config: ConnectionConfig;
  /** Stored in the OS keychain; never persisted alongside the config. */
  readonly secrets: ConnectionSecrets;
}

export interface TestConnectionInput {
  readonly driverId: string;
  readonly params: Readonly<Record<string, string | number | boolean>>;
  readonly secrets: ConnectionSecrets;
  readonly readOnly?: boolean;
}

export interface RunQueryInput {
  readonly connectionId: string;
  /** Renderer-generated id used to correlate a later cancel request. */
  readonly queryId: string;
  readonly sql: string;
  readonly maxRows?: number;
  readonly timeoutMs?: number;
  /** Set true after the user has confirmed a destructive statement. */
  readonly confirmDestructive?: boolean;
}

/**
 * Raised across IPC when a batch needs explicit confirmation (e.g. UPDATE with
 * no WHERE). The renderer shows the guardian dialog, then re-invokes with
 * `confirmDestructive: true`.
 */
export interface ConfirmationRequired {
  readonly code: 'CONFIRMATION_REQUIRED';
  readonly analyses: StatementAnalysis[];
}

/**
 * The API surface exposed on `window.custos` by the preload bridge. Every
 * method is async and maps to a single `ipcRenderer.invoke` under the hood.
 */
export interface CustosApi {
  listDrivers(): Promise<DriverInfo[]>;

  listConnections(): Promise<ConnectionConfig[]>;
  saveConnection(input: SaveConnectionInput): Promise<ConnectionConfig>;
  deleteConnection(id: string): Promise<void>;
  testConnection(input: TestConnectionInput): Promise<TestConnectionResult>;

  openConnection(id: string): Promise<void>;
  closeConnection(id: string): Promise<void>;

  listDatabases(connectionId: string): Promise<string[]>;
  listSchemas(connectionId: string, database?: string): Promise<string[]>;
  listTables(connectionId: string, database?: string, schema?: string): Promise<TableRef[]>;
  listColumns(connectionId: string, table: TableRef): Promise<ColumnMeta[]>;
  listForeignKeys(connectionId: string, table: TableRef): Promise<ForeignKey[]>;
  /** Set the current database for subsequent queries on a connection. */
  setActiveDatabase(connectionId: string, database: string): Promise<void>;

  runQuery(input: RunQueryInput): Promise<QueryResult>;
  cancelQuery(connectionId: string, queryId: string): Promise<void>;
  analyzeSql(sql: string): Promise<StatementAnalysis[]>;
}

/** Names of the methods on {@link CustosApi}; the dispatch key over IPC. */
export type CustosApiMethod = keyof CustosApi;

/** The single IPC channel every renderer→main call flows through. */
export const CUSTOS_IPC_CHANNEL = 'custos:invoke' as const;

/** Serializable error shape carried back across IPC (Electron drops custom Error props). */
export interface IpcError {
  readonly code: string;
  readonly message: string;
  /** Present when `code === 'CONFIRMATION_REQUIRED'`. */
  readonly analyses?: StatementAnalysis[];
}

/**
 * Envelope every IPC call resolves to. The preload bridge unwraps it: on
 * `ok: false` it throws a reconstructed Error (with `code`/`analyses`), so the
 * public {@link CustosApi} still reads as plain "returns value / throws".
 */
export type IpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: IpcError };

/** Global augmentation so the renderer can reference `window.custos`. */
declare global {
  interface Window {
    readonly custos: CustosApi;
  }
}

import {
  ConfirmationRequiredError,
  ConnectionError,
  ReadOnlyViolationError,
  analyzeBatch,
  firstMutatingKind,
  type ColumnMeta,
  type ConnectionConfig,
  type ConnectionSecrets,
  type DatabaseDriver,
  type DriverConnection,
  type DriverRegistry,
  type ForeignKey,
  type QueryResult,
  type StatementAnalysis,
  type TableRef,
  type TestConnectionResult,
} from '@custos/core';
import type {
  DriverInfo,
  RunQueryInput,
  SaveConnectionInput,
  TestConnectionInput,
} from '@custos/shared';
import type { ConnectionStore, SecretStore } from './stores';

/**
 * The heart of the main process. Owns the driver registry, persistence stores,
 * and the set of currently-open live connections. Contains ZERO Electron
 * imports so it can be unit-tested with in-memory stores and a fake driver.
 *
 * Responsibilities:
 *  - CRUD over saved connections (metadata to the ConnectionStore, secrets to
 *    the SecretStore/keychain).
 *  - Opening/closing live driver connections.
 *  - Enforcing the per-connection read-only flag.
 *  - Requiring confirmation for destructive statements.
 *  - Correlating in-flight queries so they can be cancelled.
 */
export class ConnectionManager {
  private readonly open = new Map<string, DriverConnection>();
  private readonly openConfigs = new Map<string, ConnectionConfig>();
  private readonly inflight = new Map<string, AbortController>();
  private readonly activeDatabase = new Map<string, string>();

  constructor(
    private readonly registry: DriverRegistry,
    private readonly connectionStore: ConnectionStore,
    private readonly secretStore: SecretStore,
  ) {}

  listDrivers(): DriverInfo[] {
    return this.registry.list().map((driver: DatabaseDriver) => ({
      metadata: driver.metadata,
      capabilities: driver.capabilities,
      connectionFields: driver.connectionFields,
    }));
  }

  listConnections(): Promise<ConnectionConfig[]> {
    return this.connectionStore.list();
  }

  async saveConnection(input: SaveConnectionInput): Promise<ConnectionConfig> {
    // Validate the driver exists before persisting anything.
    this.registry.get(input.config.driverId);
    await this.connectionStore.save(input.config);
    // Merge secrets: only the keys actually provided are updated, so editing a
    // connection without re-typing its password keeps the stored one.
    if (input.secrets && Object.keys(input.secrets).length > 0) {
      const existing = await this.secretStore.get(input.config.id);
      await this.secretStore.set(input.config.id, { ...existing, ...input.secrets });
    }
    // A live connection may hold stale credentials; drop it so the next open
    // reconnects with the updated config/secrets.
    await this.closeConnection(input.config.id);
    return input.config;
  }

  async deleteConnection(id: string): Promise<void> {
    await this.closeConnection(id);
    await this.connectionStore.delete(id);
    await this.secretStore.delete(id);
  }

  testConnection(input: TestConnectionInput): Promise<TestConnectionResult> {
    const driver = this.registry.get(input.driverId);
    const config: ConnectionConfig = {
      id: '__test__',
      name: '__test__',
      driverId: input.driverId,
      readOnly: input.readOnly ?? false,
      params: input.params,
    };
    return driver.testConnection(config, input.secrets);
  }

  async openConnection(id: string): Promise<void> {
    if (this.open.has(id)) return;
    const config = await this.connectionStore.get(id);
    if (!config) {
      throw new ConnectionError(`No saved connection with id "${id}".`);
    }
    const driver = this.registry.get(config.driverId);
    const secrets: ConnectionSecrets = await this.secretStore.get(id);
    const connection = await driver.connect(config, secrets);
    this.open.set(id, connection);
    this.openConfigs.set(id, config);
  }

  async closeConnection(id: string): Promise<void> {
    const connection = this.open.get(id);
    if (!connection) return;
    await connection.close();
    this.open.delete(id);
    this.openConfigs.delete(id);
    this.activeDatabase.delete(id);
  }

  listDatabases(id: string): Promise<string[]> {
    return this.requireOpen(id).listDatabases();
  }
  listSchemas(id: string, database?: string): Promise<string[]> {
    return this.requireOpen(id).listSchemas(database);
  }
  listTables(id: string, database?: string, schema?: string): Promise<TableRef[]> {
    return this.requireOpen(id).listTables(database, schema);
  }

  /** Set the current database for subsequent queries on this connection. */
  async setActiveDatabase(id: string, database: string): Promise<void> {
    await this.requireOpen(id).useDatabase(database);
    this.activeDatabase.set(id, database);
  }

  getActiveDatabase(id: string): string | null {
    return this.activeDatabase.get(id) ?? null;
  }
  listColumns(id: string, table: TableRef): Promise<ColumnMeta[]> {
    return this.requireOpen(id).getColumns(table);
  }
  listForeignKeys(id: string, table: TableRef): Promise<ForeignKey[]> {
    return this.requireOpen(id).getForeignKeys(table);
  }

  analyzeSql(sql: string): StatementAnalysis[] {
    return analyzeBatch(sql);
  }

  /**
   * Run a batch, enforcing the guardian rules first:
   *  1. Read-only connections refuse write/DDL statements.
   *  2. Destructive statements (unguarded UPDATE/DELETE, TRUNCATE, DROP) require
   *     explicit confirmation unless `confirmDestructive` is set.
   */
  async runQuery(input: RunQueryInput): Promise<QueryResult> {
    const connection = this.requireOpen(input.connectionId);
    const config = this.openConfigs.get(input.connectionId);

    if (config?.readOnly) {
      const mutating = firstMutatingKind(input.sql);
      if (mutating) {
        throw new ReadOnlyViolationError(mutating.keyword);
      }
    }

    if (!input.confirmDestructive) {
      const needsConfirm = this.analyzeSql(input.sql).filter((a) => a.requiresConfirmation);
      if (needsConfirm.length > 0) {
        throw new ConfirmationRequiredError(needsConfirm);
      }
    }

    const controller = new AbortController();
    this.inflight.set(input.queryId, controller);
    try {
      return await connection.query(input.sql, {
        signal: controller.signal,
        maxRows: input.maxRows,
        timeoutMs: input.timeoutMs,
      });
    } finally {
      this.inflight.delete(input.queryId);
    }
  }

  async cancelQuery(_connectionId: string, queryId: string): Promise<void> {
    this.inflight.get(queryId)?.abort();
    this.inflight.delete(queryId);
  }

  /** Close every open connection — called on app shutdown. */
  async dispose(): Promise<void> {
    for (const controller of this.inflight.values()) controller.abort();
    this.inflight.clear();
    await Promise.all([...this.open.values()].map((c) => c.close().catch(() => undefined)));
    this.open.clear();
    this.openConfigs.clear();
  }

  private requireOpen(id: string): DriverConnection {
    const connection = this.open.get(id);
    if (!connection) {
      throw new ConnectionError(`Connection "${id}" is not open. Call openConnection first.`);
    }
    return connection;
  }
}

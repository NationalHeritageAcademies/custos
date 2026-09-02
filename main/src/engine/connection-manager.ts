import {
  ConfirmationRequiredError,
  ConnectionError,
  QueryError,
  ReadOnlyViolationError,
  analyzeBatch,
  firstMutatingKind,
  isInteractiveAuthDriver,
  type ColumnMeta,
  type ConnectionConfig,
  type ConnectionSecrets,
  type DatabaseDriver,
  type DriverConnection,
  type DriverRegistry,
  type ForeignKey,
  type QueryResult,
  type SignInPrompt,
  type SignInRequirement,
  type SignInState,
  type StatementAnalysis,
  type TableRef,
  type TestConnectionResult,
} from '@custos/core';
import type {
  DriverInfo,
  RunQueryInput,
  SaveConnectionInput,
  SignInInput,
  TestConnectionInput,
} from '@custos/shared';
import type { ConnectionStore, SecretStore } from './stores';

/** One interactive sign-in in progress (or its settled outcome). */
interface SignInFlow {
  state: SignInState;
  readonly controller: AbortController;
}

/**
 * Hosts Microsoft (and other identity providers) use for sign-in pages. Only
 * these are handed to the OS browser — see {@link ConnectionManager.openSignInPage}.
 */
const SIGN_IN_HOSTS = [
  'microsoft.com',
  'login.microsoftonline.com',
  'login.microsoftonline.us',
  'login.partner.microsoftonline.cn',
  'login.microsoft.com',
];

/** True for an https URL whose host is (or is under) an allowlisted sign-in host. */
export function isAllowedSignInUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  return SIGN_IN_HOSTS.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
}

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
 *  - Tracking interactive sign-in flows (Entra ID / MFA) on behalf of drivers.
 */
export class ConnectionManager {
  private readonly open = new Map<string, DriverConnection>();
  private readonly openConfigs = new Map<string, ConnectionConfig>();
  private readonly inflight = new Map<string, AbortController>();
  private readonly activeDatabase = new Map<string, string>();
  private readonly signInFlows = new Map<string, SignInFlow>();
  private signInCounter = 0;

  constructor(
    private readonly registry: DriverRegistry,
    private readonly connectionStore: ConnectionStore,
    private readonly secretStore: SecretStore,
    /**
     * How to open a URL in the user's browser. Electron passes
     * `shell.openExternal`; the web host leaves it out (it has no desktop
     * shell), and the UI then just shows the link for the user to open.
     */
    private readonly openExternal?: (url: string) => Promise<void>,
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

  // --- Interactive sign-in (Entra ID / MFA) ---

  /** Whether these connection params sign in interactively, and who is signed in. */
  signInStatus(input: SignInInput): SignInRequirement {
    const driver = this.registry.get(input.driverId);
    if (!isInteractiveAuthDriver(driver)) return { required: false, account: null };
    return driver.signInRequirement(input.params);
  }

  /**
   * Start an interactive sign-in and return as soon as there is something to
   * show the user — the device code, or the outcome if the flow finished that
   * fast. The flow keeps running in the background; the renderer follows it with
   * {@link pollSignIn}.
   */
  async beginSignIn(input: SignInInput): Promise<SignInState> {
    const driver = this.registry.get(input.driverId);
    if (!isInteractiveAuthDriver(driver)) {
      throw new ConnectionError(`The "${input.driverId}" driver has no interactive sign-in.`);
    }
    // "Switch account": drop the existing session first, or the provider signs
    // the same account straight back in without ever prompting.
    if (input.switchAccount) driver.forgetSignIn?.(input.params);
    // Settled flows are only kept until they are polled once more; clear them
    // out whenever a new sign-in starts so the map cannot grow unbounded.
    for (const [id, flow] of this.signInFlows) {
      if (flow.state.status !== 'pending') this.signInFlows.delete(id);
    }

    const flowId = `signin-${++this.signInCounter}`;
    const controller = new AbortController();
    const flow: SignInFlow = { state: { flowId, status: 'pending' }, controller };
    this.signInFlows.set(flowId, flow);

    let prompted!: () => void;
    const promptReady = new Promise<void>((resolve) => (prompted = resolve));
    const onPrompt = (prompt: SignInPrompt): void => {
      flow.state = { ...flow.state, prompt };
      prompted();
    };

    const settled = driver
      .signIn(input.params, onPrompt, controller.signal)
      .then((account) => {
        flow.state = { ...flow.state, status: 'complete', account };
      })
      .catch((err: unknown) => {
        flow.state = {
          ...flow.state,
          status: controller.signal.aborted ? 'cancelled' : 'failed',
          message: err instanceof Error ? err.message : String(err),
        };
      });

    await Promise.race([promptReady, settled]);
    return flow.state;
  }

  /** Current state of a sign-in flow. */
  pollSignIn(flowId: string): SignInState {
    const flow = this.signInFlows.get(flowId);
    if (!flow) {
      return { flowId, status: 'failed', message: 'That sign-in is no longer in progress.' };
    }
    if (flow.state.status !== 'pending') this.signInFlows.delete(flowId);
    return flow.state;
  }

  /** Abandon a sign-in the user backed out of. */
  cancelSignIn(flowId: string): void {
    const flow = this.signInFlows.get(flowId);
    if (!flow) return;
    flow.controller.abort();
    flow.state = { ...flow.state, status: 'cancelled' };
    this.signInFlows.delete(flowId);
  }

  /**
   * Open the sign-in page for a flow in the user's browser. The URL comes from
   * the identity provider rather than from the renderer, and it is checked
   * against a host allowlist before being handed to the OS — an untrusted URL
   * is never opened on the user's behalf. Returns false when this host cannot
   * open a browser (the web host), so the UI falls back to showing the link.
   */
  async openSignInPage(flowId: string): Promise<boolean> {
    const uri = this.signInFlows.get(flowId)?.state.prompt?.verificationUri;
    if (!uri || !this.openExternal) return false;
    if (!isAllowedSignInUrl(uri)) {
      throw new ConnectionError(`Refusing to open an unexpected sign-in URL: ${uri}`);
    }
    await this.openExternal(uri);
    return true;
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
    // Statement timeout: abort the in-flight query, which the driver cancels
    // server-side (KILL QUERY / request.cancel()).
    let timedOut = false;
    const timer =
      input.timeoutMs && input.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, input.timeoutMs)
        : undefined;
    try {
      return await connection.query(input.sql, {
        signal: controller.signal,
        maxRows: input.maxRows,
        timeoutMs: input.timeoutMs,
      });
    } catch (err) {
      if (timedOut) {
        throw new QueryError(`Statement cancelled: exceeded the ${input.timeoutMs}ms timeout.`, { cause: err });
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
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
    for (const flow of this.signInFlows.values()) flow.controller.abort();
    this.signInFlows.clear();
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

import { Injectable, computed, signal } from '@angular/core';
import type {
  ConnectionConfig,
  ConnectionField,
  ConnectionSecrets,
  DriverInfo,
  ResultSet,
  StatementAnalysis,
  TableRef,
} from '@custos/shared';
import {
  parseDataGripSources,
  toConnectionConfig,
  type ImportedConnection,
} from '@custos/core';
import { resolveBackend, isLiveBackend } from '../data/backend';

export type FieldValue = string | number | boolean;

export interface ConnectionDraft {
  driverId: string;
  name: string;
  readOnly: boolean;
  values: Record<string, FieldValue>;
}

export type TestStatus = 'idle' | 'testing' | 'ok' | 'error';

export type TreeKind = 'connection' | 'database' | 'schema' | 'table';

export interface TreeNode {
  readonly key: string;
  readonly kind: TreeKind;
  readonly label: string;
  readonly depth: number;
  readonly connectionId: string;
  readonly database?: string;
  readonly schema?: string;
  readonly table?: TableRef;
  readonly driverId?: string;
  readonly readOnly?: boolean;
  expanded: boolean;
  loading: boolean;
  loaded: boolean;
  children: TreeNode[];
}

const DEFAULT_SQL = `-- churn cohorts, last 6 months
WITH cohort AS (
  SELECT c.id, c.email, c.plan, c.mrr, c.region,
         DATEFROMPARTS(YEAR(c.created_at), MONTH(c.created_at), 1) AS cohort_month
  FROM dbo.customers c
  WHERE c.created_at >= DATEADD(MONTH, -6, SYSUTCDATETIME())
)
SELECT * FROM cohort
ORDER BY cohort_month DESC, mrr DESC;`;

let queryCounter = 0;

/**
 * The single source of truth for the workspace UI: connections, the lazily
 * loaded connection tree, the active editor SQL, and the current query result.
 * Components read these signals and call these actions; there is no other state.
 * Backed by {@link resolveBackend} (real Electron bridge or the in-browser demo).
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceStore {
  private readonly backend = resolveBackend();
  readonly live = isLiveBackend();

  readonly connections = signal<ConnectionConfig[]>([]);
  readonly tree = signal<TreeNode[]>([]);
  readonly activeConnectionId = signal<string | null>(null);

  readonly sql = signal<string>(DEFAULT_SQL);
  readonly running = signal(false);
  readonly result = signal<ResultSet | null>(null);
  readonly rowCount = signal<number | null>(null);
  readonly execMs = signal<number | null>(null);
  readonly rowsAffected = signal<number | null>(null);
  readonly error = signal<string | null>(null);

  /** Non-null while the guardian confirm dialog is open. */
  readonly confirm = signal<StatementAnalysis[] | null>(null);
  private pendingConfirmSql: string | null = null;

  // --- Connection form ---
  readonly drivers = signal<DriverInfo[]>([]);
  readonly formOpen = signal(false);
  readonly draft = signal<ConnectionDraft | null>(null);
  readonly testStatus = signal<TestStatus>('idle');
  readonly testMessage = signal<string>('');

  readonly currentDriver = computed<DriverInfo | null>(() => {
    const d = this.draft();
    return d ? this.drivers().find((x) => x.metadata.id === d.driverId) ?? null : null;
  });

  /** Fields to render for the current draft, honoring each field's `visibleWhen`. */
  readonly visibleFields = computed<ConnectionField[]>(() => {
    const driver = this.currentDriver();
    const d = this.draft();
    if (!driver || !d) return [];
    return driver.connectionFields.filter((f) => {
      if (!f.visibleWhen) return true;
      return String(d.values[f.visibleWhen.field] ?? '') === f.visibleWhen.equals;
    });
  });

  readonly activeConnection = computed(() =>
    this.connections().find((c) => c.id === this.activeConnectionId()) ?? null,
  );
  readonly fetched = computed(() => this.result()?.rows.length ?? 0);
  readonly truncated = computed(() => this.result()?.truncated ?? false);

  async init(): Promise<void> {
    this.drivers.set(await this.backend.listDrivers());
    const connections = await this.backend.listConnections();
    this.connections.set(connections);
    this.tree.set(connections.map((c, i) => this.connectionNode(c, i === 0)));
    const first = connections[0];
    if (first) {
      this.activeConnectionId.set(first.id);
      await this.toggle(this.tree()[0]!);
    }
  }

  private connectionNode(c: ConnectionConfig, expanded: boolean): TreeNode {
    return {
      key: `c:${c.id}`,
      kind: 'connection',
      label: c.name,
      depth: 0,
      connectionId: c.id,
      driverId: c.driverId,
      readOnly: c.readOnly,
      expanded: false,
      loading: false,
      loaded: false,
      children: [],
    };
  }

  /** Expand/collapse a tree node, lazily loading its children the first time. */
  async toggle(node: TreeNode): Promise<void> {
    if (node.kind === 'table') {
      this.useTable(node);
      return;
    }
    if (node.loaded) {
      node.expanded = !node.expanded;
      this.tree.set([...this.tree()]);
      return;
    }
    node.loading = true;
    this.tree.set([...this.tree()]);
    try {
      node.children = await this.loadChildren(node);
      node.loaded = true;
      node.expanded = true;
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      node.loading = false;
      this.tree.set([...this.tree()]);
    }
  }

  private async loadChildren(node: TreeNode): Promise<TreeNode[]> {
    if (node.kind === 'connection') {
      await this.backend.openConnection(node.connectionId);
      this.activeConnectionId.set(node.connectionId);
      const dbs = await this.backend.listDatabases(node.connectionId);
      return dbs.map((db) => ({
        key: `d:${node.connectionId}:${db}`,
        kind: 'database',
        label: db,
        depth: 1,
        connectionId: node.connectionId,
        database: db,
        expanded: false,
        loading: false,
        loaded: false,
        children: [],
      }));
    }
    if (node.kind === 'database') {
      const schemas = await this.backend.listSchemas(node.connectionId, node.database);
      if (schemas.length > 0) {
        return schemas.map((s) => ({
          key: `s:${node.connectionId}:${s}`,
          kind: 'schema',
          label: s,
          depth: 2,
          connectionId: node.connectionId,
          database: node.database,
          schema: s,
          expanded: false,
          loading: false,
          loaded: false,
          children: [],
        }));
      }
      return this.tableNodes(await this.backend.listTables(node.connectionId), node.connectionId, 2);
    }
    // schema
    const tables = await this.backend.listTables(node.connectionId, node.schema);
    return this.tableNodes(tables, node.connectionId, 3, node.schema);
  }

  private tableNodes(tables: TableRef[], connectionId: string, depth: number, schema?: string): TreeNode[] {
    return tables.map((t) => ({
      key: `t:${connectionId}:${schema ?? ''}:${t.name}`,
      kind: 'table',
      label: t.name,
      depth,
      connectionId,
      schema: t.schema ?? undefined,
      table: t,
      expanded: false,
      loading: false,
      loaded: true,
      children: [],
    }));
  }

  /** Clicking a table drops a SELECT into the editor and runs it. */
  private useTable(node: TreeNode): void {
    this.activeConnectionId.set(node.connectionId);
    const name = node.schema ? `${node.schema}.${node.table!.name}` : node.table!.name;
    this.sql.set(`SELECT * FROM ${name};`);
    void this.run();
  }

  /** Flatten the tree to the visible (expanded) nodes for rendering. */
  readonly visibleNodes = computed(() => {
    const out: TreeNode[] = [];
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        out.push(n);
        if (n.expanded && n.children.length) walk(n.children);
      }
    };
    walk(this.tree());
    return out;
  });

  async run(confirmDestructive = false): Promise<void> {
    const connectionId = this.activeConnectionId() ?? this.connections()[0]?.id;
    if (!connectionId) {
      this.error.set('No connection selected.');
      return;
    }
    this.running.set(true);
    this.error.set(null);
    try {
      await this.backend.openConnection(connectionId);
      const res = await this.backend.runQuery({
        connectionId,
        queryId: `q${++queryCounter}`,
        sql: this.sql(),
        maxRows: 200,
        confirmDestructive,
      });
      const first = res.resultSets[0] ?? null;
      this.result.set(first);
      this.rowCount.set(first ? first.rows.length : 0);
      this.execMs.set(res.executionMs);
      this.rowsAffected.set(res.rowsAffected);
      this.confirm.set(null);
      this.pendingConfirmSql = null;
    } catch (err) {
      const e = err as Error & { code?: string; analyses?: StatementAnalysis[] };
      if (e.code === 'CONFIRMATION_REQUIRED' && e.analyses) {
        this.pendingConfirmSql = this.sql();
        this.confirm.set(e.analyses);
      } else {
        this.error.set(e.message);
      }
    } finally {
      this.running.set(false);
    }
  }

  /** User accepted the guardian dialog — re-run with confirmation. */
  async confirmRun(): Promise<void> {
    if (this.pendingConfirmSql === null) return;
    await this.run(true);
  }

  cancelConfirm(): void {
    this.confirm.set(null);
    this.pendingConfirmSql = null;
  }

  // --- Connection form actions ---

  openConnectionForm(): void {
    const driver = this.drivers()[0];
    this.draft.set(this.blankDraft(driver?.metadata.id ?? 'mysql'));
    this.testStatus.set('idle');
    this.testMessage.set('');
    this.formOpen.set(true);
  }

  closeForm(): void {
    this.formOpen.set(false);
    this.draft.set(null);
  }

  selectDriver(driverId: string): void {
    if (this.draft()?.driverId === driverId) return;
    this.draft.set(this.blankDraft(driverId));
    this.testStatus.set('idle');
    this.testMessage.set('');
  }

  private blankDraft(driverId: string): ConnectionDraft {
    const driver = this.drivers().find((d) => d.metadata.id === driverId);
    const values: Record<string, FieldValue> = {};
    for (const f of driver?.connectionFields ?? []) {
      if (f.default !== undefined) values[f.key] = f.default;
      else values[f.key] = f.type === 'boolean' ? false : '';
    }
    return { driverId, name: this.draft()?.name ?? '', readOnly: driverId === 'azuresql', values };
  }

  setField(key: string, value: FieldValue): void {
    const d = this.draft();
    if (!d) return;
    this.draft.set({ ...d, values: { ...d.values, [key]: value } });
    this.testStatus.set('idle');
  }

  setName(name: string): void {
    const d = this.draft();
    if (d) this.draft.set({ ...d, name });
  }

  setReadOnly(readOnly: boolean): void {
    const d = this.draft();
    if (d) this.draft.set({ ...d, readOnly });
  }

  private splitValues(): { params: Record<string, FieldValue>; secrets: ConnectionSecrets } {
    const driver = this.currentDriver();
    const d = this.draft()!;
    const params: Record<string, FieldValue> = {};
    const secrets: Record<string, string> = {};
    for (const f of driver?.connectionFields ?? []) {
      const v = d.values[f.key];
      if (v === undefined || v === '') continue;
      if (f.secret) secrets[f.key] = String(v);
      else params[f.key] = v;
    }
    return { params, secrets };
  }

  async test(): Promise<void> {
    const d = this.draft();
    if (!d) return;
    this.testStatus.set('testing');
    this.testMessage.set(`Handshake with ${d.values['server'] ?? d.values['host'] ?? 'server'}…`);
    try {
      const { params, secrets } = this.splitValues();
      const res = await this.backend.testConnection({ driverId: d.driverId, params, secrets, readOnly: d.readOnly });
      if (res.ok) {
        this.testStatus.set('ok');
        const version = res.serverVersion ? ` · ${res.serverVersion}` : '';
        const latency = res.latencyMs != null ? ` · ${res.latencyMs} ms` : '';
        this.testMessage.set(`${res.message}${version}${latency}`);
      } else {
        this.testStatus.set('error');
        this.testMessage.set(res.message);
      }
    } catch (err) {
      this.testStatus.set('error');
      this.testMessage.set(err instanceof Error ? err.message : String(err));
    }
  }

  // --- DataGrip import ---
  readonly importOpen = signal(false);
  readonly importList = signal<ImportedConnection[]>([]);
  readonly importError = signal<string>('');

  openImport(): void {
    this.importList.set([]);
    this.importError.set('');
    this.importOpen.set(true);
  }

  closeImport(): void {
    this.importOpen.set(false);
  }

  /** Parse a pasted/loaded dataSources.xml into a preview list. */
  parseImportXml(xml: string): void {
    try {
      this.importList.set(parseDataGripSources(xml));
      this.importError.set(this.importList().length ? '' : 'No <data-source> entries found in that file.');
    } catch (err) {
      this.importError.set(err instanceof Error ? err.message : String(err));
      this.importList.set([]);
    }
  }

  /** Persist every supported imported connection; returns how many were added. */
  async importSupported(): Promise<number> {
    let added = 0;
    for (const imported of this.importList()) {
      const id = globalThis.crypto?.randomUUID?.() ?? `c${Date.now()}-${added}`;
      const config = toConnectionConfig(imported, id);
      if (!config) continue;
      await this.backend.saveConnection({ config, secrets: {} });
      this.tree.set([...this.tree(), this.connectionNode(config, false)]);
      added++;
    }
    if (added > 0) this.connections.set(await this.backend.listConnections());
    this.closeImport();
    return added;
  }

  async save(): Promise<void> {
    const d = this.draft();
    if (!d) return;
    const { params, secrets } = this.splitValues();
    const id = globalThis.crypto?.randomUUID?.() ?? `c${Date.now()}`;
    const fallbackName = String(params['database'] ?? params['host'] ?? params['server'] ?? 'connection');
    const config: ConnectionConfig = {
      id,
      name: d.name || fallbackName,
      driverId: d.driverId,
      readOnly: d.readOnly,
      params,
    };
    await this.backend.saveConnection({ config, secrets });
    this.connections.set(await this.backend.listConnections());
    this.tree.set([...this.tree(), this.connectionNode(config, false)]);
    this.activeConnectionId.set(id);
    this.closeForm();
  }
}

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

/** One editor tab: its own SQL and its own result sets. */
export interface QueryTab {
  id: string;
  title: string;
  sql: string;
  resultSets: ResultSet[];
  activeResultIndex: number;
  execMs: number | null;
  rowsAffected: number | null;
  error: string | null;
  dirty: boolean;
}

/** One entry in the query history. */
export interface HistoryEntry {
  id: string;
  sql: string;
  connectionId: string | null;
  connectionName: string;
  database: string | null;
  at: number;
  ok: boolean;
  rowCount: number | null;
  execMs: number | null;
}

function makeTab(title: string, sql = ''): QueryTab {
  const id = globalThis.crypto?.randomUUID?.() ?? `t${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  return { id, title, sql, resultSets: [], activeResultIndex: 0, execMs: null, rowsAffected: null, error: null, dirty: false };
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
  /** The database queries currently run against (server-side USE), if chosen. */
  readonly activeDatabase = signal<string | null>(null);

  // --- Editor tabs (each with its own SQL + results) ---
  readonly tabs = signal<QueryTab[]>([makeTab('churn_cohorts.sql', DEFAULT_SQL)]);
  readonly activeTabId = signal<string>(this.tabs()[0]!.id);
  readonly activeTab = computed<QueryTab>(
    () => this.tabs().find((t) => t.id === this.activeTabId()) ?? this.tabs()[0]!,
  );

  readonly running = signal(false);
  /** The in-flight query, so Cancel can abort it. */
  private readonly currentQuery = signal<{ connectionId: string; queryId: string } | null>(null);
  /** Text currently selected in the editor (for Run selection). */
  readonly selectionText = signal<string>('');
  /** Caret position in the editor (1-based), shown in the status bar. */
  readonly cursor = signal<{ line: number; column: number }>({ line: 1, column: 1 });
  // These read the ACTIVE tab, so existing templates (ws.sql(), ws.result(), …)
  // keep working unchanged while each tab holds its own state.
  readonly sql = computed(() => this.activeTab().sql);
  readonly resultSets = computed(() => this.activeTab().resultSets);
  readonly activeResultIndex = computed(() => this.activeTab().activeResultIndex);
  readonly result = computed<ResultSet | null>(
    () => this.activeTab().resultSets[this.activeTab().activeResultIndex] ?? null,
  );
  readonly rowCount = computed(() => this.result()?.rows.length ?? 0);
  readonly execMs = computed(() => this.activeTab().execMs);
  readonly rowsAffected = computed(() => this.activeTab().rowsAffected);
  readonly error = computed(() => this.activeTab().error);

  selectResult(index: number): void {
    this.patchActiveTab({ activeResultIndex: index });
    this.resetGridView();
  }

  // --- Results grid view state (filter + sort) ---
  readonly gridFilter = signal('');
  readonly gridSort = signal<{ col: number; dir: 'asc' | 'desc' } | null>(null);

  private resetGridView(): void {
    this.gridFilter.set('');
    this.gridSort.set(null);
  }

  setGridFilter(value: string): void {
    this.gridFilter.set(value);
  }

  toggleSort(col: number): void {
    const s = this.gridSort();
    if (!s || s.col !== col) this.gridSort.set({ col, dir: 'asc' });
    else if (s.dir === 'asc') this.gridSort.set({ col, dir: 'desc' });
    else this.gridSort.set(null);
  }

  /** Rows of the active result set with the grid filter + sort applied. */
  readonly displayedRows = computed(() => {
    const rs = this.result();
    if (!rs) return [];
    let rows = rs.rows;
    const f = this.gridFilter().toLowerCase().trim();
    if (f) {
      rows = rows.filter((r) => r.some((c) => c !== null && String(c).toLowerCase().includes(f)));
    }
    const sort = this.gridSort();
    if (sort) {
      rows = [...rows].sort((a, b) => {
        const av = a[sort.col];
        const bv = b[sort.col];
        if (av === bv) return 0;
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        const cmp =
          typeof av === 'number' && typeof bv === 'number'
            ? av - bv
            : String(av).localeCompare(String(bv), undefined, { numeric: true });
        return sort.dir === 'asc' ? cmp : -cmp;
      });
    }
    return rows;
  });

  /** The active result set as CSV (the currently displayed rows). */
  toCsv(): string {
    const rs = this.result();
    if (!rs) return '';
    const esc = (v: unknown): string => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = rs.columns.map((c) => esc(c.name)).join(',');
    const lines = this.displayedRows().map((r) => r.map(esc).join(','));
    return [header, ...lines].join('\n');
  }

  private patchActiveTab(patch: Partial<QueryTab>): void {
    const id = this.activeTabId();
    this.tabs.set(this.tabs().map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }

  setSql(value: string): void {
    this.patchActiveTab({ sql: value, dirty: true });
  }

  newTab(): void {
    const tab = makeTab(`query ${this.tabs().length + 1}`);
    this.tabs.set([...this.tabs(), tab]);
    this.activeTabId.set(tab.id);
  }

  selectTab(id: string): void {
    this.activeTabId.set(id);
  }

  closeTab(id: string): void {
    const tabs = this.tabs();
    if (tabs.length <= 1) {
      // Never leave zero tabs — reset the last one instead.
      const fresh = makeTab('query 1');
      this.tabs.set([fresh]);
      this.activeTabId.set(fresh.id);
      return;
    }
    const idx = tabs.findIndex((t) => t.id === id);
    const remaining = tabs.filter((t) => t.id !== id);
    this.tabs.set(remaining);
    if (this.activeTabId() === id) {
      this.activeTabId.set((remaining[Math.max(0, idx - 1)] ?? remaining[0]!).id);
    }
  }

  // --- Query history ---
  readonly history = signal<HistoryEntry[]>([]);
  readonly historyOpen = signal(false);

  toggleHistory(): void {
    this.historyOpen.set(!this.historyOpen());
  }
  closeHistory(): void {
    this.historyOpen.set(false);
  }

  private pushHistory(entry: HistoryEntry): void {
    this.history.set([entry, ...this.history()].slice(0, 200));
  }

  /** Open a past query in a new tab. */
  openHistoryEntry(entry: HistoryEntry): void {
    const tab = makeTab('history', entry.sql);
    this.tabs.set([...this.tabs(), tab]);
    this.activeTabId.set(tab.id);
    this.historyOpen.set(false);
  }

  // --- Settings ---
  readonly settingsOpen = signal(false);
  /** Max rows fetched per query (the run cap). */
  readonly rowLimit = signal(1000);
  /** Statement timeout in seconds; 0 = no timeout. */
  readonly statementTimeout = signal(30);

  openSettings(): void {
    this.settingsOpen.set(true);
  }
  closeSettings(): void {
    this.settingsOpen.set(false);
  }
  setRowLimit(n: number): void {
    this.rowLimit.set(Math.max(1, Math.min(100_000, Math.floor(n) || 1000)));
  }
  setStatementTimeout(seconds: number): void {
    this.statementTimeout.set(Math.max(0, Math.min(3600, Math.floor(seconds) || 0)));
  }
  clearHistory(): void {
    this.history.set([]);
  }

  /** Non-null while the guardian confirm dialog is open. */
  readonly confirm = signal<StatementAnalysis[] | null>(null);
  private pendingConfirmSql: string | null = null;

  // --- Connection form ---
  readonly drivers = signal<DriverInfo[]>([]);
  readonly formOpen = signal(false);
  /** Non-null when the form is editing an existing connection (its id). */
  readonly editingId = signal<string | null>(null);
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
      const current = String(d.values[f.visibleWhen.field] ?? '');
      return 'in' in f.visibleWhen
        ? f.visibleWhen.in.includes(current)
        : current === f.visibleWhen.equals;
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

  /** Switch the connection's current database for subsequent queries. */
  async setActive(connectionId: string, database: string): Promise<void> {
    this.activeConnectionId.set(connectionId);
    try {
      await this.backend.setActiveDatabase(connectionId, database);
      this.activeDatabase.set(database);
    } catch (err) {
      this.patchActiveTab({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Expand/collapse a tree node, lazily loading its children the first time. */
  async toggle(node: TreeNode): Promise<void> {
    if (node.kind === 'table') {
      await this.useTable(node);
      return;
    }
    // Selecting a database makes it the active query target.
    if (node.kind === 'database' && node.database) {
      void this.setActive(node.connectionId, node.database);
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
      this.patchActiveTab({ error: err instanceof Error ? err.message : String(err) });
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
          key: `s:${node.connectionId}:${node.database}:${s}`,
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
      return this.tableNodes(
        await this.backend.listTables(node.connectionId, node.database),
        node.connectionId,
        2,
      );
    }
    // schema
    const tables = await this.backend.listTables(node.connectionId, node.database, node.schema);
    return this.tableNodes(tables, node.connectionId, 3);
  }

  private tableNodes(tables: TableRef[], connectionId: string, depth: number): TreeNode[] {
    return tables.map((t) => ({
      key: `t:${connectionId}:${t.database ?? ''}:${t.schema ?? ''}:${t.name}`,
      kind: 'table',
      label: t.name,
      depth,
      connectionId,
      database: t.database ?? undefined,
      schema: t.schema ?? undefined,
      table: t,
      expanded: false,
      loading: false,
      loaded: true,
      children: [],
    }));
  }

  /** Clicking a table selects its database, drops a SELECT in, and runs it. */
  private async useTable(node: TreeNode): Promise<void> {
    if (node.database) await this.setActive(node.connectionId, node.database);
    else this.activeConnectionId.set(node.connectionId);
    const name = node.schema ? `${node.schema}.${node.table!.name}` : node.table!.name;
    this.setSql(`SELECT * FROM ${name};`);
    void this.run();
  }

  /** Loaded table names across the tree — feeds editor autocomplete. */
  readonly tableNames = computed<string[]>(() => {
    const names = new Set<string>();
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        if (n.kind === 'table') names.add(n.label);
        if (n.children.length) walk(n.children);
      }
    };
    walk(this.tree());
    return [...names];
  });

  /** Sidebar tree filter text. */
  readonly treeFilter = signal('');
  setTreeFilter(value: string): void {
    this.treeFilter.set(value);
  }

  /** Flatten the tree for rendering — expanded nodes, or matches when filtering. */
  readonly visibleNodes = computed(() => {
    const f = this.treeFilter().toLowerCase().trim();
    if (f) {
      // Include a node if it (or a loaded descendant) matches; show the matches.
      const filter = (nodes: TreeNode[]): TreeNode[] => {
        const out: TreeNode[] = [];
        for (const n of nodes) {
          const childOut = filter(n.children);
          if (n.label.toLowerCase().includes(f) || childOut.length) {
            out.push(n, ...childOut);
          }
        }
        return out;
      };
      return filter(this.tree());
    }
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

  /** Run the current editor selection if there is one, else the whole tab. */
  runSelection(): Promise<void> {
    const sel = this.selectionText().trim();
    return this.run({ sql: sel || undefined });
  }

  /** Cancel the in-flight query, if any. */
  async cancel(): Promise<void> {
    const q = this.currentQuery();
    if (q) await this.backend.cancelQuery(q.connectionId, q.queryId);
  }

  async run(opts: { confirmDestructive?: boolean; sql?: string } = {}): Promise<void> {
    const connectionId = this.activeConnectionId() ?? this.connections()[0]?.id;
    if (!connectionId) {
      this.patchActiveTab({ error: 'No connection selected.' });
      return;
    }
    const sql = opts.sql ?? this.sql();
    const queryId = `q${++queryCounter}`;
    this.running.set(true);
    this.currentQuery.set({ connectionId, queryId });
    this.patchActiveTab({ error: null });
    try {
      await this.backend.openConnection(connectionId);
      const res = await this.backend.runQuery({
        connectionId,
        queryId,
        sql,
        maxRows: this.rowLimit(),
        timeoutMs: this.statementTimeout() > 0 ? this.statementTimeout() * 1000 : undefined,
        confirmDestructive: opts.confirmDestructive,
      });
      this.patchActiveTab({
        resultSets: res.resultSets,
        activeResultIndex: 0,
        execMs: res.executionMs,
        rowsAffected: res.rowsAffected,
        error: null,
        dirty: false,
      });
      this.resetGridView();
      this.confirm.set(null);
      this.pendingConfirmSql = null;
      this.pushHistory({
        id: queryId, sql, connectionId,
        connectionName: this.activeConnection()?.name ?? connectionId,
        database: this.activeDatabase(), at: Date.now(), ok: true,
        rowCount: res.resultSets[0]?.rows.length ?? 0, execMs: res.executionMs,
      });
    } catch (err) {
      const e = err as Error & { code?: string; analyses?: StatementAnalysis[] };
      if (e.code === 'CONFIRMATION_REQUIRED' && e.analyses) {
        this.pendingConfirmSql = sql;
        this.confirm.set(e.analyses);
      } else {
        this.patchActiveTab({ error: e.message });
        this.pushHistory({
          id: queryId, sql, connectionId,
          connectionName: this.activeConnection()?.name ?? connectionId,
          database: this.activeDatabase(), at: Date.now(), ok: false,
          rowCount: null, execMs: null,
        });
      }
    } finally {
      this.running.set(false);
      this.currentQuery.set(null);
    }
  }

  /** User accepted the guardian dialog — re-run with confirmation. */
  async confirmRun(): Promise<void> {
    if (this.pendingConfirmSql === null) return;
    await this.run({ confirmDestructive: true, sql: this.pendingConfirmSql });
  }

  cancelConfirm(): void {
    this.confirm.set(null);
    this.pendingConfirmSql = null;
  }

  // --- Connection form actions ---

  /** Open the form to create a new connection, or (with an id) edit an existing one. */
  openConnectionForm(editId?: string): void {
    this.testStatus.set('idle');
    this.testMessage.set('');
    if (editId) {
      const config = this.connections().find((c) => c.id === editId);
      if (config) {
        // Start from the driver's defaults, then overlay the saved params.
        const base = this.blankDraft(config.driverId);
        this.draft.set({
          driverId: config.driverId,
          name: config.name,
          readOnly: config.readOnly,
          values: { ...base.values, ...config.params },
        });
        this.editingId.set(editId);
        this.formOpen.set(true);
        return;
      }
    }
    this.editingId.set(null);
    const driver = this.drivers()[0];
    this.draft.set(this.blankDraft(driver?.metadata.id ?? 'mysql'));
    this.formOpen.set(true);
  }

  closeForm(): void {
    this.formOpen.set(false);
    this.draft.set(null);
    this.editingId.set(null);
  }

  async deleteConnection(id: string): Promise<void> {
    await this.backend.deleteConnection(id);
    this.connections.set(await this.backend.listConnections());
    this.tree.set(this.tree().filter((n) => n.connectionId !== id));
    if (this.activeConnectionId() === id) {
      this.activeConnectionId.set(null);
      this.activeDatabase.set(null);
    }
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
    const editing = this.editingId();
    const id = editing ?? globalThis.crypto?.randomUUID?.() ?? `c${Date.now()}`;
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
    if (editing) {
      // Replace the existing tree node so it reconnects with the new config.
      this.tree.set(this.tree().map((n) => (n.connectionId === id ? this.connectionNode(config, false) : n)));
    } else {
      this.tree.set([...this.tree(), this.connectionNode(config, false)]);
    }
    this.activeConnectionId.set(id);
    this.closeForm();
  }
}

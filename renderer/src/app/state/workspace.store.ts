import { Injectable, computed, signal } from '@angular/core';
import type {
  ConnectionConfig,
  ResultSet,
  StatementAnalysis,
  TableRef,
} from '@custos/shared';
import { resolveBackend, isLiveBackend } from '../data/backend';

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

  readonly activeConnection = computed(() =>
    this.connections().find((c) => c.id === this.activeConnectionId()) ?? null,
  );
  readonly fetched = computed(() => this.result()?.rows.length ?? 0);
  readonly truncated = computed(() => this.result()?.truncated ?? false);

  async init(): Promise<void> {
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
}

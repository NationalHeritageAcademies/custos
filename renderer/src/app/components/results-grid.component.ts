import { Component, computed, effect, inject, signal } from '@angular/core';
import { ScrollingModule } from '@angular/cdk/scrolling';
import type { ColumnMeta, SqlValue } from '@custos/shared';
import { WorkspaceStore } from '../state/workspace.store';

const NUMERIC = new Set(['int', 'bigint', 'smallint', 'tinyint', 'decimal', 'float', 'double', 'numeric', 'money', 'real']);
const ROW_H = 30;

/**
 * The results grid. A virtualized div-grid (CDK virtual scroll) so it stays
 * smooth at 10k+ rows, rendering the active result set with the grid filter and
 * sort applied. Header and rows share one column template; the whole thing
 * scrolls horizontally for wide tables.
 */
@Component({
  selector: 'app-results-grid',
  standalone: true,
  imports: [ScrollingModule],
  template: `
    @if (ws.error()) {
      <div class="empty error">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>
        <span>{{ ws.error() }}</span>
      </div>
    } @else if (ws.result()) {
      @if (ws.result(); as rs) {
        @if (rs.columns.length === 0) {
          <div class="empty">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2.2"><path d="m5 13 4 4 10-10"/></svg>
            <span>Statement executed{{ ws.rowsAffected() !== null ? ' · ' + ws.rowsAffected() + ' rows affected' : '' }}.</span>
          </div>
        } @else {
          <div class="hscroll selectable">
            <div class="inner" [style.min-width.px]="minWidth()">
              <div class="header" [style.grid-template-columns]="template()">
                <div class="cell hcell gutter">#</div>
                @for (col of rs.columns; track $index; let ci = $index) {
                  <div class="cell hcell sortable" [class.num]="isNumeric(col.dataType)" (click)="ws.toggleSort(ci)">
                    <span class="hname">{{ col.name }}
                      @if (ws.gridSort()?.col === ci) { <span class="arrow">{{ ws.gridSort()?.dir === 'asc' ? '▲' : '▼' }}</span> }
                    </span>
                    <span class="type">{{ col.dataType }}</span>
                    <span class="resize" title="Drag to resize" (mousedown)="startResize($event, ci)" (click)="$event.stopPropagation()"></span>
                  </div>
                }
              </div>

              <cdk-virtual-scroll-viewport [itemSize]="rowH" class="body">
                <div class="vrow" *cdkVirtualFor="let row of ws.displayedRows(); let i = index" [style.grid-template-columns]="template()" [class.zebra]="i % 2 === 1">
                  <div class="cell gutter">{{ i + 1 }}</div>
                  @for (cell of row; track $index) {
                    <div class="cell" [class.num]="isNumeric(rs.columns[$index]?.dataType)">
                      @if (cell === null) { <span class="null">NULL</span> } @else { {{ format(cell) }} }
                    </div>
                  }
                </div>
              </cdk-virtual-scroll-viewport>
            </div>
          </div>
        }
      }
    } @else {
      <div class="empty muted"><span>Run a query to see results.</span></div>
    }
  `,
  styles: [`
    :host { flex: 1; min-height: 0; display: flex; flex-direction: column; background: var(--bg); overflow: hidden; }
    .hscroll { flex: 1; min-height: 0; overflow-x: auto; overflow-y: hidden; display: flex; }
    .inner { flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .header { display: grid; flex: none; background: var(--grid-header-bg); border-bottom: 1px solid var(--border-strong); }
    .body { flex: 1; min-height: 0; }
    .vrow { display: grid; height: ${ROW_H}px; }
    .vrow.zebra .cell { background: var(--grid-row-alt); }
    .vrow:hover .cell { background: var(--grid-selection); }
    .cell { padding: 0 10px; display: flex; align-items: center; border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); font: 400 12px/1 var(--font-mono); color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .cell.num { justify-content: flex-end; }
    .hcell { position: relative; font: 600 11px/1 var(--font-ui); color: var(--text-2); flex-direction: column; align-items: flex-start; justify-content: center; gap: 3px; border-bottom: 0; }
    .resize { position: absolute; top: 0; right: -3px; width: 7px; height: 100%; cursor: col-resize; z-index: 2; }
    .resize:hover { background: color-mix(in srgb, var(--accent) 40%, transparent); }
    .hcell.num { align-items: flex-end; }
    .hcell.sortable { cursor: pointer; user-select: none; }
    .hcell.sortable:hover { color: var(--text); }
    .hname { display: inline-flex; align-items: center; gap: 4px; }
    .arrow { font-size: 8px; color: var(--accent); }
    .type { font: 400 9.5px/1 var(--font-mono); color: var(--text-3); }
    .gutter { color: var(--text-3); justify-content: flex-end; padding-right: 8px; }
    .null { font: 500 10.5px/1 var(--font-mono); letter-spacing: .04em; color: var(--grid-null); padding: 1px 5px; border: 1px dashed var(--border-strong); border-radius: 3px; }
    .empty { flex: 1; display: flex; align-items: center; justify-content: center; gap: 9px; font: var(--text-body); color: var(--text-2); }
    .empty.muted { color: var(--text-3); }
    .empty.error { color: var(--danger); }
  `],
})
export class ResultsGridComponent {
  readonly ws = inject(WorkspaceStore);
  readonly rowH = ROW_H;
  /** Per-column width overrides (from dragging); cleared when the result changes. */
  private readonly overrides = signal<Record<number, number>>({});

  constructor() {
    // Reset any manual widths when a new result set arrives.
    effect(() => {
      this.ws.result();
      this.overrides.set({});
    }, { allowSignalWrites: true });
  }

  private defaultWidth(col: ColumnMeta): number {
    return this.isNumeric(col.dataType) ? 120 : 180;
  }
  private widthOf(index: number, col: ColumnMeta): number {
    return this.overrides()[index] ?? this.defaultWidth(col);
  }

  readonly template = computed(() => {
    const cols = this.ws.result()?.columns ?? [];
    return `52px ${cols.map((c, i) => `${this.widthOf(i, c)}px`).join(' ')}`;
  });
  readonly minWidth = computed(() => {
    const cols = this.ws.result()?.columns ?? [];
    return 52 + cols.reduce((sum, c, i) => sum + this.widthOf(i, c), 0);
  });

  startResize(event: MouseEvent, index: number): void {
    event.preventDefault();
    event.stopPropagation();
    const col = this.ws.result()?.columns[index];
    if (!col) return;
    const startX = event.clientX;
    const startW = this.widthOf(index, col);
    const move = (ev: MouseEvent) => {
      const w = Math.max(60, Math.round(startW + (ev.clientX - startX)));
      this.overrides.set({ ...this.overrides(), [index]: w });
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'col-resize';
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  isNumeric(dataType?: string): boolean {
    return !!dataType && NUMERIC.has(dataType.toLowerCase());
  }
  format(value: Exclude<SqlValue, null>): string {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }
  columnAt(index: number): ColumnMeta | undefined {
    return this.ws.result()?.columns[index];
  }
}

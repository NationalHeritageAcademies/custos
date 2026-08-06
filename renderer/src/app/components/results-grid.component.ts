import { Component, computed, inject } from '@angular/core';
import type { SqlValue } from '@custos/shared';
import { WorkspaceStore } from '../state/workspace.store';

const NUMERIC = new Set(['int', 'bigint', 'smallint', 'tinyint', 'decimal', 'float', 'double', 'numeric', 'money', 'real']);

/**
 * The results grid, rendered from {@link WorkspaceStore.result}. Renders columns
 * with a leading row-number gutter, zebra striping, right-aligned numeric
 * columns, and a distinct NULL badge. Row rendering is capped at the fetched
 * page (maxRows); true virtualization is tracked in the execution plan.
 */
@Component({
  selector: 'app-results-grid',
  standalone: true,
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
        <div class="scroll selectable">
          <table>
            <thead>
              <tr>
                <th class="num gutter">#</th>
                @for (col of rs.columns; track $index; let ci = $index) {
                  <th class="sortable" [class.num]="isNumeric(col.dataType)" (click)="ws.toggleSort(ci)">
                    <span class="hname">{{ col.name }}
                      @if (ws.gridSort()?.col === ci) {
                        <span class="arrow">{{ ws.gridSort()?.dir === 'asc' ? '▲' : '▼' }}</span>
                      }
                    </span>
                    <span class="type">{{ col.dataType }}</span>
                  </th>
                }
              </tr>
            </thead>
            <tbody>
              @for (row of ws.displayedRows(); track $index; let i = $index) {
                <tr [class.zebra]="i % 2 === 1">
                  <td class="num gutter">{{ i + 1 }}</td>
                  @for (cell of row; track $index) {
                    <td [class.num]="isNumeric(rs.columns[$index]?.dataType)">
                      @if (cell === null) {
                        <span class="null">NULL</span>
                      } @else {
                        {{ format(cell) }}
                      }
                    </td>
                  }
                </tr>
              } @empty {
                <tr><td class="norows" [attr.colspan]="rs.columns.length + 1">No rows match the filter.</td></tr>
              }
            </tbody>
          </table>
        </div>
      }
      }
    } @else {
      <div class="empty muted">
        <span>Run a query to see results.</span>
      </div>
    }
  `,
  styles: [`
    :host { flex: 1; min-height: 0; display: flex; flex-direction: column; background: var(--bg); overflow: hidden; }
    .scroll { flex: 1; overflow: auto; }
    table { border-collapse: collapse; width: max-content; min-width: 100%; font: var(--text-body); font-family: var(--font-mono); }
    thead th { position: sticky; top: 0; z-index: 1; background: var(--grid-header-bg); color: var(--text-2); font: 600 11px/1 var(--font-ui); text-align: left; padding: 8px 10px; border-right: 1px solid var(--border); border-bottom: 1px solid var(--border-strong); white-space: nowrap; }
    thead th.num { text-align: right; }
    thead th.sortable { cursor: pointer; user-select: none; }
    thead th.sortable:hover { color: var(--text); }
    .hname { display: inline-flex; align-items: center; gap: 4px; }
    .arrow { font-size: 8px; color: var(--accent); }
    .norows { padding: 16px 12px; text-align: center; color: var(--text-3); font-family: var(--font-ui); }
    thead .type { display: block; font: 400 9.5px/1 var(--font-mono); color: var(--text-3); margin-top: 3px; font-weight: 400; }
    tbody td { padding: 7px 10px; border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); color: var(--text); white-space: nowrap; }
    tbody td.num { text-align: right; }
    tbody tr.zebra td { background: var(--grid-row-alt); }
    tbody tr:hover td { background: var(--grid-selection); }
    .gutter { color: var(--text-3); text-align: right; }
    .null { font: 500 10.5px/1 var(--font-mono); letter-spacing: .04em; color: var(--grid-null); padding: 1px 5px; border: 1px dashed var(--border-strong); border-radius: 3px; }
    .empty { flex: 1; display: flex; align-items: center; justify-content: center; gap: 9px; font: var(--text-body); color: var(--text-2); }
    .empty.muted { color: var(--text-3); }
    .empty.error { color: var(--danger); }
  `],
})
export class ResultsGridComponent {
  readonly ws = inject(WorkspaceStore);

  isNumeric(dataType?: string): boolean {
    return !!dataType && NUMERIC.has(dataType.toLowerCase());
  }

  format(value: Exclude<SqlValue, null>): string {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }
}

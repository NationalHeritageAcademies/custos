import { Component, inject } from '@angular/core';
import { WorkspaceStore, type TreeNode } from '../state/workspace.store';

/**
 * The sidebar connection tree, rendered from {@link WorkspaceStore.visibleNodes}.
 * Nodes lazily load their children on expand; clicking a table runs a SELECT.
 */
@Component({
  selector: 'app-connection-tree',
  standalone: true,
  template: `
    <div class="tree">
      @for (node of ws.visibleNodes(); track node.key) {
        <div
          class="row"
          [class.active]="node.kind === 'table' && ws.sql().includes(node.label)"
          [style.padding-left.px]="6 + node.depth * 16"
          (click)="ws.toggle(node)"
        >
          @if (node.kind !== 'table') {
            <svg class="chev" [class.open]="node.expanded" width="9" height="9" viewBox="0 0 12 12">
              <path d="M4 2v8l5-4Z" fill="var(--text-3)" />
            </svg>
          } @else {
            <span class="chev-spacer"></span>
          }

          @switch (node.kind) {
            @case ('connection') {
              <span class="badge" [style.background]="engineColor(node.driverId)">{{ engineTag(node.driverId) }}</span>
            }
            @case ('database') {
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-2)" stroke-width="1.7"><ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/></svg>
            }
            @case ('schema') {
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-2)" stroke-width="1.7"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h4l2 2.5h7A2 2 0 0 1 20.5 9.5v8A2 2 0 0 1 18.5 19.5h-13A2.5 2.5 0 0 1 3 17Z"/></svg>
            }
            @case ('table') {
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" [attr.stroke]="isActive(node) ? 'var(--accent-hover)' : 'var(--text-2)'" stroke-width="1.8"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M9 9.5v10"/></svg>
            }
          }

          <span class="label" [class.strong]="node.kind === 'connection'">{{ node.label }}</span>

          @if (node.kind === 'connection' && node.readOnly) {
            <span class="ro">
              <svg width="9" height="9" viewBox="0 0 48 48" fill="var(--accent)"><path d="M24 4 39 9.4v12.4c0 10.2-6.6 16.6-15 19.8-8.4-3.2-15-9.6-15-19.8V9.4L24 4Z"/></svg>RO
            </span>
          }
          @if (node.kind === 'connection') {
            <span class="actions">
              <button class="act" title="Edit connection" (click)="edit($event, node)">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
              </button>
              <button class="act" title="Delete connection" (click)="remove($event, node)">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>
              </button>
            </span>
          }
          @if (node.loading) { <span class="spin"></span> }
        </div>
      }
    </div>
  `,
  styles: [`
    :host { flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .tree { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 0 6px 8px; display: flex; flex-direction: column; gap: 1px; font: var(--text-meta); }
    .row { display: flex; align-items: center; gap: 7px; height: 27px; padding-right: 8px; border-radius: 6px; cursor: pointer; color: var(--text); white-space: nowrap; }
    .row:hover { background: var(--surface-2); }
    .row.active { background: var(--accent-subtle); box-shadow: inset 2px 0 0 var(--accent); }
    .row.active .label { color: var(--accent-hover); font-weight: 600; }
    .chev { flex: none; transition: transform .12s ease; }
    .chev.open { transform: rotate(90deg); }
    .chev-spacer { width: 9px; flex: none; }
    .badge { display: flex; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 4px; font: 700 8px/1 var(--font-ui); color: #fff; flex: none; }
    .label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .label.strong { font-weight: 600; }
    .ro { display: inline-flex; align-items: center; gap: 3px; padding: 1px 5px 1px 4px; border-radius: 4px; background: var(--accent-subtle); border: 1px solid color-mix(in srgb, var(--accent) 20%, transparent); font: 600 9px/1.4 var(--font-ui); letter-spacing: .04em; color: var(--accent-hover); }
    .actions { display: none; align-items: center; gap: 1px; }
    .row:hover .actions { display: flex; }
    .act { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--text-3); cursor: pointer; }
    .act:hover { background: var(--bg); color: var(--text); }
    .spin { width: 9px; height: 9px; margin-left: auto; border-radius: 50%; border: 1.5px solid var(--warning); border-top-color: transparent; animation: s .7s linear infinite; }
    @keyframes s { to { transform: rotate(360deg); } }
  `],
})
export class ConnectionTreeComponent {
  readonly ws = inject(WorkspaceStore);

  isActive(node: TreeNode): boolean {
    return node.kind === 'table' && this.ws.sql().includes(node.label);
  }
  engineTag(driverId?: string): string {
    return driverId === 'mysql' ? 'MY' : 'AZ';
  }
  engineColor(driverId?: string): string {
    return driverId === 'mysql' ? '#C98A2E' : '#2E8FD9';
  }

  edit(event: Event, node: TreeNode): void {
    event.stopPropagation();
    this.ws.openConnectionForm(node.connectionId);
  }

  remove(event: Event, node: TreeNode): void {
    event.stopPropagation();
    if (confirm(`Delete connection "${node.label}"? This removes its saved settings from Custos.`)) {
      void this.ws.deleteConnection(node.connectionId);
    }
  }
}

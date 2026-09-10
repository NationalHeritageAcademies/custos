import { Component, inject } from '@angular/core';
import { WorkspaceStore } from '../state/workspace.store';
import { driverBadge } from '../driver-presentation';

/**
 * The editor context breadcrumb: which connection and database queries run
 * against, the read-only badge, and — importantly — whether this is a live
 * connection or the in-browser demo backend.
 */
@Component({
  selector: 'app-context-bar',
  standalone: true,
  template: `
    <div class="bar">
      @if (ws.activeConnection(); as conn) {
        <span class="badge" [style.background]="badge(conn.driverId).color">{{ badge(conn.driverId).label }}</span>
        <span class="name">{{ conn.name }}</span>
        @if (ws.activeDatabase(); as db) {
          <span class="sep">/</span>
          <span class="mono">{{ db }}</span>
        } @else {
          <span class="sep">/</span>
          <span class="mono muted">no database — pick one from the tree</span>
        }
        @if (conn.readOnly) {
          <span class="ro">
            <svg width="9" height="9" viewBox="0 0 48 48" fill="var(--accent)"><path d="M24 4 39 9.4v12.4c0 10.2-6.6 16.6-15 19.8-8.4-3.2-15-9.6-15-19.8V9.4L24 4Z"/></svg>READ-ONLY
          </span>
        }
      } @else {
        <span class="muted">No connection selected — pick one from the tree</span>
      }

      <div class="grow"></div>

      <span class="mode" [class.demo]="!ws.live" [title]="ws.live ? 'Connected through the desktop app' : 'Running in the browser with sample data — not a real database'">
        <span class="dot"></span>{{ ws.live ? 'Live connection' : 'Demo data' }}
      </span>
    </div>
  `,
  styles: [`
    .bar { height: 27px; flex: none; display: flex; align-items: center; gap: 8px; padding: 0 12px; background: var(--surface); border-bottom: 1px solid var(--border); font: 400 11.5px/1 var(--font-ui); color: var(--text-2); }
    .badge { display: flex; align-items: center; justify-content: center; width: 14px; height: 14px; border-radius: 3px; font: 700 7px/1 var(--font-ui); color: #fff; }
    .name { font-weight: 600; color: var(--text); }
    .sep { color: var(--border-strong); }
    .mono { font-family: var(--font-mono); }
    .muted { color: var(--text-3); }
    .ro { display: inline-flex; align-items: center; gap: 4px; padding: 1px 6px 1px 5px; border-radius: 4px; background: var(--accent-subtle); border: 1px solid color-mix(in srgb, var(--accent) 20%, transparent); font: 600 9.5px/1.5 var(--font-ui); letter-spacing: .04em; color: var(--accent-hover); }
    .grow { flex: 1; }
    .mode { display: inline-flex; align-items: center; gap: 6px; font-family: var(--font-mono); color: var(--success); }
    .mode .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--success); }
    .mode.demo { color: var(--warning); }
    .mode.demo .dot { background: var(--warning); }
  `],
})
export class ContextBarComponent {
  readonly ws = inject(WorkspaceStore);
  readonly badge = driverBadge;
}

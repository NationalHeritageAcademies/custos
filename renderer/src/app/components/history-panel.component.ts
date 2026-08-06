import { Component, computed, inject, signal } from '@angular/core';
import { WorkspaceStore } from '../state/workspace.store';

/** Searchable, per-session query history (design 1h). Click an entry to reopen it. */
@Component({
  selector: 'app-history-panel',
  standalone: true,
  template: `
    @if (ws.historyOpen()) {
      <div class="scrim" (click)="ws.closeHistory()"></div>
      <div class="drawer">
        <div class="head">
          <span class="title">Query history</span>
          <button class="x" (click)="ws.closeHistory()" title="Close">
            <svg width="12" height="12" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none"><path d="M6 6l12 12M18 6 6 18"/></svg>
          </button>
        </div>
        <div class="searchbar">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-4.3-4.3"/></svg>
          <input class="search selectable" placeholder="Search queries…" [value]="q()" (input)="q.set(text($event))" />
        </div>
        <div class="list">
          @for (h of filtered(); track h.id) {
            <button class="entry" (click)="ws.openHistoryEntry(h)">
              <div class="row1">
                <span class="dot" [class.err]="!h.ok"></span>
                <span class="meta">{{ h.connectionName }}@if (h.database) { · {{ h.database }} }</span>
                <span class="time">{{ time(h.at) }}</span>
              </div>
              <code class="sql">{{ preview(h.sql) }}</code>
              <div class="row2">
                @if (h.ok) { {{ h.rowCount }} rows · {{ h.execMs }} ms } @else { <span class="failed">failed</span> }
              </div>
            </button>
          } @empty {
            <div class="empty">{{ ws.history().length ? 'No matches.' : 'No queries yet — run one and it appears here.' }}</div>
          }
        </div>
      </div>
    }
  `,
  styles: [`
    .scrim { position: fixed; inset: 0; background: transparent; z-index: 90; }
    .drawer { position: fixed; top: 0; right: 0; bottom: 0; width: 380px; max-width: 92vw; z-index: 91; display: flex; flex-direction: column; background: var(--bg); border-left: 1px solid var(--border-strong); box-shadow: var(--elev-2); }
    .head { display: flex; align-items: center; padding: 14px 16px 12px; border-bottom: 1px solid var(--border); }
    .title { font: var(--text-dialog); }
    .x { margin-left: auto; display: flex; width: 24px; height: 24px; align-items: center; justify-content: center; border: 0; border-radius: 5px; background: transparent; color: var(--text-2); cursor: pointer; }
    .x:hover { background: var(--surface-2); color: var(--text); }
    .searchbar { display: flex; align-items: center; gap: 7px; margin: 12px 16px; padding: 0 10px; height: 30px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--bg); }
    .searchbar:focus-within { outline: 1px solid var(--accent); outline-offset: -1px; }
    .search { flex: 1; border: 0; outline: none; background: transparent; color: var(--text); font: var(--text-meta); }
    .list { flex: 1; overflow: auto; padding: 0 10px 12px; display: flex; flex-direction: column; gap: 4px; }
    .entry { text-align: left; display: flex; flex-direction: column; gap: 5px; padding: 9px 11px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); cursor: pointer; }
    .entry:hover { border-color: var(--border-strong); background: var(--surface-2); }
    .row1 { display: flex; align-items: center; gap: 7px; font: var(--text-meta); color: var(--text-2); }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--success); flex: none; }
    .dot.err { background: var(--danger); }
    .meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .time { margin-left: auto; font-family: var(--font-mono); color: var(--text-3); }
    .sql { font: 400 11.5px/1.5 var(--font-mono); color: var(--text); word-break: break-word; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .row2 { font: 400 10.5px/1 var(--font-mono); color: var(--text-3); }
    .failed { color: var(--danger); }
    .empty { padding: 24px 12px; text-align: center; color: var(--text-3); font: var(--text-meta); }
  `],
})
export class HistoryPanelComponent {
  readonly ws = inject(WorkspaceStore);
  readonly q = signal('');

  readonly filtered = computed(() => {
    const s = this.q().toLowerCase().trim();
    return this.ws.history().filter((h) => !s || h.sql.toLowerCase().includes(s));
  });

  text(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }
  preview(sql: string): string {
    return sql.replace(/\s+/g, ' ').trim().slice(0, 140);
  }
  time(at: number): string {
    return new Date(at).toLocaleTimeString();
  }
}

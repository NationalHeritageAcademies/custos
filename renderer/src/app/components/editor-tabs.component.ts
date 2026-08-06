import { Component, inject } from '@angular/core';
import { WorkspaceStore } from '../state/workspace.store';

/**
 * The editor tab strip. Each tab is a real query with its own SQL and results;
 * tabs can be switched, closed, and created.
 */
@Component({
  selector: 'app-editor-tabs',
  standalone: true,
  template: `
    <div class="tabs">
      @for (tab of ws.tabs(); track tab.id) {
        <div class="tab" [class.active]="tab.id === ws.activeTabId()" (click)="ws.selectTab(tab.id)" [title]="tab.title">
          <svg class="ico" width="12" height="12" viewBox="0 0 24 24" fill="none" [attr.stroke]="tab.id === ws.activeTabId() ? 'var(--accent)' : 'var(--text-3)'" stroke-width="1.8"><path d="M6.5 3.5h7l5 5v12h-12Z"/><path d="M13 3.5v5h5"/></svg>
          <span class="title">{{ tab.title }}</span>
          @if (tab.dirty) { <span class="dot"></span> }
          <button class="close" title="Close tab" (click)="close($event, tab.id)">
            <svg width="10" height="10" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2" fill="none"><path d="M6 6l12 12M18 6 6 18"/></svg>
          </button>
        </div>
      }
      <button class="new" title="New query" (click)="ws.newTab()">
        <svg width="13" height="13" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none"><path d="M12 5v14M5 12h14"/></svg>
      </button>
    </div>
  `,
  styles: [`
    .tabs { height: 36px; flex: none; display: flex; align-items: stretch; background: var(--surface); border-bottom: 1px solid var(--border); overflow-x: auto; }
    .tab { display: flex; align-items: center; gap: 8px; padding: 0 10px 0 12px; border-right: 1px solid var(--border); font: 500 12px/1 var(--font-ui); color: var(--text-2); cursor: pointer; white-space: nowrap; }
    .tab:hover { color: var(--text); }
    .tab.active { background: var(--bg); color: var(--text); box-shadow: inset 0 2px 0 var(--accent); }
    .ico { flex: none; }
    .title { max-width: 160px; overflow: hidden; text-overflow: ellipsis; }
    .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--warning); flex: none; }
    .close { display: flex; align-items: center; justify-content: center; width: 16px; height: 16px; padding: 0; border: 0; border-radius: 3px; background: transparent; color: var(--text-3); cursor: pointer; visibility: hidden; }
    .tab:hover .close, .tab.active .close { visibility: visible; }
    .close:hover { background: var(--surface-2); color: var(--text); }
    .new { display: flex; align-items: center; justify-content: center; width: 32px; border: 0; background: transparent; color: var(--text-3); cursor: pointer; }
    .new:hover { color: var(--text); }
  `],
})
export class EditorTabsComponent {
  readonly ws = inject(WorkspaceStore);

  close(event: Event, id: string): void {
    event.stopPropagation();
    this.ws.closeTab(id);
  }
}

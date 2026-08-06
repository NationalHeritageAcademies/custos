import { Component, inject } from '@angular/core';
import { WorkspaceStore } from '../state/workspace.store';

/** The editor run toolbar: Run, Run selection, Cancel, and History. */
@Component({
  selector: 'app-editor-toolbar',
  standalone: true,
  template: `
    <div class="toolbar">
      <button class="run" (click)="ws.run()" [disabled]="ws.running()">
        <svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor"><path d="M3 1.5 10 6l-7 4.5Z"/></svg>
        Run <span class="kbd">⌘↵</span>
      </button>
      <button class="ghost" (click)="ws.runSelection()" [disabled]="ws.running()" title="Run the selected text (or the whole tab)">
        <svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor"><path d="M3 1.5 10 6l-7 4.5Z"/></svg>
        Run selection <span class="kbd">⇧⌘↵</span>
      </button>
      <button class="ghost" (click)="ws.cancel()" [disabled]="!ws.running()" title="Cancel the running query">
        <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor"><rect x="2.5" y="2.5" width="7" height="7" rx="1"/></svg>
        Cancel
      </button>

      <span class="spacer"></span>

      <button class="ghost" [class.on]="ws.historyOpen()" (click)="ws.toggleHistory()" title="Query history">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>
        History
      </button>
    </div>
  `,
  styles: [`
    .toolbar { height: 42px; flex: none; display: flex; align-items: center; gap: 8px; padding: 0 12px; border-bottom: 1px solid var(--border); }
    button { display: inline-flex; align-items: center; gap: 7px; height: 27px; padding: 0 11px; border-radius: 6px; font: 600 12px/1 var(--font-ui); cursor: pointer; border: 1px solid transparent; }
    button:disabled { opacity: .5; cursor: default; }
    .run { background: var(--accent); color: var(--on-accent); box-shadow: 0 1px 1px rgba(11,79,78,.25); }
    .run:not(:disabled):hover { background: var(--accent-hover); }
    .ghost { background: var(--bg); border-color: var(--border-strong); color: var(--text); font-weight: 500; }
    .ghost:not(:disabled):hover { background: var(--surface-2); }
    .ghost.on { background: var(--accent-subtle); border-color: color-mix(in srgb, var(--accent) 30%, transparent); color: var(--accent-hover); }
    .kbd { font: 500 10px/1 var(--font-mono); opacity: .72; }
    .spacer { flex: 1; }
  `],
})
export class EditorToolbarComponent {
  readonly ws = inject(WorkspaceStore);
}

import { Component, inject } from '@angular/core';
import { WorkspaceStore } from '../state/workspace.store';

/**
 * The guardian moment (design 1g): shown before running a destructive statement
 * (unguarded UPDATE/DELETE, TRUNCATE, DROP). Consumes the per-statement
 * analyses surfaced by the engine's ConfirmationRequiredError. Protective in
 * tone, not alarming.
 */
@Component({
  selector: 'app-safety-dialog',
  standalone: true,
  template: `
    @if (ws.confirm(); as analyses) {
      <div class="overlay" (click)="ws.cancelConfirm()">
        <div class="dialog" (click)="$event.stopPropagation()">
          <div class="head">
            <span class="shield">
              <svg width="20" height="20" viewBox="0 0 48 48" fill="none">
                <path d="M24 4 39 9.4v12.4c0 10.2-6.6 16.6-15 19.8-8.4-3.2-15-9.6-15-19.8V9.4L24 4Z" stroke="var(--warning)" stroke-width="3" stroke-linejoin="round"/>
                <path d="M24 17.5a3.6 3.6 0 0 1 1.6 6.8v6.9a1.6 1.6 0 0 1-3.2 0v-6.9A3.6 3.6 0 0 1 24 17.5Z" fill="var(--warning)"/>
              </svg>
            </span>
            <div>
              <div class="title">Confirm before running</div>
              <div class="sub">Custos paused this because it could change a lot of data.</div>
            </div>
          </div>

          <ul class="items">
            @for (a of analyses; track $index) {
              <li>
                <span class="kw">{{ a.keyword.toUpperCase() }}</span>
                <span class="reason">{{ a.reason }}</span>
              </li>
            }
          </ul>

          <div class="actions">
            <button class="ghost" (click)="ws.cancelConfirm()">Cancel</button>
            <button class="danger" (click)="ws.confirmRun()">Run anyway</button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .overlay { position: fixed; inset: 0; background: var(--color-overlay, rgba(16,22,25,.45)); display: flex; align-items: center; justify-content: center; z-index: 100; }
    .dialog { width: 440px; max-width: calc(100vw - 32px); background: var(--bg); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--radius-panel); box-shadow: var(--elev-2); padding: 20px; font: var(--text-body); }
    .head { display: flex; gap: 13px; align-items: flex-start; margin-bottom: 14px; }
    .shield { flex: none; display: flex; align-items: center; justify-content: center; width: 38px; height: 38px; border-radius: 9px; background: var(--warning-subtle); }
    .title { font: var(--text-dialog); }
    .sub { font: var(--text-meta); color: var(--text-2); margin-top: 3px; }
    .items { list-style: none; margin: 0 0 18px; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .items li { display: flex; gap: 9px; align-items: baseline; padding: 9px 11px; background: var(--warning-subtle); border: 1px solid color-mix(in srgb, var(--warning) 26%, transparent); border-radius: var(--radius-input); }
    .kw { font: 600 11px/1 var(--font-mono); color: var(--warning); flex: none; }
    .reason { color: var(--text); font: var(--text-meta); }
    .actions { display: flex; justify-content: flex-end; gap: 9px; }
    button { height: 30px; padding: 0 14px; border-radius: var(--radius-input); font: 600 12px/1 var(--font-ui); cursor: pointer; border: 1px solid transparent; }
    .ghost { background: var(--surface); border-color: var(--border-strong); color: var(--text); }
    .ghost:hover { background: var(--surface-2); }
    .danger { background: var(--danger); color: #fff; }
    .danger:hover { filter: brightness(1.06); }
  `],
})
export class SafetyDialogComponent {
  readonly ws = inject(WorkspaceStore);
}

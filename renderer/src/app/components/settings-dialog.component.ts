import { Component, inject } from '@angular/core';
import { WorkspaceStore } from '../state/workspace.store';
import { ThemeService, type ThemeMode } from '../theme.service';

/** Settings dialog (from the titlebar gear): appearance, query defaults, about. */
@Component({
  selector: 'app-settings-dialog',
  standalone: true,
  template: `
    @if (ws.settingsOpen()) {
      <div class="overlay" (click)="ws.closeSettings()">
        <div class="dialog" (click)="$event.stopPropagation()">
          <div class="head">
            <svg width="16" height="16" viewBox="0 0 48 48" fill="none"><path d="M24 4 39 9.4v12.4c0 10.2-6.6 16.6-15 19.8-8.4-3.2-15-9.6-15-19.8V9.4L24 4Z" stroke="var(--accent)" stroke-width="3.4" stroke-linejoin="round"/><path d="M24 18a3.5 3.5 0 0 1 1.6 6.6v6.5a1.6 1.6 0 0 1-3.2 0v-6.5A3.5 3.5 0 0 1 24 18Z" fill="var(--accent)"/></svg>
            <span class="title">Settings</span>
            <span class="esc">esc to close</span>
          </div>

          <div class="body">
            <div class="group">
              <span class="overline">Appearance</span>
              <div class="segmented">
                @for (m of modes; track m) {
                  <button class="seg" [class.on]="theme.mode() === m" (click)="theme.setMode(m)">{{ label(m) }}</button>
                }
              </div>
            </div>

            <div class="group">
              <span class="overline">Query</span>
              <label class="row">
                <span class="lbl">Max rows fetched
                  <span class="hint">how many rows each query returns</span>
                </span>
                <input class="num" type="number" min="1" max="100000" [value]="ws.rowLimit()" (input)="ws.setRowLimit(+val($event))" />
              </label>
            </div>

            <div class="group">
              <span class="overline">Query history</span>
              <div class="row">
                <span class="lbl">{{ ws.history().length }} queries this session</span>
                <button class="ghost" (click)="ws.clearHistory()" [disabled]="!ws.history().length">Clear history</button>
              </div>
            </div>

            <div class="group about">
              <span class="overline">About</span>
              <div class="abt"><b>Custos</b> — keeper of your queries.</div>
              <div class="abt">Running as <b>{{ ws.live ? 'a live connection' : 'demo data (browser preview)' }}</b>.</div>
              <div class="abt">No telemetry — Custos makes no network calls except to the databases you configure. Secrets live in your OS keychain (desktop) or in memory (web).</div>
            </div>
          </div>

          <div class="foot">
            <button class="primary" (click)="ws.closeSettings()">Done</button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .overlay { position: fixed; inset: 0; background: rgba(16,22,25,.45); display: flex; align-items: center; justify-content: center; z-index: 100; }
    :host-context(:root[data-theme='dark']) .overlay { background: rgba(0,0,0,.55); }
    .dialog { width: 460px; max-width: calc(100vw - 32px); background: var(--bg); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--radius-panel); box-shadow: var(--elev-2); }
    .head { display: flex; align-items: center; gap: 10px; padding: 16px 20px 14px; border-bottom: 1px solid var(--border); }
    .title { font: var(--text-dialog); }
    .esc { margin-left: auto; font: 400 11px/1 var(--font-mono); color: var(--text-3); }
    .body { padding: 18px 20px; display: flex; flex-direction: column; gap: 18px; }
    .group { display: flex; flex-direction: column; gap: 9px; }
    .overline { font: var(--text-overline); letter-spacing: var(--overline-tracking); text-transform: uppercase; color: var(--text-3); }
    .segmented { display: inline-flex; gap: 2px; padding: 2px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 7px; align-self: flex-start; }
    .seg { padding: 5px 14px; border: 0; border-radius: 5px; background: transparent; color: var(--text-2); font: 500 12px/1 var(--font-ui); cursor: pointer; }
    .seg.on { background: var(--bg); color: var(--text); box-shadow: var(--elev-1); font-weight: 600; }
    .row { display: flex; align-items: center; gap: 12px; }
    .lbl { font: var(--text-body); display: flex; flex-direction: column; gap: 2px; }
    .hint { font: var(--text-meta); color: var(--text-3); }
    .num { margin-left: auto; width: 96px; height: 30px; padding: 0 10px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--bg); color: var(--text); font: 400 12.5px/1 var(--font-mono); text-align: right; }
    .num:focus { outline: 1px solid var(--accent); outline-offset: -1px; }
    .ghost { margin-left: auto; height: 28px; padding: 0 12px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--bg); color: var(--text); font: 500 12px/1 var(--font-ui); cursor: pointer; }
    .ghost:hover:not(:disabled) { background: var(--surface-2); }
    .ghost:disabled { opacity: .5; cursor: default; }
    .about .abt { font: var(--text-meta); color: var(--text-2); line-height: 1.55; }
    .foot { display: flex; justify-content: flex-end; padding: 13px 20px; background: var(--surface); border-top: 1px solid var(--border); }
    .primary { height: 31px; padding: 0 16px; border: 0; border-radius: 6px; background: var(--accent); color: var(--on-accent); font: 600 12.5px/1 var(--font-ui); cursor: pointer; }
    .primary:hover { background: var(--accent-hover); }
  `],
})
export class SettingsDialogComponent {
  readonly ws = inject(WorkspaceStore);
  readonly theme = inject(ThemeService);
  readonly modes: ThemeMode[] = ['light', 'dark', 'system'];

  val(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }
  label(m: ThemeMode): string {
    return m[0].toUpperCase() + m.slice(1);
  }
}

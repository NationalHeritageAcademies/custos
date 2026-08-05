import { Component, computed, inject } from '@angular/core';
import { WorkspaceStore } from '../state/workspace.store';

/**
 * Import connections from a DataGrip / JetBrains `dataSources.xml`. DataGrip
 * stores no passwords in that file, so this brings in the connection metadata
 * only; the secret is entered once afterward and kept in Custos's own keychain.
 */
@Component({
  selector: 'app-import-dialog',
  standalone: true,
  template: `
    @if (ws.importOpen()) {
      <div class="overlay" (click)="ws.closeImport()">
        <div class="dialog" (click)="$event.stopPropagation()">
          <div class="head">
            <span class="title">Import from DataGrip</span>
            <span class="esc">esc to close</span>
          </div>

          <div class="body">
            <p class="hint">
              Choose your <code>dataSources.xml</code> (or paste it). Passwords aren't stored in that
              file — they'll be entered once and kept in your OS keychain.
            </p>

            <div class="pick">
              <label class="filebtn">
                <input type="file" accept=".xml,text/xml" (change)="onFile($event)" hidden />
                Choose dataSources.xml…
              </label>
              <span class="or">or paste below</span>
            </div>

            <textarea class="paste selectable" spellcheck="false"
              placeholder="&lt;data-source name=…&gt;…&lt;/data-source&gt;"
              (input)="ws.parseImportXml(text($event))"></textarea>

            @if (ws.importError()) {
              <div class="err">{{ ws.importError() }}</div>
            }

            @if (ws.importList().length) {
              <div class="list">
                @for (c of ws.importList(); track $index) {
                  <div class="item" [class.unsupported]="!c.driverId">
                    <span class="badge" [style.background]="c.driverId === 'mysql' ? '#C98A2E' : c.driverId ? '#2E8FD9' : 'var(--text-3)'">
                      {{ c.driverId === 'mysql' ? 'MY' : c.driverId ? 'AZ' : '—' }}
                    </span>
                    <div class="meta">
                      <div class="nm">{{ c.name }} @if (c.readOnly) { <span class="ro">RO</span> }</div>
                      <div class="url">{{ c.jdbcUrl }}</div>
                      @for (w of c.warnings; track $index) {
                        <div class="warn">{{ w }}</div>
                      }
                    </div>
                  </div>
                }
              </div>
            }
          </div>

          <div class="foot">
            <span class="count">{{ supportedCount() }} of {{ ws.importList().length }} importable</span>
            <span class="grow"></span>
            <button class="ghost" (click)="ws.closeImport()">Cancel</button>
            <button class="primary" [disabled]="supportedCount() === 0" (click)="ws.importSupported()">
              Import {{ supportedCount() }} connection{{ supportedCount() === 1 ? '' : 's' }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .overlay { position: fixed; inset: 0; background: rgba(16,22,25,.45); display: flex; align-items: center; justify-content: center; z-index: 100; }
    :host-context(:root[data-theme='dark']) .overlay { background: rgba(0,0,0,.55); }
    .dialog { width: 560px; max-width: calc(100vw - 32px); max-height: calc(100vh - 48px); display: flex; flex-direction: column; background: var(--bg); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--radius-panel); box-shadow: var(--elev-2); }
    .head { display: flex; align-items: center; padding: 16px 20px 14px; border-bottom: 1px solid var(--border); }
    .title { font: var(--text-dialog); }
    .esc { margin-left: auto; font: 400 11px/1 var(--font-mono); color: var(--text-3); }
    .body { padding: 16px 20px; display: flex; flex-direction: column; gap: 12px; overflow: auto; }
    .hint { margin: 0; font: var(--text-meta); color: var(--text-2); }
    code { font-family: var(--font-mono); font-size: 11.5px; }
    .pick { display: flex; align-items: center; gap: 12px; }
    .filebtn { display: inline-flex; align-items: center; height: 31px; padding: 0 13px; border-radius: 6px; border: 1px solid var(--border-strong); background: var(--bg); font: 600 12px/1 var(--font-ui); cursor: pointer; }
    .filebtn:hover { background: var(--surface-2); }
    .or { font: var(--text-meta); color: var(--text-3); }
    .paste { min-height: 76px; resize: vertical; padding: 9px 10px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--bg); color: var(--text); font: 400 11.5px/1.5 var(--font-mono); outline: none; }
    .paste:focus { outline: 1px solid var(--accent); outline-offset: -1px; }
    .err { font: var(--text-meta); color: var(--danger); }
    .list { display: flex; flex-direction: column; gap: 8px; }
    .item { display: flex; gap: 10px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
    .item.unsupported { opacity: .7; }
    .badge { flex: none; display: flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 5px; font: 700 9px/1 var(--font-ui); color: #fff; }
    .meta { min-width: 0; }
    .nm { font: 600 12.5px/1.3 var(--font-ui); display: flex; align-items: center; gap: 6px; }
    .ro { font: 600 8.5px/1.4 var(--font-ui); letter-spacing: .04em; color: var(--accent-hover); background: var(--accent-subtle); border-radius: 3px; padding: 1px 4px; }
    .url { font: 400 11px/1.5 var(--font-mono); color: var(--text-2); word-break: break-all; }
    .warn { font: 400 11px/1.4 var(--font-ui); color: var(--warning); margin-top: 3px; }
    .foot { display: flex; align-items: center; gap: 10px; padding: 13px 20px; background: var(--surface); border-top: 1px solid var(--border); }
    .count { font: var(--text-meta); color: var(--text-2); }
    .grow { flex: 1; }
    button { height: 31px; padding: 0 13px; border-radius: 6px; font: 600 12.5px/1 var(--font-ui); cursor: pointer; border: 1px solid transparent; }
    .ghost { background: var(--bg); border-color: var(--border-strong); color: var(--text); }
    .ghost:hover { background: var(--surface-2); }
    .primary { background: var(--accent); color: var(--on-accent); }
    .primary:hover:not(:disabled) { background: var(--accent-hover); }
    .primary:disabled { opacity: .5; cursor: default; }
  `],
})
export class ImportDialogComponent {
  readonly ws = inject(WorkspaceStore);

  readonly supportedCount = computed(() => this.ws.importList().filter((c) => c.driverId).length);

  text(event: Event): string {
    return (event.target as HTMLTextAreaElement).value;
  }

  onFile(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => this.ws.parseImportXml(String(reader.result ?? ''));
    reader.readAsText(file);
  }
}

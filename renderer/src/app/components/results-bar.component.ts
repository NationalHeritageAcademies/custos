import { Component, inject } from '@angular/core';
import { WorkspaceStore } from '../state/workspace.store';

/** The results toolbar: result-set tabs, a row filter, and export/copy. */
@Component({
  selector: 'app-results-bar',
  standalone: true,
  template: `
    <div class="bar">
      @for (rs of ws.resultSets(); track $index; let i = $index) {
        <button class="rtab" [class.active]="i === ws.activeResultIndex()" (click)="ws.selectResult(i)">
          Result {{ i + 1 }} <span class="count">{{ rs.rows.length }}</span>
        </button>
      } @empty {
        <span class="rtab active">Results</span>
      }

      <span class="spacer"></span>

      <div class="filter">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-4.3-4.3"/></svg>
        <input placeholder="Filter rows…" [value]="ws.gridFilter()" (input)="ws.setGridFilter(text($event))" />
      </div>
      <button class="act" (click)="exportCsv()" [disabled]="!hasRows()" title="Export displayed rows as CSV">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3v12M7 11l5 5 5-5M4 20h16"/></svg>
        Export CSV
      </button>
      <button class="act" (click)="copy()" [disabled]="!hasRows()" title="Copy displayed rows">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>
        {{ copied ? 'Copied' : 'Copy' }}
      </button>
    </div>
  `,
  styles: [`
    .bar { height: 30px; flex: none; display: flex; align-items: stretch; background: var(--surface); border-bottom: 1px solid var(--border); }
    .rtab { display: flex; align-items: center; gap: 7px; padding: 0 12px; border: 0; border-right: 1px solid var(--border); background: transparent; font: 400 11.5px/1 var(--font-ui); color: var(--text-2); cursor: pointer; }
    .rtab.active { background: var(--bg); color: var(--text); font-weight: 600; box-shadow: inset 0 -2px 0 var(--accent); }
    .count { font: 400 10.5px/1 var(--font-mono); color: var(--text-3); }
    .spacer { flex: 1; }
    .filter { display: flex; align-items: center; gap: 6px; padding: 0 8px; margin: 4px 6px; height: 22px; border: 1px solid var(--border); border-radius: 5px; background: var(--bg); }
    .filter:focus-within { border-color: var(--accent); }
    .filter input { width: 130px; border: 0; outline: none; background: transparent; color: var(--text); font: var(--text-meta); }
    .act { display: flex; align-items: center; gap: 5px; padding: 0 10px; border: 0; background: transparent; color: var(--text-2); font: 400 11px/1 var(--font-ui); cursor: pointer; }
    .act:hover:not(:disabled) { color: var(--text); }
    .act:disabled { opacity: .4; cursor: default; }
  `],
})
export class ResultsBarComponent {
  readonly ws = inject(WorkspaceStore);
  copied = false;

  text(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  hasRows(): boolean {
    return (this.ws.result()?.rows.length ?? 0) > 0;
  }

  exportCsv(): void {
    const csv = this.ws.toCsv();
    if (!csv) return;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'custos-export.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  copy(): void {
    void navigator.clipboard?.writeText(this.ws.toCsv());
    this.copied = true;
    setTimeout(() => (this.copied = false), 1200);
  }
}

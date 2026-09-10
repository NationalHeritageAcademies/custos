import { Component, inject } from '@angular/core';
import { WorkspaceStore } from '../state/workspace.store';

/**
 * First-launch / empty state (design 1f), shown when there are no saved
 * connections. The primary CTA opens the connection form.
 */
@Component({
  selector: 'app-welcome',
  standalone: true,
  template: `
    <div class="welcome">
      <svg class="mark" width="62" height="62" viewBox="0 0 48 48" fill="none">
        <path d="M24 4 39 9.4v12.4c0 10.2-6.6 16.6-15 19.8-8.4-3.2-15-9.6-15-19.8V9.4L24 4Z" stroke="var(--accent)" stroke-width="2.6" stroke-linejoin="round"/>
        <path d="M24 17.5a3.6 3.6 0 0 1 1.6 6.8v6.9a1.6 1.6 0 0 1-3.2 0v-6.9A3.6 3.6 0 0 1 24 17.5Z" fill="var(--accent)"/>
      </svg>
      <div class="name">Custos</div>
      <div class="tagline">Keeper of your queries.</div>
      <div class="blurb">No connections yet. Point Custos at an Azure SQL, MySQL or MongoDB server — credentials stay in your OS keychain.</div>
      <div class="cta">
        <button class="primary" (click)="ws.openConnectionForm()">
          <svg width="13" height="13" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.4" fill="none"><path d="M12 5v14M5 12h14"/></svg>
          New connection
        </button>
        <button class="secondary" (click)="ws.openImport()">Import from DataGrip</button>
      </div>
    </div>
  `,
  styles: [`
    :host { position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center; background: var(--bg); }
    .welcome { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 0 40px; max-width: 420px; }
    .name { font: var(--text-display); letter-spacing: -.025em; margin-top: 18px; }
    .tagline { font: 400 14px/1.5 var(--font-ui); color: var(--text-2); margin-top: 8px; }
    .blurb { font: 400 12.5px/1.6 var(--font-ui); color: var(--text-3); margin-top: 6px; max-width: 330px; }
    .cta { margin-top: 24px; display: flex; align-items: center; gap: 10px; }
    .primary { display: inline-flex; align-items: center; gap: 8px; height: 36px; padding: 0 16px; border: 0; border-radius: 7px; background: var(--accent); color: var(--on-accent); font: 600 13px/1 var(--font-ui); cursor: pointer; box-shadow: var(--elev-1); }
    .primary:hover { background: var(--accent-hover); }
    .secondary { height: 36px; padding: 0 14px; border: 1px solid var(--border-strong); border-radius: 7px; background: var(--bg); color: var(--text); font: 500 13px/1 var(--font-ui); cursor: pointer; }
    .secondary:hover { background: var(--surface-2); }
  `],
})
export class WelcomeComponent {
  readonly ws = inject(WorkspaceStore);
}

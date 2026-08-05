import { Component, inject } from '@angular/core';
import type { ConnectionField } from '@custos/shared';
import { WorkspaceStore, type FieldValue } from '../state/workspace.store';

/**
 * New-connection form (design 1e). The engine picker comes from the driver
 * registry; the fields below it are generated entirely from the selected
 * driver's `connectionFields` (type, secret, select options, visibleWhen) — so
 * no engine is special-cased here. Test-connection surfaces live status.
 */
@Component({
  selector: 'app-connection-form',
  standalone: true,
  template: `
    @if (ws.formOpen() && ws.draft(); as draft) {
      <div class="overlay" (click)="ws.closeForm()">
        <div class="dialog" (click)="$event.stopPropagation()">
          <div class="head">
            <svg width="16" height="16" viewBox="0 0 48 48" fill="none"><path d="M24 4 39 9.4v12.4c0 10.2-6.6 16.6-15 19.8-8.4-3.2-15-9.6-15-19.8V9.4L24 4Z" stroke="var(--accent)" stroke-width="3.4" stroke-linejoin="round"/><path d="M24 18a3.5 3.5 0 0 1 1.6 6.6v6.5a1.6 1.6 0 0 1-3.2 0v-6.5A3.5 3.5 0 0 1 24 18Z" fill="var(--accent)"/></svg>
            <span class="title">New connection</span>
            <span class="esc">esc to close</span>
          </div>

          <div class="body">
            <div class="group">
              <span class="overline">Engine</span>
              <div class="engines">
                @for (d of ws.drivers(); track d.metadata.id) {
                  <button class="engine" [class.sel]="draft.driverId === d.metadata.id" (click)="ws.selectDriver(d.metadata.id)">
                    <span class="badge" [style.background]="d.metadata.id === 'mysql' ? '#C98A2E' : '#2E8FD9'">{{ d.metadata.id === 'mysql' ? 'MY' : 'AZ' }}</span>
                    <span class="ename">{{ d.metadata.displayName }}</span>
                  </button>
                }
              </div>
            </div>

            <label class="field">
              <span class="flabel">Display name</span>
              <input class="input" type="text" placeholder="optional" [value]="draft.name" (input)="ws.setName(val($event))" />
            </label>

            @for (f of ws.visibleFields(); track f.key) {
              @if (f.type === 'boolean') {
                <div class="toggle-row" (click)="ws.setField(f.key, !boolVal(f.key))">
                  <span class="switch" [class.on]="boolVal(f.key)"><span class="knob"></span></span>
                  <span class="flabel">{{ f.label }}</span>
                  @if (f.help) { <span class="help">{{ f.help }}</span> }
                </div>
              } @else {
                <label class="field">
                  <span class="flabel">{{ f.label }}@if (f.required) { <span class="req">*</span> }</span>
                  @if (f.type === 'select') {
                    <select class="input" (change)="ws.setField(f.key, val($event))">
                      @for (opt of f.options; track opt.value) {
                        <option [value]="opt.value" [selected]="strVal(f.key) === opt.value">{{ opt.label }}</option>
                      }
                    </select>
                  } @else {
                    <input class="input mono" [type]="f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'"
                           [placeholder]="f.placeholder ?? ''" [value]="strVal(f.key)"
                           (input)="ws.setField(f.key, f.type === 'number' ? +val($event) : val($event))" />
                  }
                  @if (f.help) { <span class="help">{{ f.help }}</span> }
                </label>
              }
            }

            <div class="ro" (click)="ws.setReadOnly(!draft.readOnly)">
              <span class="switch" [class.on]="draft.readOnly"><span class="knob"></span></span>
              <span class="rocol">
                <span class="rotitle">
                  Read-only connection
                  <svg width="11" height="11" viewBox="0 0 48 48" fill="var(--accent)"><path d="M24 4 39 9.4v12.4c0 10.2-6.6 16.6-15 19.8-8.4-3.2-15-9.6-15-19.8V9.4L24 4Z"/></svg>
                </span>
                <span class="rodesc">Blocks INSERT, UPDATE, DELETE, DROP and DDL before they leave your machine. You can still run SELECT and explain plans.</span>
              </span>
            </div>

            @switch (ws.testStatus()) {
              @case ('testing') {
                <div class="state testing"><span class="spin"></span>{{ ws.testMessage() }}</div>
              }
              @case ('ok') {
                <div class="state ok"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2.6"><path d="m5 13 4 4 10-10"/></svg>{{ ws.testMessage() }}</div>
              }
              @case ('error') {
                <div class="state err"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" stroke-width="2.2"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>{{ ws.testMessage() }}</div>
              }
            }
          </div>

          <div class="foot">
            <button class="ghost" (click)="ws.test()">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M4 12a8 8 0 1 1 3 6.2"/><path d="M4 19v-5h5"/></svg>
              Test connection
            </button>
            <span class="grow"></span>
            <button class="ghost" (click)="ws.closeForm()">Cancel</button>
            <button class="primary" (click)="ws.save()">Save &amp; connect</button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .overlay { position: fixed; inset: 0; background: rgba(16,22,25,.45); display: flex; align-items: center; justify-content: center; z-index: 100; }
    :host-context(:root[data-theme='dark']) .overlay { background: rgba(0,0,0,.55); }
    .dialog { width: 600px; max-width: calc(100vw - 32px); max-height: calc(100vh - 48px); overflow: auto; background: var(--bg); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--radius-panel); box-shadow: var(--elev-2); }
    .head { display: flex; align-items: center; gap: 10px; padding: 16px 20px 14px; border-bottom: 1px solid var(--border); }
    .title { font: var(--text-dialog); }
    .esc { margin-left: auto; font: 400 11px/1 var(--font-mono); color: var(--text-3); }
    .body { padding: 18px 20px; display: flex; flex-direction: column; gap: 14px; }
    .group { display: flex; flex-direction: column; gap: 7px; }
    .overline { font: var(--text-overline); letter-spacing: var(--overline-tracking); text-transform: uppercase; color: var(--text-3); }
    .engines { display: flex; gap: 10px; }
    .engine { flex: 1; display: flex; align-items: center; gap: 9px; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border-strong); background: var(--bg); color: var(--text); cursor: pointer; }
    .engine.sel { border: 1.5px solid var(--accent); background: var(--accent-subtle); }
    .engine.sel .ename { color: var(--accent-hover); }
    .badge { display: flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 5px; font: 700 9px/1 var(--font-ui); color: #fff; }
    .ename { font: 600 12.5px/1 var(--font-ui); }
    .field { display: flex; flex-direction: column; gap: 6px; }
    .flabel { font: 500 11.5px/1 var(--font-ui); color: var(--text-2); }
    .req { color: var(--danger); }
    .input { height: 32px; padding: 0 10px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--bg); color: var(--text); font: 400 12.5px/1 var(--font-ui); outline: none; }
    .input.mono { font-family: var(--font-mono); }
    .input:focus { outline: 1px solid var(--accent); outline-offset: -1px; box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 14%, transparent); }
    .help { font: 400 11px/1.4 var(--font-ui); color: var(--text-3); }
    .toggle-row, .ro { display: flex; align-items: flex-start; gap: 11px; padding: 12px 13px; border-radius: 8px; background: var(--accent-subtle); border: 1px solid color-mix(in srgb, var(--accent) 22%, transparent); cursor: pointer; }
    .toggle-row { background: var(--surface); border-color: var(--border); align-items: center; }
    .switch { flex: none; width: 34px; height: 20px; border-radius: 10px; background: var(--border-strong); display: flex; align-items: center; padding: 0 2px; transition: background .12s; }
    .switch.on { background: var(--accent); justify-content: flex-end; }
    .knob { width: 16px; height: 16px; border-radius: 50%; background: #fff; }
    .rocol { display: flex; flex-direction: column; gap: 3px; }
    .rotitle { display: flex; align-items: center; gap: 6px; font: 600 12.5px/1.2 var(--font-ui); color: var(--accent-hover); }
    .rodesc { font: 400 11.5px/1.5 var(--font-ui); color: var(--text-2); }
    .state { display: flex; align-items: center; gap: 10px; padding: 11px 12px; border-radius: 8px; font: 500 12px/1.4 var(--font-ui); }
    .state.testing { background: var(--surface); border: 1px solid var(--border); color: var(--text-2); }
    .state.ok { background: var(--surface); border: 1px solid color-mix(in srgb, var(--success) 30%, transparent); color: var(--success); }
    .state.err { background: var(--danger-subtle); border: 1px solid color-mix(in srgb, var(--danger) 28%, transparent); color: var(--danger); }
    .spin { width: 13px; height: 13px; border-radius: 50%; border: 2px solid var(--text-3); border-top-color: transparent; animation: s .7s linear infinite; }
    @keyframes s { to { transform: rotate(360deg); } }
    .foot { display: flex; align-items: center; gap: 10px; padding: 13px 20px; background: var(--surface); border-top: 1px solid var(--border); }
    .grow { flex: 1; }
    button { height: 31px; padding: 0 13px; border-radius: 6px; font: 600 12.5px/1 var(--font-ui); cursor: pointer; display: inline-flex; align-items: center; gap: 7px; border: 1px solid transparent; }
    .ghost { background: var(--bg); border-color: var(--border-strong); color: var(--text); }
    .ghost:hover { background: var(--surface-2); }
    .primary { background: var(--accent); color: var(--on-accent); }
    .primary:hover { background: var(--accent-hover); }
  `],
})
export class ConnectionFormComponent {
  readonly ws = inject(WorkspaceStore);

  val(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }
  strVal(key: string): string {
    const v = this.ws.draft()?.values[key];
    return v === undefined || typeof v === 'boolean' ? '' : String(v);
  }
  boolVal(key: string): boolean {
    return this.ws.draft()?.values[key] === true;
  }
  fieldTrack(f: ConnectionField): string {
    return f.key;
  }
  setFieldValue(key: string, value: FieldValue): void {
    this.ws.setField(key, value);
  }
}

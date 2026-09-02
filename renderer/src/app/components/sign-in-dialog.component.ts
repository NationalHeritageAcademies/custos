import { Component, inject, signal } from '@angular/core';
import { WorkspaceStore } from '../state/workspace.store';

/**
 * Interactive sign-in dialog — shown while an identity provider (Microsoft
 * Entra ID today) has the floor. Custos never sees the password or the MFA
 * challenge: it relays the device code the provider issued, waits, and closes
 * itself once the provider confirms.
 *
 * Driven entirely by {@link WorkspaceStore.signIn}, which the store opens both
 * from the connection form and from a connect that reported SIGN_IN_REQUIRED.
 */
@Component({
  selector: 'app-sign-in-dialog',
  standalone: true,
  template: `
    @if (ws.signIn(); as flow) {
      <div class="overlay">
        <div class="dialog">
          <div class="head">
            <svg width="16" height="16" viewBox="0 0 48 48" fill="none"><path d="M24 4 39 9.4v12.4c0 10.2-6.6 16.6-15 19.8-8.4-3.2-15-9.6-15-19.8V9.4L24 4Z" stroke="var(--accent)" stroke-width="3.4" stroke-linejoin="round"/><path d="M24 18a3.5 3.5 0 0 1 1.6 6.6v6.5a1.6 1.6 0 0 1-3.2 0v-6.5A3.5 3.5 0 0 1 24 18Z" fill="var(--accent)"/></svg>
            <span class="title">Sign in with Microsoft</span>
            <span class="esc">esc to cancel</span>
          </div>

          <div class="body">
            @switch (flow.status) {
              @case ('failed') {
                <div class="state err">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" stroke-width="2.2"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>
                  {{ flow.message || 'The sign-in did not complete.' }}
                </div>
              }
              @default {
                @if (flow.prompt?.userCode) {
                  <p class="lead">Finish signing in on Microsoft&rsquo;s page — including multi-factor — then come back here.</p>
                  <div class="step">
                    <span class="num">1</span>
                    <div class="scol">
                      <span class="slabel">Open the sign-in page</span>
                      <span class="link mono">{{ flow.prompt?.verificationUri }}</span>
                    </div>
                    <button class="ghost" (click)="ws.openSignInPage()">Open</button>
                  </div>
                  <div class="step">
                    <span class="num">2</span>
                    <div class="scol">
                      <span class="slabel">Enter this code</span>
                      <span class="code mono">{{ flow.prompt?.userCode }}</span>
                    </div>
                    <button class="ghost" (click)="copyCode(flow.prompt?.userCode)">{{ copied() ? 'Copied' : 'Copy' }}</button>
                  </div>
                } @else {
                  <p class="lead">{{ flow.prompt?.message || 'Contacting Microsoft…' }}</p>
                }
                <div class="state testing"><span class="spin"></span>Waiting for Microsoft to confirm your sign-in…</div>
              }
            }
            @if (ws.signInNote()) { <span class="note">{{ ws.signInNote() }}</span> }
            <span class="note">
              Custos never sees your password or MFA codes. The session lives in memory only —
              signing in again is expected after Custos restarts.
            </span>
          </div>

          <div class="foot">
            <span class="grow"></span>
            @if (flow.status === 'failed') {
              <button class="ghost" (click)="ws.cancelSignIn()">Close</button>
              <button class="primary" (click)="ws.retrySignIn()">Try again</button>
            } @else {
              <button class="ghost" (click)="ws.cancelSignIn()">Cancel</button>
            }
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .overlay { position: fixed; inset: 0; background: rgba(16,22,25,.45); display: flex; align-items: center; justify-content: center; z-index: 120; }
    :host-context(:root[data-theme='dark']) .overlay { background: rgba(0,0,0,.55); }
    .dialog { width: 520px; max-width: calc(100vw - 32px); background: var(--bg); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--radius-panel); box-shadow: var(--elev-2); }
    .head { display: flex; align-items: center; gap: 10px; padding: 16px 20px 14px; border-bottom: 1px solid var(--border); }
    .title { font: var(--text-dialog); }
    .esc { margin-left: auto; font: 400 11px/1 var(--font-mono); color: var(--text-3); }
    .body { padding: 18px 20px; display: flex; flex-direction: column; gap: 13px; }
    .lead { margin: 0; font: 400 12.5px/1.55 var(--font-ui); color: var(--text-2); }
    .step { display: flex; align-items: center; gap: 12px; padding: 12px 13px; border-radius: 8px; background: var(--surface); border: 1px solid var(--border); }
    .num { flex: none; display: flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 50%; background: var(--accent-subtle); color: var(--accent-hover); font: 600 11px/1 var(--font-ui); }
    .scol { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1; }
    .slabel { font: 500 11.5px/1 var(--font-ui); color: var(--text-2); }
    .link { font-size: 12px; color: var(--text); word-break: break-all; }
    .code { font: 600 17px/1 var(--font-mono); letter-spacing: .08em; color: var(--text); }
    .mono { font-family: var(--font-mono); }
    .state { display: flex; align-items: center; gap: 10px; padding: 11px 12px; border-radius: 8px; font: 500 12px/1.4 var(--font-ui); }
    .state.testing { background: var(--surface); border: 1px solid var(--border); color: var(--text-2); }
    .state.err { background: var(--danger-subtle); border: 1px solid color-mix(in srgb, var(--danger) 28%, transparent); color: var(--danger); }
    .spin { width: 13px; height: 13px; border-radius: 50%; border: 2px solid var(--text-3); border-top-color: transparent; animation: s .7s linear infinite; }
    @keyframes s { to { transform: rotate(360deg); } }
    .note { font: 400 11px/1.5 var(--font-ui); color: var(--text-3); }
    .foot { display: flex; align-items: center; gap: 10px; padding: 13px 20px; background: var(--surface); border-top: 1px solid var(--border); }
    .grow { flex: 1; }
    button { height: 31px; padding: 0 13px; border-radius: 6px; font: 600 12.5px/1 var(--font-ui); cursor: pointer; display: inline-flex; align-items: center; gap: 7px; border: 1px solid transparent; }
    .ghost { background: var(--bg); border-color: var(--border-strong); color: var(--text); }
    .ghost:hover { background: var(--surface-2); }
    .primary { background: var(--accent); color: var(--on-accent); }
    .primary:hover { background: var(--accent-hover); }
  `],
})
export class SignInDialogComponent {
  readonly ws = inject(WorkspaceStore);
  readonly copied = signal(false);

  /**
   * Copy the device code. `navigator.clipboard` needs a secure context, which
   * the Electron `file://` load is not, so fall back to the old selection-based
   * copy rather than leaving the button dead.
   */
  async copyCode(code: string | undefined): Promise<void> {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      const input = document.createElement('textarea');
      input.value = code;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      input.remove();
    }
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 1_800);
  }
}

import type { CustosApi } from '@custos/shared';
import { DemoBackend } from './demo-backend';
import { HttpBackend } from './http-backend';

let cached: CustosApi | undefined;

interface HostGlobals {
  custos?: CustosApi;
}

/**
 * Web-host mode is flagged by a `<meta name="custos-host" content="http">` that
 * the local server injects. A meta tag (rather than an inline script) keeps the
 * renderer's strict `script-src 'self'` CSP intact — no inline-script exception.
 */
function isHttpHost(): boolean {
  return (
    typeof document !== 'undefined' &&
    document.querySelector('meta[name="custos-host"]')?.getAttribute('content') === 'http'
  );
}

/**
 * Resolve the backend the app talks to, by host:
 *  - Electron desktop  → the `window.custos` IPC bridge.
 *  - Local web server  → HTTP `/api` (flagged by the injected `custos-host` meta).
 *  - Static preview    → the in-browser {@link DemoBackend} (sample data).
 * The first two are real database connections; the last is a simulation.
 */
export function resolveBackend(): CustosApi {
  if (cached) return cached;
  const g = globalThis as unknown as HostGlobals;
  if (g.custos) cached = g.custos;
  else if (isHttpHost()) cached = new HttpBackend();
  else cached = new DemoBackend();
  return cached;
}

/** True when a real database backend is attached (Electron or web server). */
export function isLiveBackend(): boolean {
  const g = globalThis as unknown as HostGlobals;
  return !!g.custos || isHttpHost();
}

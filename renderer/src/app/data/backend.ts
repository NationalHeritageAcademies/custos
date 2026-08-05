import type { CustosApi } from '@custos/shared';
import { DemoBackend } from './demo-backend';
import { HttpBackend } from './http-backend';

let cached: CustosApi | undefined;

interface HostGlobals {
  custos?: CustosApi;
  __CUSTOS_HTTP__?: boolean;
}

/**
 * Resolve the backend the app talks to, by host:
 *  - Electron desktop  → the `window.custos` IPC bridge.
 *  - Local web server  → HTTP `/api` (the server injects `__CUSTOS_HTTP__`).
 *  - Static preview    → the in-browser {@link DemoBackend} (sample data).
 * The first two are real database connections; the last is a simulation.
 */
export function resolveBackend(): CustosApi {
  if (cached) return cached;
  const g = globalThis as unknown as HostGlobals;
  if (g.custos) cached = g.custos;
  else if (g.__CUSTOS_HTTP__) cached = new HttpBackend();
  else cached = new DemoBackend();
  return cached;
}

/** True when a real database backend is attached (Electron or web server). */
export function isLiveBackend(): boolean {
  const g = globalThis as unknown as HostGlobals;
  return !!(g.custos || g.__CUSTOS_HTTP__);
}

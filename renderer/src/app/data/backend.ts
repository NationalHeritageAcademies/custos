import type { CustosApi } from '@custos/shared';
import { DemoBackend } from './demo-backend';

let cached: CustosApi | undefined;

/**
 * Resolve the backend the app talks to. Inside Electron this is the real
 * `window.custos` bridge (drivers + engine); in a plain browser it is the
 * {@link DemoBackend}, so the UI is fully exercisable during design work.
 */
export function resolveBackend(): CustosApi {
  if (cached) return cached;
  const bridge = (globalThis as unknown as { custos?: CustosApi }).custos;
  cached = bridge ?? new DemoBackend();
  return cached;
}

/** True when the real Electron bridge is present (vs. the in-browser demo). */
export function isLiveBackend(): boolean {
  return !!(globalThis as unknown as { custos?: CustosApi }).custos;
}

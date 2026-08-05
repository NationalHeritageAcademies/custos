import { ipcMain } from 'electron';
import { CUSTOS_IPC_CHANNEL, type CustosApiMethod } from '@custos/shared';
import { createDispatcher } from '../dispatch';
import type { ConnectionManager } from '../engine';

/**
 * Registers the single IPC handler that all renderer→main calls flow through,
 * delegating to the shared dispatcher (see dispatch.ts).
 */
export function registerIpc(manager: ConnectionManager): void {
  const dispatch = createDispatcher(manager);
  ipcMain.handle(
    CUSTOS_IPC_CHANNEL,
    (_event, method: CustosApiMethod, ...args: unknown[]) => dispatch(method, args),
  );
}

import { ipcMain } from 'electron';
import { ConfirmationRequiredError, CustosError } from '@custos/core';
import {
  CUSTOS_IPC_CHANNEL,
  type CustosApiMethod,
  type IpcError,
  type IpcResult,
} from '@custos/shared';
import type { ConnectionManager } from '../engine';

type Handler = (...args: any[]) => unknown | Promise<unknown>;

/**
 * Registers the single IPC handler that all renderer→main calls flow through.
 * Every method maps to a {@link ConnectionManager} call; results are wrapped in
 * an {@link IpcResult} so errors (and the confirmation payload) survive the
 * structured-clone boundary that would otherwise strip custom Error fields.
 */
export function registerIpc(manager: ConnectionManager): void {
  const handlers: Record<CustosApiMethod, Handler> = {
    listDrivers: () => manager.listDrivers(),
    listConnections: () => manager.listConnections(),
    saveConnection: (input) => manager.saveConnection(input),
    deleteConnection: (id) => manager.deleteConnection(id),
    testConnection: (input) => manager.testConnection(input),
    openConnection: (id) => manager.openConnection(id),
    closeConnection: (id) => manager.closeConnection(id),
    listDatabases: (id) => manager.listDatabases(id),
    listSchemas: (id, database) => manager.listSchemas(id, database),
    listTables: (id, database, schema) => manager.listTables(id, database, schema),
    listColumns: (id, table) => manager.listColumns(id, table),
    listForeignKeys: (id, table) => manager.listForeignKeys(id, table),
    setActiveDatabase: (id, database) => manager.setActiveDatabase(id, database),
    runQuery: (input) => manager.runQuery(input),
    cancelQuery: (id, queryId) => manager.cancelQuery(id, queryId),
    analyzeSql: (sqlText) => manager.analyzeSql(sqlText),
  };

  ipcMain.handle(
    CUSTOS_IPC_CHANNEL,
    async (_event, method: CustosApiMethod, ...args: unknown[]): Promise<IpcResult<unknown>> => {
      const handler = handlers[method];
      if (!handler) {
        return { ok: false, error: { code: 'UNKNOWN_METHOD', message: `Unknown method: ${method}` } };
      }
      try {
        return { ok: true, value: await handler(...args) };
      } catch (err) {
        return { ok: false, error: toIpcError(err) };
      }
    },
  );
}

function toIpcError(err: unknown): IpcError {
  if (err instanceof ConfirmationRequiredError) {
    return { code: err.code, message: err.message, analyses: err.analyses };
  }
  if (err instanceof CustosError) {
    return { code: err.code, message: err.message };
  }
  return { code: 'ERROR', message: err instanceof Error ? err.message : String(err) };
}

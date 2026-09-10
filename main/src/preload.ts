import { contextBridge, ipcRenderer } from 'electron';
import type { CustosApi, CustosApiMethod, IpcResult } from '@custos/shared';

// A sandboxed preload can only `require('electron')` — it cannot require a
// workspace package at runtime. So the channel name is inlined here rather than
// imported as a value from @custos/shared. Keep it in sync with
// CUSTOS_IPC_CHANNEL there (both are 'custos:invoke').
const CUSTOS_IPC_CHANNEL = 'custos:invoke';

/** Invoke a main-process method and unwrap the {@link IpcResult} envelope. */
async function invoke<T>(method: CustosApiMethod, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(CUSTOS_IPC_CHANNEL, method, ...args)) as IpcResult<T>;
  if (result.ok) return result.value;
  const error = new Error(result.error.message) as Error & {
    code?: string;
    analyses?: unknown;
  };
  error.code = result.error.code;
  if (result.error.analyses) error.analyses = result.error.analyses;
  throw error;
}

/**
 * The safe, minimal API exposed to the renderer on `window.custos`. The
 * renderer never touches ipcRenderer, Node, or any driver directly — this is
 * the entire trust boundary.
 */
const api: CustosApi = {
  listDrivers: () => invoke('listDrivers'),
  listConnections: () => invoke('listConnections'),
  saveConnection: (input) => invoke('saveConnection', input),
  deleteConnection: (id) => invoke('deleteConnection', id),
  testConnection: (input) => invoke('testConnection', input),
  openConnection: (id) => invoke('openConnection', id),
  closeConnection: (id) => invoke('closeConnection', id),
  signInStatus: (input) => invoke('signInStatus', input),
  beginSignIn: (input) => invoke('beginSignIn', input),
  pollSignIn: (flowId) => invoke('pollSignIn', flowId),
  cancelSignIn: (flowId) => invoke('cancelSignIn', flowId),
  openSignInPage: (flowId) => invoke('openSignInPage', flowId),
  listDatabases: (id) => invoke('listDatabases', id),
  listSchemas: (id, database) => invoke('listSchemas', id, database),
  listTables: (id, database, schema) => invoke('listTables', id, database, schema),
  listColumns: (id, table) => invoke('listColumns', id, table),
  listForeignKeys: (id, table) => invoke('listForeignKeys', id, table),
  setActiveDatabase: (id, database) => invoke('setActiveDatabase', id, database),
  runQuery: (input) => invoke('runQuery', input),
  cancelQuery: (id, queryId) => invoke('cancelQuery', id, queryId),
  analyzeSql: (sqlText, connectionId) => invoke('analyzeSql', sqlText, connectionId),
};

contextBridge.exposeInMainWorld('custos', api);

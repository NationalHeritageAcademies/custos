import { contextBridge, ipcRenderer } from 'electron';
import {
  CUSTOS_IPC_CHANNEL,
  type CustosApi,
  type CustosApiMethod,
  type IpcResult,
} from '@custos/shared';

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
  listDatabases: (id) => invoke('listDatabases', id),
  listSchemas: (id, database) => invoke('listSchemas', id, database),
  listTables: (id, schema) => invoke('listTables', id, schema),
  listColumns: (id, table) => invoke('listColumns', id, table),
  listForeignKeys: (id, table) => invoke('listForeignKeys', id, table),
  runQuery: (input) => invoke('runQuery', input),
  cancelQuery: (id, queryId) => invoke('cancelQuery', id, queryId),
  analyzeSql: (sqlText) => invoke('analyzeSql', sqlText),
};

contextBridge.exposeInMainWorld('custos', api);

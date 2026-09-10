import type { CustosApi, CustosApiMethod, IpcResult } from '@custos/shared';

async function call<T>(method: CustosApiMethod, args: unknown[]): Promise<T> {
  const res = await fetch('/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, args }),
  });
  const result = (await res.json()) as IpcResult<T>;
  if (result.ok) return result.value;
  const error = new Error(result.error.message) as Error & { code?: string; analyses?: unknown };
  error.code = result.error.code;
  if (result.error.analyses) error.analyses = result.error.analyses;
  throw error;
}

/**
 * Backend used when Custos runs as a local web app: every call POSTs to the
 * Node server's `/api`, which brokers the real database connection. Same typed
 * contract as the Electron bridge — the UI is unchanged.
 */
export class HttpBackend implements CustosApi {
  listDrivers = () => call<Awaited<ReturnType<CustosApi['listDrivers']>>>('listDrivers', []);
  listConnections = () => call<Awaited<ReturnType<CustosApi['listConnections']>>>('listConnections', []);
  saveConnection: CustosApi['saveConnection'] = (input) => call('saveConnection', [input]);
  deleteConnection: CustosApi['deleteConnection'] = (id) => call('deleteConnection', [id]);
  testConnection: CustosApi['testConnection'] = (input) => call('testConnection', [input]);
  openConnection: CustosApi['openConnection'] = (id) => call('openConnection', [id]);
  closeConnection: CustosApi['closeConnection'] = (id) => call('closeConnection', [id]);
  signInStatus: CustosApi['signInStatus'] = (input) => call('signInStatus', [input]);
  beginSignIn: CustosApi['beginSignIn'] = (input) => call('beginSignIn', [input]);
  pollSignIn: CustosApi['pollSignIn'] = (flowId) => call('pollSignIn', [flowId]);
  cancelSignIn: CustosApi['cancelSignIn'] = (flowId) => call('cancelSignIn', [flowId]);
  openSignInPage: CustosApi['openSignInPage'] = (flowId) => call('openSignInPage', [flowId]);
  listDatabases: CustosApi['listDatabases'] = (id) => call('listDatabases', [id]);
  listSchemas: CustosApi['listSchemas'] = (id, db) => call('listSchemas', [id, db]);
  listTables: CustosApi['listTables'] = (id, db, schema) => call('listTables', [id, db, schema]);
  listColumns: CustosApi['listColumns'] = (id, table) => call('listColumns', [id, table]);
  listForeignKeys: CustosApi['listForeignKeys'] = (id, table) => call('listForeignKeys', [id, table]);
  setActiveDatabase: CustosApi['setActiveDatabase'] = (id, db) => call('setActiveDatabase', [id, db]);
  runQuery: CustosApi['runQuery'] = (input) => call('runQuery', [input]);
  cancelQuery: CustosApi['cancelQuery'] = (id, queryId) => call('cancelQuery', [id, queryId]);
  analyzeSql: CustosApi['analyzeSql'] = (sql, connectionId) => call('analyzeSql', [sql, connectionId]);
}

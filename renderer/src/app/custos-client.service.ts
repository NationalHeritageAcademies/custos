import { Injectable } from '@angular/core';
import type { CustosApi } from '@custos/shared';

/**
 * Thin, typed wrapper over the `window.custos` bridge exposed by the Electron
 * preload script. This is the ONLY way the renderer reaches the main process /
 * databases — there is no direct Node or driver access here.
 *
 * When running in a plain browser (e.g. `ng serve` without Electron) the bridge
 * is absent; `available` is false and calls throw a clear error, so the UI can
 * degrade gracefully during design work.
 */
@Injectable({ providedIn: 'root' })
export class CustosClient {
  private get api(): CustosApi | undefined {
    return (globalThis as unknown as { custos?: CustosApi }).custos;
  }

  get available(): boolean {
    return !!this.api;
  }

  private require(): CustosApi {
    const api = this.api;
    if (!api) {
      throw new Error('Custos bridge unavailable — the app is running outside Electron.');
    }
    return api;
  }

  listDrivers: CustosApi['listDrivers'] = () => this.require().listDrivers();
  listConnections: CustosApi['listConnections'] = () => this.require().listConnections();
  saveConnection: CustosApi['saveConnection'] = (input) => this.require().saveConnection(input);
  deleteConnection: CustosApi['deleteConnection'] = (id) => this.require().deleteConnection(id);
  testConnection: CustosApi['testConnection'] = (input) => this.require().testConnection(input);
  openConnection: CustosApi['openConnection'] = (id) => this.require().openConnection(id);
  closeConnection: CustosApi['closeConnection'] = (id) => this.require().closeConnection(id);
  listDatabases: CustosApi['listDatabases'] = (id) => this.require().listDatabases(id);
  listSchemas: CustosApi['listSchemas'] = (id, db) => this.require().listSchemas(id, db);
  listTables: CustosApi['listTables'] = (id, schema) => this.require().listTables(id, schema);
  listColumns: CustosApi['listColumns'] = (id, table) => this.require().listColumns(id, table);
  listForeignKeys: CustosApi['listForeignKeys'] = (id, table) => this.require().listForeignKeys(id, table);
  runQuery: CustosApi['runQuery'] = (input) => this.require().runQuery(input);
  cancelQuery: CustosApi['cancelQuery'] = (id, queryId) => this.require().cancelQuery(id, queryId);
  analyzeSql: CustosApi['analyzeSql'] = (sql) => this.require().analyzeSql(sql);
}

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DriverRegistry, ReadOnlyViolationError, ConfirmationRequiredError } = require('@custos/core');
const {
  ConnectionManager,
  InMemoryConnectionStore,
  InMemorySecretStore,
} = require('../dist/engine/index.js');

/** A fake driver + connection that records the SQL it was asked to run. */
function makeFakeDriver() {
  const state = { lastSql: null, closed: false, receivedSecrets: null };
  const connection = {
    async listDatabases() {
      return ['app'];
    },
    async listSchemas() {
      return ['dbo'];
    },
    async listTables() {
      return [{ schema: 'dbo', name: 'users', kind: 'table' }];
    },
    async getColumns() {
      return [{ name: 'id', dataType: 'int' }];
    },
    async getForeignKeys() {
      return [];
    },
    async query(sql) {
      state.lastSql = sql;
      return {
        resultSets: [{ columns: [{ name: 'n', dataType: 'int' }], rows: [[1]], truncated: false }],
        rowsAffected: null,
        executionMs: 1,
      };
    },
    async close() {
      state.closed = true;
    },
  };
  const driver = {
    metadata: { id: 'fake', displayName: 'Fake', iconId: 'fake' },
    capabilities: {
      supportsSchemas: true,
      supportsTransactions: true,
      supportsMultipleResultSets: true,
      supportsCancel: true,
      paramStyle: 'positional',
      defaultPort: 0,
    },
    connectionFields: [],
    async connect(_config, secrets) {
      state.receivedSecrets = secrets;
      return connection;
    },
    async testConnection() {
      return { ok: true, message: 'ok' };
    },
  };
  return { driver, state };
}

function newManager() {
  const { driver, state } = makeFakeDriver();
  const registry = new DriverRegistry();
  registry.register(driver);
  const manager = new ConnectionManager(
    registry,
    new InMemoryConnectionStore(),
    new InMemorySecretStore(),
  );
  return { manager, state };
}

const baseConfig = (overrides = {}) => ({
  id: 'c1',
  name: 'Test',
  driverId: 'fake',
  readOnly: false,
  params: { host: 'localhost' },
  ...overrides,
});

test('saveConnection persists config and secrets separately', async () => {
  const { manager, state } = newManager();
  await manager.saveConnection({ config: baseConfig(), secrets: { password: 's3cret' } });
  const list = await manager.listConnections();
  assert.equal(list.length, 1);
  // The persisted config must not carry the secret.
  assert.equal('password' in list[0], false);
  await manager.openConnection('c1');
  assert.deepEqual(state.receivedSecrets, { password: 's3cret' });
});

test('runQuery on an open connection returns results', async () => {
  const { manager } = newManager();
  await manager.saveConnection({ config: baseConfig(), secrets: {} });
  await manager.openConnection('c1');
  const result = await manager.runQuery({ connectionId: 'c1', queryId: 'q1', sql: 'SELECT 1' });
  assert.equal(result.resultSets[0].rows[0][0], 1);
});

test('read-only connection refuses writes', async () => {
  const { manager } = newManager();
  await manager.saveConnection({ config: baseConfig({ readOnly: true }), secrets: {} });
  await manager.openConnection('c1');
  await assert.rejects(
    manager.runQuery({ connectionId: 'c1', queryId: 'q1', sql: 'DELETE FROM users WHERE id=1' }),
    ReadOnlyViolationError,
  );
});

test('destructive statement requires confirmation, then runs when confirmed', async () => {
  const { manager, state } = newManager();
  await manager.saveConnection({ config: baseConfig(), secrets: {} });
  await manager.openConnection('c1');
  await assert.rejects(
    manager.runQuery({ connectionId: 'c1', queryId: 'q1', sql: 'DELETE FROM users' }),
    ConfirmationRequiredError,
  );
  const result = await manager.runQuery({
    connectionId: 'c1',
    queryId: 'q2',
    sql: 'DELETE FROM users',
    confirmDestructive: true,
  });
  assert.ok(result);
  assert.equal(state.lastSql, 'DELETE FROM users');
});

test('querying a connection that is not open throws', async () => {
  const { manager } = newManager();
  await manager.saveConnection({ config: baseConfig(), secrets: {} });
  await assert.rejects(manager.runQuery({ connectionId: 'c1', queryId: 'q1', sql: 'SELECT 1' }));
});

test('deleteConnection closes and removes it', async () => {
  const { manager, state } = newManager();
  await manager.saveConnection({ config: baseConfig(), secrets: {} });
  await manager.openConnection('c1');
  await manager.deleteConnection('c1');
  assert.equal(state.closed, true);
  assert.deepEqual(await manager.listConnections(), []);
});

test('statement timeout aborts a slow query', async () => {
  // A driver whose query only settles when its abort signal fires.
  const hangingConnection = {
    async listDatabases() { return []; },
    async listSchemas() { return []; },
    async listTables() { return []; },
    async getColumns() { return []; },
    async getForeignKeys() { return []; },
    async useDatabase() {},
    query(_sql, options) {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('server: query interrupted')));
      });
    },
    async close() {},
  };
  const driver = {
    metadata: { id: 'hang', displayName: 'Hang', iconId: 'hang' },
    capabilities: { supportsSchemas: false, supportsTransactions: true, supportsMultipleResultSets: false, supportsCancel: true, paramStyle: 'positional', defaultPort: 0 },
    connectionFields: [],
    async connect() { return hangingConnection; },
    async testConnection() { return { ok: true, message: 'ok' }; },
  };
  const registry = new DriverRegistry();
  registry.register(driver);
  const manager = new ConnectionManager(registry, new InMemoryConnectionStore(), new InMemorySecretStore());
  await manager.saveConnection({ config: { id: 'h', name: 'h', driverId: 'hang', readOnly: false, params: {} }, secrets: {} });
  await manager.openConnection('h');

  await assert.rejects(
    manager.runQuery({ connectionId: 'h', queryId: 'qt', sql: 'SELECT 1', timeoutMs: 20 }),
    /exceeded the 20ms timeout/,
  );
});

test('listDrivers advertises registered drivers', () => {
  const { manager } = newManager();
  const drivers = manager.listDrivers();
  assert.equal(drivers.length, 1);
  assert.equal(drivers[0].metadata.id, 'fake');
});

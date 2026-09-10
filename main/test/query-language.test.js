'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DriverRegistry, ReadOnlyViolationError, ConfirmationRequiredError } = require('@custos/core');
const { mongoAnalyzer } = require('@custos/driver-mongodb');
const {
  ConnectionManager,
  InMemoryConnectionStore,
  InMemorySecretStore,
} = require('../dist/engine/index.js');

/**
 * The guardian rules must hold for engines that do not speak SQL. This uses the
 * real MongoDB analyzer behind a fake connection, so it exercises the wiring
 * (driver → engine) without needing a server.
 */
function makeDriver({ id, analyzer }) {
  const state = { lastSql: null };
  const driver = {
    metadata: { id, displayName: id, iconId: id },
    capabilities: {
      supportsSchemas: false,
      supportsTransactions: true,
      supportsMultipleResultSets: true,
      supportsCancel: true,
      paramStyle: 'none',
      defaultPort: 0,
    },
    connectionFields: [],
    async connect() {
      return {
        async listDatabases() { return []; },
        async listSchemas() { return []; },
        async listTables() { return []; },
        async getColumns() { return []; },
        async getForeignKeys() { return []; },
        async useDatabase() {},
        async query(sql) {
          state.lastSql = sql;
          return { resultSets: [], rowsAffected: null, executionMs: 1 };
        },
        async close() {},
      };
    },
    async testConnection() { return { ok: true, message: 'ok' }; },
  };
  if (analyzer) driver.analyzer = analyzer;
  return { driver, state };
}

async function openManager({ readOnly = false } = {}) {
  const registry = new DriverRegistry();
  const mongo = makeDriver({ id: 'mongodb', analyzer: mongoAnalyzer });
  const sql = makeDriver({ id: 'sqlish' });
  registry.register(mongo.driver);
  registry.register(sql.driver);
  const manager = new ConnectionManager(registry, new InMemoryConnectionStore(), new InMemorySecretStore());
  await manager.saveConnection({
    config: { id: 'm1', name: 'mongo', driverId: 'mongodb', readOnly, params: {} },
    secrets: {},
  });
  await manager.openConnection('m1');
  return { manager, state: mongo.state };
}

test('a read-only MongoDB connection refuses a write the SQL analyzer would miss', async () => {
  const { manager } = await openManager({ readOnly: true });
  await assert.rejects(
    manager.runQuery({ connectionId: 'm1', queryId: 'q1', sql: 'db.users.deleteMany({ a: 1 })' }),
    ReadOnlyViolationError,
  );
  // Reads still go through.
  await manager.runQuery({ connectionId: 'm1', queryId: 'q2', sql: 'db.users.find({})' });
});

test('an unfiltered deleteMany requires confirmation, then runs when confirmed', async () => {
  const { manager, state } = await openManager();
  const source = 'db.users.deleteMany({})';
  await assert.rejects(
    manager.runQuery({ connectionId: 'm1', queryId: 'q1', sql: source }),
    ConfirmationRequiredError,
  );
  await manager.runQuery({ connectionId: 'm1', queryId: 'q2', sql: source, confirmDestructive: true });
  assert.equal(state.lastSql, source);
});

test('analyzeSql reports in the connection\'s own language', async () => {
  const { manager } = await openManager();
  const [mongo] = await manager.analyzeSql('db.users.drop()', 'm1');
  assert.equal(mongo.kind, 'ddl');
  assert.equal(mongo.requiresConfirmation, true);
  // Without a connection id it falls back to SQL, where that text means nothing.
  const [unqualified] = await manager.analyzeSql('db.users.drop()');
  assert.equal(unqualified.kind, 'unknown');
  // And a SQL connection is still analyzed as SQL.
  const [sql] = await manager.analyzeSql('DROP TABLE users');
  assert.equal(sql.kind, 'ddl');
});

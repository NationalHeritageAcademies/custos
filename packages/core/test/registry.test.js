'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DriverRegistry, UnknownDriverError, DuplicateDriverError } = require('../dist/index.js');

function fakeDriver(id) {
  return {
    metadata: { id, displayName: id, iconId: id },
    capabilities: {
      supportsSchemas: true,
      supportsTransactions: true,
      supportsMultipleResultSets: true,
      supportsCancel: true,
      paramStyle: 'positional',
      defaultPort: 1,
    },
    connectionFields: [],
    async connect() {
      throw new Error('not implemented');
    },
    async testConnection() {
      return { ok: true, message: 'ok' };
    },
  };
}

test('register and get a driver by id', () => {
  const registry = new DriverRegistry();
  const driver = fakeDriver('mysql');
  registry.register(driver);
  assert.equal(registry.get('mysql'), driver);
  assert.equal(registry.has('mysql'), true);
});

test('get throws UnknownDriverError for an unregistered id', () => {
  const registry = new DriverRegistry();
  assert.throws(() => registry.get('nope'), UnknownDriverError);
});

test('registering a duplicate id throws', () => {
  const registry = new DriverRegistry();
  registry.register(fakeDriver('mysql'));
  assert.throws(() => registry.register(fakeDriver('mysql')), DuplicateDriverError);
});

test('list returns all registered drivers', () => {
  const registry = new DriverRegistry();
  registry.register(fakeDriver('mysql'));
  registry.register(fakeDriver('azuresql'));
  assert.deepEqual(
    registry.list().map((d) => d.metadata.id).sort(),
    ['azuresql', 'mysql'],
  );
});

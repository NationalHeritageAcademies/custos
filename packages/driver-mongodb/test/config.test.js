'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertRequiredSecrets, buildClientConfig, MongoDbDriver } = require('../dist/index.js');

const config = (params) => ({
  id: 'c1',
  name: 'c1',
  driverId: 'mongodb',
  readOnly: false,
  params,
});

test('a host connection builds a mongodb:// URI with its options', () => {
  const { uri, options } = buildClientConfig(
    config({ mode: 'fields', host: 'db.internal', port: 27018, authSource: 'admin', tls: true }),
    {},
  );
  assert.equal(uri, 'mongodb://db.internal:27018/?authSource=admin&tls=true');
  assert.equal(options.appName, 'Custos');
});

test('credentials are passed as options, not embedded in the URI', () => {
  const { uri, options } = buildClientConfig(
    config({ mode: 'fields', host: 'localhost', port: 27017, user: 'app' }),
    { password: 'p@ss/word' },
  );
  assert.ok(!uri.includes('p@ss'));
  assert.deepEqual(options.auth, { username: 'app', password: 'p@ss/word' });
});

test('an SRV connection carries no port — DNS supplies it', () => {
  const { uri } = buildClientConfig(
    config({ mode: 'fields', srv: true, host: 'cluster.example.net', port: 27017 }),
    {},
  );
  assert.equal(uri, 'mongodb+srv://cluster.example.net/');
});

test('connection-string mode uses the stored string verbatim', () => {
  const { uri } = buildClientConfig(config({ mode: 'uri' }), {
    uri: 'mongodb+srv://u:p@cluster.example.net/shop',
  });
  assert.equal(uri, 'mongodb+srv://u:p@cluster.example.net/shop');
});

test('a missing secret fails with a clear message before any socket is opened', () => {
  assert.throws(() => assertRequiredSecrets(config({ mode: 'uri' }), {}), /missing its connection string/);
  assert.throws(() => assertRequiredSecrets(config({ mode: 'fields' }), {}), /missing its host/);
  assert.throws(
    () => assertRequiredSecrets(config({ mode: 'fields', host: 'localhost', user: 'app' }), {}),
    /missing its password/,
  );
});

test('a complete configuration passes validation', () => {
  assert.doesNotThrow(() =>
    assertRequiredSecrets(config({ mode: 'fields', host: 'localhost', user: 'app' }), {
      password: 'x',
    }),
  );
  // No user means no authentication is attempted; a password is not required.
  assert.doesNotThrow(() => assertRequiredSecrets(config({ mode: 'fields', host: 'localhost' }), {}));
});

test('the driver advertises itself as a non-SQL engine with its own analyzer', () => {
  const driver = new MongoDbDriver();
  assert.equal(driver.metadata.id, 'mongodb');
  assert.equal(driver.capabilities.queryLanguage, 'mongodb');
  assert.equal(driver.capabilities.supportsSchemas, false);
  assert.equal(typeof driver.analyzer.analyzeBatch, 'function');
  // Every secret field must be marked, or it would be written to disk.
  const secretKeys = driver.connectionFields.filter((f) => f.secret).map((f) => f.key);
  assert.deepEqual(secretKeys.sort(), ['password', 'uri']);
});

test('testConnection reports a failure rather than throwing', async () => {
  const result = await new MongoDbDriver().testConnection(config({ mode: 'uri' }), {});
  assert.equal(result.ok, false);
  assert.match(result.message, /missing its connection string/);
});

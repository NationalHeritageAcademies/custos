'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AzureSqlDriver, buildConfig, assertRequiredSecrets } = require('../dist/index.js');

const base = (params) => ({ id: 'x', name: 'x', driverId: 'azuresql', readOnly: false, params });

test('driver advertises ntlm auth mode and a domain field', () => {
  const driver = new AzureSqlDriver();
  const authMode = driver.connectionFields.find((f) => f.key === 'authMode');
  assert.ok(authMode.options.some((o) => o.value === 'ntlm'), 'ntlm option present');
  const domain = driver.connectionFields.find((f) => f.key === 'domain');
  assert.deepEqual(domain.visibleWhen, { field: 'authMode', equals: 'ntlm' });
  const user = driver.connectionFields.find((f) => f.key === 'user');
  assert.deepEqual(user.visibleWhen, { field: 'authMode', in: ['sql', 'ntlm'] });
});

test('ntlm auth builds a config with domain + user + password', () => {
  const cfg = buildConfig(
    base({ server: 'sql-01.example.internal', port: 1433, database: 'AppAuthorization', authMode: 'ntlm', user: 'svc', domain: 'CORP' }),
    { password: 's3cret' },
  );
  assert.equal(cfg.domain, 'CORP');
  assert.equal(cfg.user, 'svc');
  assert.equal(cfg.password, 's3cret');
  assert.equal(cfg.server, 'sql-01.example.internal');
  assert.equal(cfg.database, 'AppAuthorization');
});

test('sql auth builds a config without a domain', () => {
  const cfg = buildConfig(base({ server: 'h', authMode: 'sql', user: 'sa' }), { password: 'p' });
  assert.equal(cfg.domain, undefined);
  assert.equal(cfg.user, 'sa');
});

test('azure ad token auth uses the access-token authentication type', () => {
  const cfg = buildConfig(base({ server: 'h', authMode: 'azuread-token' }), { accessToken: 'tok' });
  assert.equal(cfg.authentication.type, 'azure-active-directory-access-token');
  assert.equal(cfg.authentication.options.token, 'tok');
});

test('assertRequiredSecrets rejects NTLM without a password (the crash repro)', () => {
  assert.throws(
    () => assertRequiredSecrets(base({ server: 'h', authMode: 'ntlm', user: 'svc', domain: 'CORP' }), {}),
    /password is missing/i,
  );
});

test('assertRequiredSecrets rejects SQL/NTLM without a user', () => {
  assert.throws(
    () => assertRequiredSecrets(base({ server: 'h', authMode: 'sql' }), { password: 'p' }),
    /user name is missing/i,
  );
});

test('assertRequiredSecrets rejects azure-ad-token without a token', () => {
  assert.throws(
    () => assertRequiredSecrets(base({ server: 'h', authMode: 'azuread-token' }), {}),
    /access token is missing/i,
  );
});

test('assertRequiredSecrets passes when the required secrets are present', () => {
  assert.doesNotThrow(() =>
    assertRequiredSecrets(base({ server: 'h', authMode: 'ntlm', user: 'svc', domain: 'CORP' }), { password: 's3cret' }),
  );
  assert.doesNotThrow(() =>
    assertRequiredSecrets(base({ server: 'h', authMode: 'azuread-token' }), { accessToken: 'tok' }),
  );
});

test('testConnection fails cleanly (no throw) when a required secret is missing', async () => {
  const driver = new AzureSqlDriver();
  const result = await driver.testConnection(
    { driverId: 'azuresql', params: { server: 'h', authMode: 'ntlm', user: 'svc', domain: 'CORP' } },
    {},
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /password is missing/i);
});

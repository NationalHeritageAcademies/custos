'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const tedious = require('tedious');
const {
  AzureSqlDriver,
  buildConfig,
  buildPool,
  forgetEntraCredential,
  assertRequiredSecrets,
  isInteractiveEntraMode,
  resetEntraCredentials,
} = require('../dist/index.js');

const base = (params) => ({ id: 'x', name: 'x', driverId: 'azuresql', readOnly: false, params });
const entra = (extra = {}) => base({ server: 'sql.database.windows.net', authMode: 'entra-mfa', ...extra });

test.beforeEach(() => resetEntraCredentials());

test('driver advertises the three Entra sign-in modes', () => {
  const driver = new AzureSqlDriver();
  const modes = driver.connectionFields
    .find((f) => f.key === 'authMode')
    .options.map((o) => o.value);
  assert.ok(modes.includes('entra-mfa'), 'device-code MFA mode present');
  assert.ok(modes.includes('entra-browser'), 'browser mode present');
  assert.ok(modes.includes('entra-azure-cli'), 'azure-cli mode present');
});

test('tenant and client-id fields are shown only for the Entra modes', () => {
  const driver = new AzureSqlDriver();
  const tenant = driver.connectionFields.find((f) => f.key === 'tenantId');
  assert.deepEqual(tenant.visibleWhen, {
    field: 'authMode',
    in: ['entra-mfa', 'entra-browser', 'entra-azure-cli'],
  });
  // The Azure CLI holds its own app registration, so client id is not offered there.
  const client = driver.connectionFields.find((f) => f.key === 'clientId');
  assert.deepEqual(client.visibleWhen, { field: 'authMode', in: ['entra-mfa', 'entra-browser'] });
  assert.ok(!tenant.secret && !client.secret, 'neither is a secret — both persist with the config');
});

test('an Entra connection hands tedious a token credential, not a token', () => {
  const cfg = buildConfig(entra(), {});
  assert.equal(cfg.authentication.type, 'token-credential');
  assert.equal(typeof cfg.authentication.options.credential.getToken, 'function');
  // No secret of ours travels in the config for these modes.
  assert.equal(cfg.password, undefined);
  assert.equal(cfg.user, undefined);
});

test('the credential is shared per tenant + app, and separate across them', () => {
  const one = buildConfig(entra({ tenantId: 'contoso.onmicrosoft.com' }), {}).authentication.options.credential;
  const same = buildConfig(entra({ tenantId: 'contoso.onmicrosoft.com' }), {}).authentication.options.credential;
  const other = buildConfig(entra({ tenantId: 'fabrikam.onmicrosoft.com' }), {}).authentication.options.credential;
  assert.equal(one, same, 'one sign-in serves every connection to the same tenant');
  assert.notEqual(one, other, 'a different tenant signs in separately');
});

test('the pool keeps a usable credential — node-mssql deep-clones its config', () => {
  // Regression: mssql's ConnectionPool constructor deep-clones the config with
  // rfdc, which flattens the credential class into a plain object. tedious then
  // rejected it with "must be an instance of the token credential class".
  for (const authMode of ['entra-mfa', 'entra-browser', 'entra-azure-cli']) {
    const pool = buildPool(base({ server: 's.database.windows.net', authMode }), {});
    const mapped = pool._config();
    assert.equal(
      typeof mapped.authentication.options.credential.getToken,
      'function',
      `${authMode}: credential survives mssql's clone`,
    );
    // And prove it against the validation that actually threw.
    assert.doesNotThrow(() => new tedious.Connection(mapped).close(), `${authMode}: tedious accepts it`);
  }
});

test('forgetting a sign-in discards the session, so the next one really prompts', () => {
  const before = buildConfig(entra(), {}).authentication.options.credential;
  assert.equal(buildConfig(entra(), {}).authentication.options.credential, before, 'cached until forgotten');
  forgetEntraCredential(entra().params);
  const after = buildConfig(entra(), {}).authentication.options.credential;
  // A fresh credential has an empty token cache — which is the whole point:
  // a credential that still holds a session signs the same account back in
  // silently, and "switch account" would appear to do nothing.
  assert.notEqual(after, before);
  // Forgetting a mode that has no session (or is not an Entra mode) is a no-op.
  assert.doesNotThrow(() => forgetEntraCredential({ authMode: 'sql' }));
});

test('the driver exposes forgetSignIn so the engine can offer "switch account"', () => {
  const driver = new AzureSqlDriver();
  const before = buildConfig(entra(), {}).authentication.options.credential;
  driver.forgetSignIn(entra().params);
  assert.notEqual(buildConfig(entra(), {}).authentication.options.credential, before);
});

test('the browser and azure-cli modes build their own credentials', () => {
  const browser = buildConfig(base({ server: 'h', authMode: 'entra-browser' }), {}).authentication;
  const cli = buildConfig(base({ server: 'h', authMode: 'entra-azure-cli' }), {}).authentication;
  assert.equal(browser.type, 'token-credential');
  assert.equal(cli.type, 'token-credential');
  assert.notEqual(browser.options.credential, cli.options.credential);
});

test('Entra modes need no stored secret', () => {
  assert.doesNotThrow(() => assertRequiredSecrets(entra(), {}));
  assert.doesNotThrow(() =>
    assertRequiredSecrets(base({ server: 'h', authMode: 'entra-azure-cli' }), {}),
  );
});

test('only the browser-based modes count as interactive', () => {
  assert.equal(isInteractiveEntraMode({ authMode: 'entra-mfa' }), true);
  assert.equal(isInteractiveEntraMode({ authMode: 'entra-browser' }), true);
  assert.equal(isInteractiveEntraMode({ authMode: 'entra-azure-cli' }), false);
  assert.equal(isInteractiveEntraMode({ authMode: 'sql' }), false);
});

test('signInRequirement reports what the UI needs to show', () => {
  const driver = new AzureSqlDriver();
  assert.deepEqual(driver.signInRequirement({ authMode: 'entra-mfa' }), {
    required: true,
    account: null,
  });
  assert.deepEqual(driver.signInRequirement({ authMode: 'sql' }), {
    required: false,
    account: null,
  });
  // The CLI already signed the user in; Custos has no sign-in to offer.
  assert.deepEqual(driver.signInRequirement({ authMode: 'entra-azure-cli' }), {
    required: false,
    account: null,
  });
});

test('connecting before signing in fails with SIGN_IN_REQUIRED (and never touches the network)', async () => {
  const driver = new AzureSqlDriver();
  await assert.rejects(() => driver.connect(entra(), {}), (err) => {
    assert.equal(err.code, 'SIGN_IN_REQUIRED');
    assert.match(err.message, /sign in/i);
    return true;
  });
});

test('testConnection lets SIGN_IN_REQUIRED through instead of reporting a failure', async () => {
  const driver = new AzureSqlDriver();
  // Other failures come back as { ok: false }; this one is an action the user
  // can take, so the UI needs the code, not a message in the form.
  await assert.rejects(() => driver.testConnection(entra(), {}), (err) => err.code === 'SIGN_IN_REQUIRED');
});

test('signIn refuses a mode that has no interactive sign-in', async () => {
  const driver = new AzureSqlDriver();
  await assert.rejects(
    () => driver.signIn({ authMode: 'entra-azure-cli' }, () => {}),
    /does not use an interactive sign-in/i,
  );
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DriverRegistry } = require('@custos/core');
const {
  ConnectionManager,
  InMemoryConnectionStore,
  InMemorySecretStore,
  isAllowedSignInUrl,
} = require('../dist/engine/index.js');

/**
 * A driver whose auth mode signs in interactively, standing in for the Azure SQL
 * driver's Entra modes. The sign-in resolves only when the test says so, which is
 * exactly the shape of a real device-code flow: prompt first, outcome later.
 */
function makeInteractiveDriver() {
  const state = { prompts: [], aborted: false, forgotten: 0, account: 'user@example.com' };
  // Resolvers for the in-flight sign-in, filled in when signIn() is called.
  let resolveSignIn = () => {};
  let rejectSignIn = () => {};
  const driver = {
    metadata: { id: 'sso', displayName: 'SSO', iconId: 'sso' },
    capabilities: {
      supportsSchemas: false,
      supportsTransactions: false,
      supportsMultipleResultSets: false,
      supportsCancel: false,
      paramStyle: 'none',
      defaultPort: 0,
    },
    connectionFields: [],
    async connect() {
      throw new Error('not used');
    },
    async testConnection() {
      return { ok: true, message: 'ok' };
    },
    signInRequirement(params) {
      return { required: params.authMode === 'sso', account: state.signedIn ?? null };
    },
    forgetSignIn() {
      state.forgotten++;
      state.signedIn = null;
    },
    signIn(params, onPrompt, signal) {
      const pending = new Promise((resolve, reject) => {
        resolveSignIn = resolve;
        rejectSignIn = reject;
      });
      signal?.addEventListener('abort', () => {
        state.aborted = true;
        rejectSignIn(new Error('aborted'));
      });
      // The code reaches the user long before the flow settles.
      onPrompt({
        kind: 'device-code',
        message: 'Go to the page and enter ABC-123',
        userCode: 'ABC-123',
        verificationUri: 'https://microsoft.com/devicelogin',
      });
      state.prompts.push('shown');
      return pending;
    },
  };
  const complete = () => {
    state.signedIn = state.account;
    resolveSignIn(state.account);
  };
  return { driver, state, complete };
}

/** A plain driver with no interactive sign-in, to check the fallbacks. */
const plainDriver = {
  metadata: { id: 'plain', displayName: 'Plain', iconId: 'plain' },
  capabilities: {
    supportsSchemas: false,
    supportsTransactions: false,
    supportsMultipleResultSets: false,
    supportsCancel: false,
    paramStyle: 'none',
    defaultPort: 0,
  },
  connectionFields: [],
  async connect() {
    throw new Error('not used');
  },
  async testConnection() {
    return { ok: true, message: 'ok' };
  },
};

function newManager(openExternal) {
  const { driver, state, complete } = makeInteractiveDriver();
  const registry = new DriverRegistry();
  registry.register(driver);
  registry.register(plainDriver);
  const manager = new ConnectionManager(
    registry,
    new InMemoryConnectionStore(),
    new InMemorySecretStore(),
    openExternal,
  );
  return { manager, state, complete };
}

const input = { driverId: 'sso', params: { authMode: 'sso' } };

test('beginSignIn returns as soon as the code is known, before the sign-in finishes', async () => {
  const { manager, complete } = newManager();
  const started = await manager.beginSignIn(input);
  assert.equal(started.status, 'pending');
  assert.equal(started.prompt.userCode, 'ABC-123');
  // Still pending until the provider confirms.
  assert.equal(manager.pollSignIn(started.flowId).status, 'pending');
  complete();
  await new Promise((resolve) => setImmediate(resolve));
  const done = manager.pollSignIn(started.flowId);
  assert.equal(done.status, 'complete');
  assert.equal(done.account, 'user@example.com');
});

test('a completed flow is reported once, then forgotten', async () => {
  const { manager, complete } = newManager();
  const started = await manager.beginSignIn(input);
  complete();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.pollSignIn(started.flowId).status, 'complete');
  const stale = manager.pollSignIn(started.flowId);
  assert.equal(stale.status, 'failed');
  assert.match(stale.message, /no longer in progress/i);
});

test('signInStatus reflects the driver, and reports the account after signing in', async () => {
  const { manager, complete } = newManager();
  assert.deepEqual(manager.signInStatus(input), { required: true, account: null });
  const started = await manager.beginSignIn(input);
  complete();
  await new Promise((resolve) => setImmediate(resolve));
  manager.pollSignIn(started.flowId);
  assert.deepEqual(manager.signInStatus(input), { required: true, account: 'user@example.com' });
});

test('cancelSignIn aborts the driver flow', async () => {
  const { manager, state } = newManager();
  const started = await manager.beginSignIn(input);
  manager.cancelSignIn(started.flowId);
  assert.equal(state.aborted, true);
  assert.equal(manager.pollSignIn(started.flowId).status, 'failed');
});

test('switchAccount forgets the session first, so the provider actually prompts', async () => {
  const { manager, state, complete } = newManager();
  const first = await manager.beginSignIn(input);
  complete();
  await new Promise((resolve) => setImmediate(resolve));
  manager.pollSignIn(first.flowId);
  assert.equal(state.forgotten, 0, 'a plain sign-in keeps the session');
  assert.equal(manager.signInStatus(input).account, 'user@example.com');

  await manager.beginSignIn({ ...input, switchAccount: true });
  assert.equal(state.forgotten, 1);
  // The old account is gone while the new sign-in is in flight.
  assert.equal(manager.signInStatus(input).account, null);
});

test('a driver without interactive sign-in needs none, and refuses to start one', async () => {
  const { manager } = newManager();
  const plain = { driverId: 'plain', params: {} };
  assert.deepEqual(manager.signInStatus(plain), { required: false, account: null });
  await assert.rejects(() => manager.beginSignIn(plain), /no interactive sign-in/i);
});

test('openSignInPage opens the provider URL, and only that', async () => {
  const opened = [];
  const { manager } = newManager(async (url) => void opened.push(url));
  const started = await manager.beginSignIn(input);
  assert.equal(await manager.openSignInPage(started.flowId), true);
  assert.deepEqual(opened, ['https://microsoft.com/devicelogin']);
  // Nothing to open for an unknown flow.
  assert.equal(await manager.openSignInPage('signin-nope'), false);
});

test('a host with no browser reports false rather than failing', async () => {
  const { manager } = newManager();
  const started = await manager.beginSignIn(input);
  assert.equal(await manager.openSignInPage(started.flowId), false);
});

test('only Microsoft sign-in hosts are considered openable', () => {
  assert.equal(isAllowedSignInUrl('https://microsoft.com/devicelogin'), true);
  assert.equal(isAllowedSignInUrl('https://login.microsoftonline.com/common/oauth2/deviceauth'), true);
  assert.equal(isAllowedSignInUrl('https://login.microsoftonline.us/common'), true);
  assert.equal(isAllowedSignInUrl('http://microsoft.com/devicelogin'), false, 'http is not allowed');
  assert.equal(isAllowedSignInUrl('https://microsoft.com.evil.test/devicelogin'), false);
  assert.equal(isAllowedSignInUrl('file:///etc/passwd'), false);
  assert.equal(isAllowedSignInUrl('not a url'), false);
});

test('starting a new sign-in clears out settled flows', async () => {
  const { manager, complete } = newManager();
  const first = await manager.beginSignIn(input);
  complete();
  await new Promise((resolve) => setImmediate(resolve));
  const second = await manager.beginSignIn(input);
  assert.notEqual(second.flowId, first.flowId);
  assert.match(manager.pollSignIn(first.flowId).message, /no longer in progress/i);
});

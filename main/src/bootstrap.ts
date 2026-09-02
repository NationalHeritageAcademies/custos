import * as path from 'node:path';
import { DriverRegistry } from '@custos/core';
import { AzureSqlDriver } from '@custos/driver-azuresql';
import { MySqlDriver } from '@custos/driver-mysql';
import { ConnectionManager } from './engine';
import { JsonConnectionStore } from './store/json-connection-store';
import { SafeStorageSecretStore } from './store/safe-storage-secret-store';

/**
 * Wires the app's dependency graph. Adding a new database engine is one line
 * here plus its package — nothing else in the app changes. See CONTRIBUTING.md.
 */
export function buildRegistry(): DriverRegistry {
  const registry = new DriverRegistry();
  registry.register(new MySqlDriver());
  registry.register(new AzureSqlDriver());
  return registry;
}

/**
 * Build a ConnectionManager backed by on-disk, keychain-encrypted stores.
 * `openExternal` lets the engine send an identity provider's sign-in page to the
 * user's browser (Electron's `shell.openExternal`) without importing Electron
 * itself — see ConnectionManager.openSignInPage.
 */
export function buildConnectionManager(
  userDataDir: string,
  openExternal?: (url: string) => Promise<void>,
): ConnectionManager {
  const registry = buildRegistry();
  const connectionStore = new JsonConnectionStore(path.join(userDataDir, 'connections.json'));
  const secretStore = new SafeStorageSecretStore(path.join(userDataDir, 'secrets.bin'));
  return new ConnectionManager(registry, connectionStore, secretStore, openExternal);
}

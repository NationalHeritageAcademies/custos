import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { safeStorage } from 'electron';
import type { ConnectionSecrets } from '@custos/core';
import type { SecretStore } from '../engine/stores';

/**
 * Persists connection secrets encrypted at rest via Electron `safeStorage`,
 * which is backed by the OS keychain (macOS Keychain / Windows DPAPI /
 * libsecret). The on-disk file is an encrypted blob of a
 * `{ [connectionId]: secrets }` map. If the platform can't encrypt, we refuse
 * to write plaintext rather than silently downgrade security.
 */
export class SafeStorageSecretStore implements SecretStore {
  constructor(private readonly filePath: string) {}

  private async readMap(): Promise<Record<string, ConnectionSecrets>> {
    try {
      const buf = await fs.readFile(this.filePath);
      if (buf.length === 0) return {};
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('OS encryption is unavailable; cannot read stored secrets safely.');
      }
      return JSON.parse(safeStorage.decryptString(buf)) as Record<string, ConnectionSecrets>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
  }

  private async writeMap(map: Record<string, ConnectionSecrets>): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS encryption is unavailable; refusing to persist secrets in plaintext.');
    }
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, safeStorage.encryptString(JSON.stringify(map)));
  }

  async get(connectionId: string): Promise<ConnectionSecrets> {
    return (await this.readMap())[connectionId] ?? {};
  }

  async set(connectionId: string, secrets: ConnectionSecrets): Promise<void> {
    const map = await this.readMap();
    map[connectionId] = secrets;
    await this.writeMap(map);
  }

  async delete(connectionId: string): Promise<void> {
    const map = await this.readMap();
    delete map[connectionId];
    await this.writeMap(map);
  }
}

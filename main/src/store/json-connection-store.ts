import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { ConnectionConfig } from '@custos/core';
import type { ConnectionStore } from '../engine/stores';

/**
 * Persists non-secret connection metadata as a JSON array on disk. No Electron
 * dependency — the caller supplies the file path (Electron passes one under
 * `app.getPath('userData')`), so this is unit-testable with a temp file.
 */
export class JsonConnectionStore implements ConnectionStore {
  constructor(private readonly filePath: string) {}

  private async readAll(): Promise<ConnectionConfig[]> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as ConnectionConfig[]) : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  private async writeAll(configs: ConnectionConfig[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(configs, null, 2), 'utf8');
  }

  async list(): Promise<ConnectionConfig[]> {
    return this.readAll();
  }

  async get(id: string): Promise<ConnectionConfig | null> {
    return (await this.readAll()).find((c) => c.id === id) ?? null;
  }

  async save(config: ConnectionConfig): Promise<void> {
    const all = await this.readAll();
    const idx = all.findIndex((c) => c.id === config.id);
    if (idx >= 0) all[idx] = config;
    else all.push(config);
    await this.writeAll(all);
  }

  async delete(id: string): Promise<void> {
    await this.writeAll((await this.readAll()).filter((c) => c.id !== id));
  }
}

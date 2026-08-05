import type { ConnectionConfig, ConnectionSecrets } from '@custos/core';

/**
 * Persists non-secret connection metadata. The default implementation writes
 * JSON to the user-data directory; tests use the in-memory variant below.
 */
export interface ConnectionStore {
  list(): Promise<ConnectionConfig[]>;
  get(id: string): Promise<ConnectionConfig | null>;
  save(config: ConnectionConfig): Promise<void>;
  delete(id: string): Promise<void>;
}

/**
 * Persists secret connection values (passwords, tokens). The default
 * implementation encrypts via Electron `safeStorage` and stores in the OS
 * keychain; tests use the in-memory variant below. Secrets NEVER travel through
 * {@link ConnectionStore}.
 */
export interface SecretStore {
  get(connectionId: string): Promise<ConnectionSecrets>;
  set(connectionId: string, secrets: ConnectionSecrets): Promise<void>;
  delete(connectionId: string): Promise<void>;
}

export class InMemoryConnectionStore implements ConnectionStore {
  private readonly map = new Map<string, ConnectionConfig>();

  async list(): Promise<ConnectionConfig[]> {
    return [...this.map.values()];
  }
  async get(id: string): Promise<ConnectionConfig | null> {
    return this.map.get(id) ?? null;
  }
  async save(config: ConnectionConfig): Promise<void> {
    this.map.set(config.id, config);
  }
  async delete(id: string): Promise<void> {
    this.map.delete(id);
  }
}

export class InMemorySecretStore implements SecretStore {
  private readonly map = new Map<string, ConnectionSecrets>();

  async get(connectionId: string): Promise<ConnectionSecrets> {
    return this.map.get(connectionId) ?? {};
  }
  async set(connectionId: string, secrets: ConnectionSecrets): Promise<void> {
    this.map.set(connectionId, secrets);
  }
  async delete(connectionId: string): Promise<void> {
    this.map.delete(connectionId);
  }
}

import type { DatabaseDriver } from './driver';
import { DuplicateDriverError, UnknownDriverError } from './errors';

/**
 * Holds the set of available database drivers. The app builds one registry at
 * startup and registers each shipped driver into it; the rest of the app only
 * ever talks to drivers through this registry, keyed by driver id.
 */
export class DriverRegistry {
  private readonly drivers = new Map<string, DatabaseDriver>();

  register(driver: DatabaseDriver): void {
    const { id } = driver.metadata;
    if (this.drivers.has(id)) {
      throw new DuplicateDriverError(id);
    }
    this.drivers.set(id, driver);
  }

  get(id: string): DatabaseDriver {
    const driver = this.drivers.get(id);
    if (!driver) {
      throw new UnknownDriverError(id);
    }
    return driver;
  }

  has(id: string): boolean {
    return this.drivers.has(id);
  }

  list(): DatabaseDriver[] {
    return [...this.drivers.values()];
  }
}

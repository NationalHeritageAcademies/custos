/**
 * How each engine is shown in the UI: the two-letter badge and its colour.
 *
 * One table rather than a ternary at every call site, so adding an engine is a
 * single entry here — and so an engine nobody has taught the UI about still
 * renders something sensible instead of being mislabelled as another one.
 */
export interface DriverBadge {
  readonly label: string;
  readonly color: string;
}

const BADGES: Record<string, DriverBadge> = {
  azuresql: { label: 'AZ', color: '#2E8FD9' },
  mysql: { label: 'MY', color: '#C98A2E' },
  mongodb: { label: 'MG', color: '#13AA52' },
};

const UNKNOWN: DriverBadge = { label: '—', color: 'var(--text-3)' };

/** The badge for a driver id; a neutral placeholder when there is no driver. */
export function driverBadge(driverId?: string | null): DriverBadge {
  if (!driverId) return UNKNOWN;
  return BADGES[driverId] ?? { label: driverId.slice(0, 2).toUpperCase(), color: 'var(--text-3)' };
}

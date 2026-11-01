/**
 * Release drift across the fleet. Clients that run a different WrongStack than
 * the HQ hub can disagree on the wire protocol or miss features the dashboard
 * offers, so the hub's version is the reference; without it (an older server
 * or a dev build) only a mixed fleet is worth mentioning.
 */
import type { HqClientRecord } from '@wrongstack/hq';

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)/;

/** -1, 0 or 1; null when either side is not a release version. */
export function compareVersions(left: string, right: string): number | null {
  const a = SEMVER.exec(left);
  const b = SEMVER.exec(right);
  if (a === null || b === null) return null;
  for (let index = 1; index <= 3; index += 1) {
    const delta = Number(a[index]) - Number(b[index]);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}

export interface VersionDrift {
  /** The hub's version when it is a release, else undefined. */
  hub: string | undefined;
  /** Connected clients that reported a version. */
  reporting: number;
  /** Distinct client versions, newest first, with how many run each. */
  versions: { version: string; count: number }[];
  behind: HqClientRecord[];
  ahead: HqClientRecord[];
  /** More than one version in use, whatever the hub runs. */
  mixed: boolean;
}

const strip = (version: string): string => version.replace(/^v/, '');

export function versionDrift(
  clients: readonly HqClientRecord[],
  hubVersion: string | undefined,
): VersionDrift {
  const hub = hubVersion !== undefined && SEMVER.test(hubVersion) ? strip(hubVersion) : undefined;
  const counts = new Map<string, number>();
  const behind: HqClientRecord[] = [];
  const ahead: HqClientRecord[] = [];
  let reporting = 0;
  for (const client of clients) {
    if (!client.connected || client.version === undefined) continue;
    const version = strip(client.version);
    reporting += 1;
    counts.set(version, (counts.get(version) ?? 0) + 1);
    if (hub === undefined) continue;
    const order = compareVersions(version, hub);
    if (order === -1) behind.push(client);
    else if (order === 1) ahead.push(client);
  }
  const versions = [...counts]
    .map(([version, count]) => ({ version, count }))
    .sort(
      (a, b) => (compareVersions(b.version, a.version) ?? 0) || a.version.localeCompare(b.version),
    );
  return { hub, reporting, versions, behind, ahead, mixed: versions.length > 1 };
}

/** One line for the System panel. */
export function driftLine(drift: VersionDrift): { value: string; tone: 'ok' | 'warn' | 'muted' } {
  if (drift.reporting === 0) return { value: 'No client reported one', tone: 'muted' };
  if (drift.hub !== undefined) {
    const off = drift.behind.length + drift.ahead.length;
    if (off === 0) return { value: `All on ${drift.hub}`, tone: 'ok' };
    const parts: string[] = [];
    if (drift.behind.length > 0) parts.push(`${drift.behind.length} behind`);
    if (drift.ahead.length > 0) parts.push(`${drift.ahead.length} ahead`);
    return { value: `${parts.join(' · ')} of HQ ${drift.hub}`, tone: 'warn' };
  }
  if (!drift.mixed) return { value: `All on ${drift.versions[0]?.version}`, tone: 'ok' };
  return { value: `${drift.versions.length} versions in use`, tone: 'warn' };
}

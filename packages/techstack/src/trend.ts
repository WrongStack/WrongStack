/** Cross-snapshot dependency health and remediation trend analysis. */

import { compareVersions } from './policy/status.js';
import type { Snapshot } from './types.js';

export interface SnapshotSource {
  listSnapshots(projectId: string, limit?: number): Snapshot[];
}

export interface DependencyTrend {
  readonly key: string;
  readonly name: string;
  readonly ecosystem: string;
  readonly currentVersion?: string | undefined;
  readonly lockedVersionAgeMs: number;
  readonly versionChanges: number;
  readonly upgradeVelocityPerDay: number;
}

export interface TrendReport {
  readonly projectId: string;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly snapshots: number;
  readonly dependencies: readonly DependencyTrend[];
  readonly vulnerabilityHalfLifeMs?: number | undefined;
  readonly points: ReadonlyArray<{
    readonly snapshotId: string;
    readonly createdAt: string;
    readonly dependencies: number;
    readonly outdated: number;
    readonly vulnerable: number;
  }>;
}

/**
 * The highest of a package's sibling versions in one snapshot. Version order,
 * not string order: a lexical sort put `9.0.0` above `10.0.0` and
 * `2.0.0-rc.1` above `2.0.0`. Versions the comparator cannot read (git refs,
 * dist-tags) keep the string order between them.
 */
function highestVersion(sortedVersions: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const version of sortedVersions) {
    if (best === undefined) {
      best = version;
      continue;
    }
    let cmp: number;
    try {
      cmp = compareVersions(version, best);
    } catch {
      cmp = version > best ? 1 : -1;
    }
    if (cmp > 0) best = version;
  }
  return best;
}

function median(values: readonly number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) return undefined;
  if (sorted.length % 2) return upper;
  const lower = sorted[middle - 1];
  return lower === undefined ? upper : (lower + upper) / 2;
}

export class TrendStore {
  constructor(private readonly source: SnapshotSource) {}

  analyze(projectId: string, limit = 100): TrendReport {
    const parseTimestamp = (value: string): number => {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const snapshots = [...this.source.listSnapshots(projectId, limit)].sort(
      (a, b) => parseTimestamp(a.createdAt) - parseTimestamp(b.createdAt),
    );
    const packageWorkspaces = new Map<string, Set<string>>();
    for (const snapshot of snapshots) {
      for (const dependency of snapshot.dependencies) {
        const key = `${dependency.ecosystem}:${dependency.name}`;
        const workspaces = packageWorkspaces.get(key) ?? new Set<string>();
        workspaces.add(dependency.workspaceId);
        packageWorkspaces.set(key, workspaces);
      }
    }
    const versionHistory = new Map<
      string,
      Array<{
        at: number;
        version: string | undefined;
        versionKey: string;
        vulnerable: boolean;
        name: string;
        ecosystem: string;
      }>
    >();
    const vulnerabilityDurations: number[] = [];
    const openVulnerabilities = new Map<string, number>();
    for (const snapshot of snapshots) {
      const at = parseTimestamp(snapshot.createdAt);
      const active = new Set<string>();
      const vulnerableKeys = new Set<string>();
      const perSnapshot = new Map<
        string,
        {
          versions: Set<string>;
          directVersion: string | undefined;
          lastVersion: string | undefined;
          vulnerable: boolean;
          name: string;
          ecosystem: string;
        }
      >();
      for (const dependency of snapshot.dependencies) {
        const packageKey = `${dependency.ecosystem}:${dependency.name}`;
        const key =
          (packageWorkspaces.get(packageKey)?.size ?? 0) > 1
            ? JSON.stringify([packageKey, dependency.workspaceId])
            : packageKey;
        active.add(key);
        const vulnerable = dependency.status === 'vulnerable';
        const ver = dependency.locked ?? dependency.installed ?? dependency.requested;
        const entry = perSnapshot.get(key) ?? {
          versions: new Set<string>(),
          directVersion: undefined,
          lastVersion: undefined,
          vulnerable: false,
          name: dependency.name,
          ecosystem: dependency.ecosystem,
        };
        if (ver !== undefined) {
          entry.versions.add(ver);
          entry.lastVersion = ver;
          if (dependency.direct) entry.directVersion = ver;
        }
        if (vulnerable) {
          entry.vulnerable = true;
          vulnerableKeys.add(key);
        }
        perSnapshot.set(key, entry);
      }
      for (const [key, entry] of perSnapshot) {
        const sortedVersions = [...entry.versions].sort();
        const history = versionHistory.get(key) ?? [];
        history.push({
          at,
          version: entry.directVersion ?? highestVersion(sortedVersions) ?? entry.lastVersion,
          versionKey: sortedVersions.join('|'),
          vulnerable: entry.vulnerable,
          name: entry.name,
          ecosystem: entry.ecosystem,
        });
        versionHistory.set(key, history);
      }
      // A healthy sibling cannot resolve a package while another instance is vulnerable.
      for (const key of active) {
        const vulnerable = vulnerableKeys.has(key);
        if (vulnerable && !openVulnerabilities.has(key)) openVulnerabilities.set(key, at);
        if (!vulnerable && openVulnerabilities.has(key)) {
          const openedAt = openVulnerabilities.get(key);
          if (openedAt !== undefined) vulnerabilityDurations.push(Math.max(0, at - openedAt));
          openVulnerabilities.delete(key);
        }
      }
      for (const key of openVulnerabilities.keys()) {
        if (!active.has(key)) {
          const openedAt = openVulnerabilities.get(key);
          if (openedAt !== undefined) vulnerabilityDurations.push(Math.max(0, at - openedAt));
          openVulnerabilities.delete(key);
        }
      }
    }
    const dependencies: DependencyTrend[] = [];
    for (const [key, history] of versionHistory) {
      const first = history[0];
      const latest = history.at(-1);
      if (!first || !latest) continue;
      let versionChanges = 0;
      let sameVersionSince = first.at;
      for (let index = 1; index < history.length; index++) {
        const current = history[index];
        const previous = history[index - 1];
        if (current && previous && current.versionKey !== previous.versionKey) {
          versionChanges++;
          sameVersionSince = current.at;
        }
      }
      const spanDays = Math.max(1, (latest.at - first.at) / 86_400_000);
      dependencies.push({
        key,
        name: latest.name,
        ecosystem: latest.ecosystem,
        ...(latest.version ? { currentVersion: latest.version } : {}),
        lockedVersionAgeMs: Math.max(0, latest.at - sameVersionSince),
        versionChanges,
        upgradeVelocityPerDay: versionChanges / spanDays,
      });
    }
    dependencies.sort((a, b) => a.key.localeCompare(b.key));
    const halfLife = median(vulnerabilityDurations);
    const firstSnapshot = snapshots[0];
    const lastSnapshot = snapshots.at(-1);
    return {
      projectId,
      ...(firstSnapshot && lastSnapshot
        ? { from: firstSnapshot.createdAt, to: lastSnapshot.createdAt }
        : {}),
      snapshots: snapshots.length,
      dependencies,
      ...(halfLife !== undefined ? { vulnerabilityHalfLifeMs: halfLife } : {}),
      points: snapshots.map((snapshot) => ({
        snapshotId: snapshot.id,
        createdAt: snapshot.createdAt,
        dependencies: snapshot.dependencies.length,
        outdated: snapshot.dependencies.filter((dependency) =>
          dependency.status.startsWith('update_available'),
        ).length,
        vulnerable: snapshot.dependencies.filter((dependency) => dependency.status === 'vulnerable')
          .length,
      })),
    };
  }
}

export function renderTrendMarkdown(report: TrendReport): string {
  const lines = ['# TechStack Trend', '', `**Snapshots:** ${report.snapshots}`];
  if (report.vulnerabilityHalfLifeMs !== undefined)
    lines.push(
      `**Vulnerability half-life:** ${(report.vulnerabilityHalfLifeMs / 86_400_000).toFixed(1)} days`,
    );
  lines.push(
    '',
    '| Dependency | Version | Age (days) | Changes | Velocity/day |',
    '|---|---|---:|---:|---:|',
  );
  for (const dependency of report.dependencies) {
    lines.push(
      `| ${dependency.ecosystem}:${dependency.name} | ${dependency.currentVersion ?? '—'} | ${(dependency.lockedVersionAgeMs / 86_400_000).toFixed(1)} | ${dependency.versionChanges} | ${dependency.upgradeVelocityPerDay.toFixed(3)} |`,
    );
  }
  return lines.join('\n');
}

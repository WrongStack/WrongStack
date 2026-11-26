import { describe, expect, it } from 'vitest';
import { TrendStore } from '../src/trend.js';
import type { DependencyObservation, Snapshot } from '../src/types.js';

const dayMs = 86_400_000;
function dep(
  locked: string,
  status: DependencyObservation['status'],
  workspaceId = 'ws',
): DependencyObservation {
  return {
    id: `${workspaceId}-${locked}`,
    workspaceId,
    ecosystem: 'npm',
    name: 'example',
    sourceType: 'registry',
    direct: false,
    scope: 'transitive',
    locked,
    status,
    evidence: [],
  };
}
function snapshot(day: number, dependencies: readonly DependencyObservation[]): Snapshot {
  return {
    id: `s${day}`,
    projectId: 'project',
    targetRoot: '.',
    fingerprint: `fixed-${day}`,
    createdAt: new Date(Date.UTC(2026, 0, 1) + day * dayMs).toISOString(),
    adapterVersion: '1.1.0',
    coverage: 'full',
    workspaces: [],
    findings: [],
    dependencies,
  };
}
function analyze(snapshots: Snapshot[]) {
  return new TrendStore({ listSnapshots: () => [...snapshots].reverse() }).analyze('project');
}

const vulnerable = dep('1.0.0', 'vulnerable');
const healthy = dep('2.0.0', 'current');

describe('vulnerability intervals across package instances', () => {
  it.each([false, true])('waits for the last vulnerable instance; reversed=%s', (reversed) => {
    const rows = reversed ? [healthy, vulnerable] : [vulnerable, healthy];
    const report = analyze([snapshot(0, rows), snapshot(1, rows), snapshot(2, [healthy])]);
    expect(report.vulnerabilityHalfLifeMs).toBe(2 * dayMs);
    expect(report.points.map((point) => point.vulnerable)).toEqual([1, 1, 0]);
  });

  it.each([false, true])(
    'does not invent a resolved interval while vulnerable; reversed=%s',
    (reversed) => {
      const rows = reversed ? [healthy, vulnerable] : [vulnerable, healthy];
      const report = analyze([snapshot(0, rows), snapshot(2, rows)]);
      expect(report.vulnerabilityHalfLifeMs).toBeUndefined();
      expect(report.points.map((point) => point.vulnerable)).toEqual([1, 1]);
    },
  );

  it('closes an interval when the whole package disappears', () => {
    const report = analyze([snapshot(0, [vulnerable, healthy]), snapshot(3, [])]);
    expect(report.vulnerabilityHalfLifeMs).toBe(3 * dayMs);
  });

  it('retains workspace isolation when a healthy sibling is elsewhere', () => {
    const vulnerableHere = dep('1.0.0', 'vulnerable', 'workspace-a');
    const healthyElsewhere = dep('2.0.0', 'current', 'workspace-b');
    const report = analyze([
      snapshot(0, [vulnerableHere, healthyElsewhere]),
      snapshot(2, [dep('2.0.0', 'current', 'workspace-a'), healthyElsewhere]),
    ]);
    expect(report.vulnerabilityHalfLifeMs).toBe(2 * dayMs);
  });

  it('preserves single-instance resolution', () => {
    expect(
      analyze([snapshot(0, [vulnerable]), snapshot(2, [healthy])]).vulnerabilityHalfLifeMs,
    ).toBe(2 * dayMs);
  });

  it('does not fabricate a duration for empty history', () => {
    const report = analyze([]);
    expect(report.vulnerabilityHalfLifeMs).toBeUndefined();
    expect(report.points).toEqual([]);
  });

  it('does not count intra-snapshot sibling versions as sequential version changes across identical snapshots (F162)', () => {
    const report = analyze([
      snapshot(0, [vulnerable, healthy]),
      snapshot(2, [vulnerable, healthy]),
    ]);
    expect(report.dependencies[0]).toMatchObject({
      key: 'npm:example',
      versionChanges: 0,
      lockedVersionAgeMs: 2 * dayMs,
      upgradeVelocityPerDay: 0,
    });
  });
});

describe('currentVersion among sibling instances in one snapshot', () => {
  const currentOf = (versions: string[]) =>
    analyze([
      snapshot(
        0,
        versions.map((v) => dep(v, 'current')),
      ),
    ]).dependencies[0]?.currentVersion;

  it('reports the highest version by version order, not string order', () => {
    expect(currentOf(['1.0.0', '2.0.0'])).toBe('2.0.0');
    expect(currentOf(['9.0.0', '10.0.0'])).toBe('10.0.0');
    expect(currentOf(['10.0.0', '9.0.0'])).toBe('10.0.0');
    expect(currentOf(['2.0.0', '2.0.0-rc.1'])).toBe('2.0.0');
  });

  it('keeps string order for versions the comparator cannot read', () => {
    expect(currentOf(['main', 'feature'])).toBe('main');
  });
});

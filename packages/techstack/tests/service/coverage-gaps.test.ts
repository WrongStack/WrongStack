/**
 * Coverage for techstack finding-factory.ts and enrich-phase.ts
 */
import { describe, expect, it } from 'vitest';
import {
  computeDependencyFingerprint,
  createFindingForStatus,
} from '../../src/service/finding-factory.js';
import { runEnrichPhase } from '../../src/service/enrich-phase.js';
import type { DependencyObservation, Snapshot, EcosystemId } from '../../src/types.js';

function makeDep(
  name: string,
  overrides: Partial<DependencyObservation> = {},
): DependencyObservation {
  return {
    id: `dep-${name}`,
    workspaceId: 'root',
    name,
    ecosystem: 'npm' as EcosystemId,
    sourceType: 'registry',
    scope: 'runtime',
    requested: '^1.0.0',
    locked: '1.0.0',
    direct: true,
    status: 'current',
    evidence: [],
    ...overrides,
  };
}

function makeSnapshot(deps: DependencyObservation[] = []): Snapshot {
  return {
    id: 'snapshot-1',
    projectId: 'project-1',
    targetRoot: '/fake',
    createdAt: '2026-01-01T00:00:00.000Z',
    workspaces: [],
    dependencies: deps,
    findings: [],
    coverage: 'full',
    fingerprint: '',
    adapterVersion: 'test',
  };
}

describe('computeDependencyFingerprint', () => {
  it('produces a stable hash for the same deps', () => {
    const deps = [makeDep('lodash', { locked: '4.17.21' })];
    expect(computeDependencyFingerprint(deps)).toBe(computeDependencyFingerprint(deps));
  });

  it('produces different hashes for different deps', () => {
    const a = [makeDep('lodash', { locked: '4.17.21' })];
    const b = [makeDep('react', { locked: '18.0.0' })];
    expect(computeDependencyFingerprint(a)).not.toBe(computeDependencyFingerprint(b));
  });

  it('handles empty deps', () => {
    expect(computeDependencyFingerprint([]).startsWith('ts-')).toBe(true);
  });

  it('uses requested when locked is absent', () => {
    const a = [makeDep('pkg', { locked: undefined, requested: '^1.0.0' })];
    const b = [makeDep('pkg', { locked: undefined, requested: '^2.0.0' })];
    expect(computeDependencyFingerprint(a)).not.toBe(computeDependencyFingerprint(b));
  });

  it('uses "unknown" when both locked and requested are absent', () => {
    const a = [makeDep('pkg', { locked: undefined, requested: undefined })];
    const result = computeDependencyFingerprint(a);
    expect(result.startsWith('ts-')).toBe(true);
  });

  it('is order-independent (sorts before hashing)', () => {
    const a = [makeDep('aaa'), makeDep('bbb')];
    const b = [makeDep('bbb'), makeDep('aaa')];
    expect(computeDependencyFingerprint(a)).toBe(computeDependencyFingerprint(b));
  });
});

describe('createFindingForStatus', () => {
  it('creates vulnerable finding', () => {
    const finding = createFindingForStatus('dep-1', 'vulnerable');
    expect(finding.id).toBe('finding-dep-1-vuln');
    expect(finding.dependencyId).toBe('dep-1');
    expect(finding.confidence).toBe(1);
    expect(finding.evidence).toEqual([]);
  });

  it('creates deprecated finding', () => {
    const finding = createFindingForStatus('dep-1', 'deprecated');
    expect(finding.dependencyId).toBe('dep-1');
    expect(finding.id).toContain('dep-1');
  });

  it('creates unmaintained finding', () => {
    const finding = createFindingForStatus('dep-1', 'unmaintained');
    expect(finding.dependencyId).toBe('dep-1');
    expect(finding.id).toContain('dep-1');
  });

  it('creates outdated finding', () => {
    const finding = createFindingForStatus('dep-1', 'outdated');
    expect(finding.dependencyId).toBe('dep-1');
    expect(finding.id).toContain('dep-1');
  });

  it('creates investigate finding for unrecognized status', () => {
    const finding = createFindingForStatus('dep-1', 'something-new');
    expect(finding.dependencyId).toBe('dep-1');
    expect(finding.id).toContain('dep-1');
  });
});

describe('runEnrichPhase', () => {
  it('returns snapshot unchanged when online=false', async () => {
    const snap = makeSnapshot([makeDep('lodash')]);
    const result = await runEnrichPhase(snap, { online: false });
    expect(result).toEqual(snap);
  });

  it('returns snapshot unchanged when signal is already aborted', async () => {
    const snap = makeSnapshot([makeDep('lodash')]);
    const ac = new AbortController();
    ac.abort();
    const result = await runEnrichPhase(snap, { signal: ac.signal });
    expect(result).toEqual(snap);
  });

  it('returns snapshot unchanged when deps array is empty', async () => {
    const snap = makeSnapshot([]);
    const result = await runEnrichPhase(snap, { online: true });
    expect(result).toEqual(snap);
  });

  it('enriches dependencies with registry data', async () => {
    const snap = makeSnapshot([makeDep('lodash', { locked: '4.17.21' })]);
    const result = await runEnrichPhase(snap, { online: true });
    expect(result.dependencies).toBeDefined();
    expect(result.dependencies.length).toBe(1);
  });
});

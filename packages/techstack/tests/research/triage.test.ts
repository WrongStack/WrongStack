/**
 * TechStack — Research triage tests.
 *
 * Triage is the stage that keeps research affordable on a real monorepo, so
 * the properties under test are: only researchable statuses are selected, the
 * ranking is severity-driven and deterministic, duplicates across workspaces
 * collapse to one question, and the cap holds.
 *
 * @see packages/techstack/src/research/triage.ts
 */

import { describe, it, expect } from 'vitest';
import { clusterCandidates, triageCandidates } from '../../src/research/triage.js';
import type { DependencyObservation, DependencyStatus } from '../../src/types.js';

function makeDep(overrides: Partial<DependencyObservation> = {}): DependencyObservation {
  return {
    id: overrides.id ?? `dep-${overrides.name ?? 'x'}-${overrides.locked ?? '1.0.0'}`,
    workspaceId: 'ws-1',
    ecosystem: 'npm',
    name: 'pkg',
    sourceType: 'registry',
    direct: true,
    scope: 'runtime',
    locked: '1.0.0',
    status: 'current',
    evidence: [],
    ...overrides,
  };
}

describe('triageCandidates — selection', () => {
  it('selects only statuses that need interpretation', () => {
    const researchable: DependencyStatus[] = [
      'vulnerable',
      'yanked',
      'deprecated',
      'unmaintained_suspected',
      'update_available_breaking',
    ];
    const deps = researchable.map((status) => makeDep({ name: status, status }));

    expect(triageCandidates(deps)).toHaveLength(researchable.length);
  });

  it('ignores statuses the registry already answered or cannot answer', () => {
    const skipped: DependencyStatus[] = [
      'current',
      'update_available_safe',
      'private_or_unresolved',
      'unknown',
      'local_path',
      'git_dependency',
      'unsupported',
      'blocked_by_constraints',
    ];
    const deps = skipped.map((status) => makeDep({ name: status, status }));

    expect(triageCandidates(deps)).toEqual([]);
  });

  it('skips path and git deps even when they carry a researchable status', () => {
    const deps = [
      makeDep({ name: 'local', status: 'deprecated', sourceType: 'path' }),
      makeDep({ name: 'forked', status: 'vulnerable', sourceType: 'git' }),
    ];

    expect(triageCandidates(deps)).toEqual([]);
  });

  it('maps each status to its finding-type cluster', () => {
    const deps = [
      makeDep({ name: 'a', status: 'vulnerable' }),
      makeDep({ name: 'b', status: 'deprecated' }),
      makeDep({ name: 'c', status: 'update_available_breaking' }),
    ];

    const byName = new Map(triageCandidates(deps).map((c) => [c.dependency.name, c.cluster]));
    expect(byName.get('a')).toBe('vulnerability');
    expect(byName.get('b')).toBe('replacement');
    expect(byName.get('c')).toBe('breaking_change');
  });
});

describe('triageCandidates — ranking', () => {
  it('ranks by severity', () => {
    const deps = [
      makeDep({ name: 'breaking', status: 'update_available_breaking' }),
      makeDep({ name: 'vuln', status: 'vulnerable' }),
      makeDep({ name: 'deprecated', status: 'deprecated' }),
    ];

    expect(triageCandidates(deps).map((c) => c.dependency.name)).toEqual([
      'vuln',
      'deprecated',
      'breaking',
    ]);
  });

  it('ranks an exploitable transitive dep above a direct major bump', () => {
    const deps = [
      makeDep({ name: 'direct-major', status: 'update_available_breaking', direct: true }),
      makeDep({
        name: 'transitive-vuln',
        status: 'vulnerable',
        direct: false,
        scope: 'transitive',
      }),
    ];

    expect(triageCandidates(deps)[0]?.dependency.name).toBe('transitive-vuln');
  });

  it('prefers direct over transitive at equal severity', () => {
    const deps = [
      makeDep({ name: 'a-transitive', status: 'deprecated', direct: false, scope: 'transitive' }),
      makeDep({ name: 'b-direct', status: 'deprecated', direct: true }),
    ];

    expect(triageCandidates(deps)[0]?.dependency.name).toBe('b-direct');
  });

  it('breaks ties by name so ordering never depends on adapter output order', () => {
    const forward = [
      makeDep({ name: 'zeta', status: 'deprecated' }),
      makeDep({ name: 'alpha', status: 'deprecated' }),
    ];
    const reversed = [...forward].reverse();

    const names = (deps: DependencyObservation[]) =>
      triageCandidates(deps).map((c) => c.dependency.name);
    expect(names(forward)).toEqual(['alpha', 'zeta']);
    expect(names(reversed)).toEqual(['alpha', 'zeta']);
  });
});

describe('triageCandidates — dedup', () => {
  it('collapses the same package hoisted across workspaces into one question', () => {
    const deps = [
      makeDep({
        id: 'a',
        workspaceId: 'ws-1',
        name: 'lodash',
        locked: '4.17.20',
        status: 'vulnerable',
      }),
      makeDep({
        id: 'b',
        workspaceId: 'ws-2',
        name: 'lodash',
        locked: '4.17.20',
        status: 'vulnerable',
      }),
      makeDep({
        id: 'c',
        workspaceId: 'ws-3',
        name: 'lodash',
        locked: '4.17.20',
        status: 'vulnerable',
      }),
    ];

    expect(triageCandidates(deps)).toHaveLength(1);
  });

  it('keeps the actionable copy when a package is both direct and transitive', () => {
    const deps = [
      makeDep({
        id: 'transitive',
        name: 'lodash',
        status: 'vulnerable',
        direct: false,
        scope: 'transitive',
      }),
      makeDep({ id: 'direct', name: 'lodash', status: 'vulnerable', direct: true }),
    ];

    const candidates = triageCandidates(deps);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.dependency.id).toBe('direct');
  });

  it('treats different resolved versions of one package as separate questions', () => {
    const deps = [
      makeDep({ id: 'r17', name: 'react', locked: '17.0.2', status: 'update_available_breaking' }),
      makeDep({ id: 'r18', name: 'react', locked: '18.2.0', status: 'update_available_breaking' }),
    ];

    expect(triageCandidates(deps)).toHaveLength(2);
  });
});

describe('triageCandidates — cap', () => {
  it('caps the result and keeps the highest-priority candidates', () => {
    const deps = [
      ...Array.from({ length: 50 }, (_, i) =>
        makeDep({
          id: `low-${i}`,
          name: `low-${String(i).padStart(2, '0')}`,
          status: 'update_available_breaking',
        }),
      ),
      makeDep({ id: 'critical', name: 'critical', status: 'vulnerable' }),
    ];

    const candidates = triageCandidates(deps, { limit: 3 });
    expect(candidates).toHaveLength(3);
    expect(candidates[0]?.dependency.name).toBe('critical');
  });

  it('returns nothing when the cap is zero', () => {
    expect(triageCandidates([makeDep({ status: 'vulnerable' })], { limit: 0 })).toEqual([]);
  });

  it('handles an empty inventory', () => {
    expect(triageCandidates([])).toEqual([]);
  });
});

describe('clusterCandidates', () => {
  it('groups candidates by cluster, preserving triage order within each', () => {
    const deps = [
      makeDep({ name: 'vuln-a', status: 'vulnerable' }),
      makeDep({ name: 'dep-a', status: 'deprecated' }),
      makeDep({ name: 'vuln-b', status: 'vulnerable' }),
    ];

    const grouped = clusterCandidates(triageCandidates(deps));
    expect(grouped.get('vulnerability')?.map((c) => c.dependency.name)).toEqual([
      'vuln-a',
      'vuln-b',
    ]);
    expect(grouped.get('replacement')?.map((c) => c.dependency.name)).toEqual(['dep-a']);
    expect(grouped.has('breaking_change')).toBe(false);
  });
});

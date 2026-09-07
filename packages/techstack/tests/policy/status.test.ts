/**
 * TechStack — Status classification tests.
 *
 * Tests the classifyStatus function and its helper compareVersions.
 * Covers all rules from SDD R8/R9:
 * - Private/unresolved (404/401) → private_or_unresolved (never dead)
 * - Failed lookup → unknown (never current)
 * - Deprecated → deprecated
 * - Yanked → yanked
 * - Advisory → vulnerable
 * - Version comparisons
 *
 * @see packages/techstack/src/policy/status.ts
 */

import { describe, expect, it } from 'vitest';
import type { AdvisoryStatusData, RegistryStatusData } from '../../src/policy/status.js';
import {
  classifyStatus,
  compareVersions,
  failedLookupStatus,
  privateOrUnresolvedStatus,
} from '../../src/policy/status.js';

// ── Helper factories ───────────────────────────────────────────────────────

function makeDep(overrides: Record<string, unknown> = {}) {
  return {
    name: 'test-pkg',
    sourceType: 'registry',
    status: 'current',
    locked: '1.0.0',
    requested: '^1.0.0',
    ...overrides,
  } as const;
}

// ── compareVersions ────────────────────────────────────────────────────────

describe('compareVersions', () => {
  it('returns -1 when a < b', () => {
    expect(compareVersions('1.0.0', '2.0.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.1.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
  });

  it('returns 0 when a === b', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('2.5.3', '2.5.3')).toBe(0);
  });

  it('returns 1 when a > b', () => {
    expect(compareVersions('2.0.0', '1.0.0')).toBe(1);
    expect(compareVersions('1.1.0', '1.0.0')).toBe(1);
    expect(compareVersions('1.0.1', '1.0.0')).toBe(1);
  });

  it('handles prerelease versions', () => {
    expect(compareVersions('1.0.0-alpha', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0-alpha')).toBe(1);
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
  });
});

// ── classifyStatus — Source type rules ─────────────────────────────────────

describe('classifyStatus — source type', () => {
  it('returns local_path for path source type', () => {
    const result = classifyStatus(makeDep({ sourceType: 'path' }));
    expect(result).toBe('local_path');
  });

  it('returns git_dependency for git source type', () => {
    const result = classifyStatus(makeDep({ sourceType: 'git' }));
    expect(result).toBe('git_dependency');
  });
});

// ── classifyStatus — Private/unresolved ────────────────────────────────────

describe('classifyStatus — private/unresolved (R8)', () => {
  it('returns private_or_unresolved when registry returns 404/401', () => {
    const registryData: RegistryStatusData = {
      privateOrUnresolved: true,
    };
    const result = classifyStatus(makeDep(), registryData);
    expect(result).toBe('private_or_unresolved');
  });

  it('never returns dead or deprecated for private packages', () => {
    const registryData: RegistryStatusData = {
      privateOrUnresolved: true,
      deprecated: true, // should be ignored
    };
    const dep = makeDep({ sourceType: 'registry', status: 'current' });
    const result = classifyStatus(dep, registryData);
    expect(result).not.toBe('deprecated');
    expect(result).toBe('private_or_unresolved');
  });
});

// ── classifyStatus — Failed lookup ─────────────────────────────────────────

describe('classifyStatus — failed lookup (R9)', () => {
  it('returns unknown when registry lookup failed', () => {
    const registryData: RegistryStatusData = {
      lookupFailed: true,
    };
    const result = classifyStatus(makeDep(), registryData);
    expect(result).toBe('unknown');
  });

  it('never returns current for failed lookups', () => {
    const registryData: RegistryStatusData = {
      lookupFailed: true,
      latestStable: '2.0.0', // should be ignored
    };
    const dep = makeDep({ status: 'current', locked: '1.0.0' });
    const result = classifyStatus(dep, registryData);
    expect(result).not.toBe('current');
    expect(result).toBe('unknown');
  });
});

// ── classifyStatus — Deprecated / Yanked ───────────────────────────────────

describe('classifyStatus — deprecated / yanked', () => {
  it('returns deprecated when registry says deprecated', () => {
    const registryData: RegistryStatusData = { deprecated: true };
    const result = classifyStatus(makeDep(), registryData);
    expect(result).toBe('deprecated');
  });

  it('returns yanked when registry says yanked', () => {
    const registryData: RegistryStatusData = { yanked: true };
    const result = classifyStatus(makeDep(), registryData);
    expect(result).toBe('yanked');
  });
});

// ── classifyStatus — Vulnerable ────────────────────────────────────────────

describe('classifyStatus — vulnerable', () => {
  it('returns vulnerable when advisory exists', () => {
    const advisoryData: AdvisoryStatusData = { hasAdvisory: true };
    const result = classifyStatus(makeDep(), undefined, advisoryData);
    expect(result).toBe('vulnerable');
  });
});

// ── classifyStatus — Version comparison ────────────────────────────────────

describe('classifyStatus — version comparison', () => {
  it('returns current when locked === latestStable', () => {
    const registryData: RegistryStatusData = { latestStable: '1.0.0' };
    const dep = makeDep({ locked: '1.0.0', requested: '^1.0.0' });
    const result = classifyStatus(dep, registryData);
    expect(result).toBe('current');
  });

  it('returns update_available_safe when locked < latestStable and within constraint', () => {
    const registryData: RegistryStatusData = { latestStable: '1.1.0' };
    const dep = makeDep({ locked: '1.0.0', requested: '^1.0.0' });
    const result = classifyStatus(dep, registryData);
    expect(result).toBe('update_available_safe');
  });

  it('returns update_available_breaking when major version changes with ^ constraint', () => {
    const registryData: RegistryStatusData = { latestStable: '2.0.0' };
    const dep = makeDep({ locked: '1.0.0', requested: '^1.0.0' });
    const result = classifyStatus(dep, registryData);
    expect(result).toBe('update_available_breaking');
  });

  // An exact pin means "don't move without a decision" — a manifest question,
  // not a compatibility one. Reading every pinned patch release as breaking
  // marked most of a pin-heavy repo as needing a major upgrade.
  it('treats a patch bump under an exact pin as safe, not breaking', () => {
    const registryData: RegistryStatusData = { latestStable: '2.5.4' };
    const dep = makeDep({ locked: '2.5.3', requested: '2.5.3' });
    expect(classifyStatus(dep, registryData)).toBe('update_available_safe');
  });

  it('treats a minor bump under an exact pin as safe', () => {
    const registryData: RegistryStatusData = { latestStable: '2.6.0' };
    const dep = makeDep({ locked: '2.5.3', requested: '2.5.3' });
    expect(classifyStatus(dep, registryData)).toBe('update_available_safe');
  });

  it('still reports breaking for a major bump under an exact pin', () => {
    const registryData: RegistryStatusData = { latestStable: '3.0.0' };
    const dep = makeDep({ locked: '2.5.3', requested: '2.5.3' });
    expect(classifyStatus(dep, registryData)).toBe('update_available_breaking');
  });
});

// ── Helper factory tests ───────────────────────────────────────────────────

describe('privateOrUnresolvedStatus', () => {
  it('creates status data with privateOrUnresolved flag', () => {
    const data = privateOrUnresolvedStatus('https://registry.example.org/pkg');
    expect(data.privateOrUnresolved).toBe(true);
    expect(data.lookupFailed).toBeUndefined();
    expect(data.evidence).toHaveLength(1);
    expect(data.evidence![0]!.kind).toBe('registry');
  });
});

describe('failedLookupStatus', () => {
  it('creates status data with lookupFailed flag', () => {
    const data = failedLookupStatus('https://registry.example.org/pkg', 'ECONNREFUSED');
    expect(data.lookupFailed).toBe(true);
    expect(data.privateOrUnresolved).toBeUndefined();
    expect(data.evidence).toHaveLength(1);
    expect(data.evidence![0]!.detail).toContain('ECONNREFUSED');
  });
});

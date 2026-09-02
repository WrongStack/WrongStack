import { describe, it, expect } from 'vitest';
import {
  mapEcosystem,
  deriveCoverage,
  workspaceId,
  computeFingerprint,
} from '../src/discovery/index.js';
import {
  parseNpmPackument,
  supportedRegistryEcosystems,
  clearRegistryCache,
  invalidateRegistryCache,
} from '../src/registry/client.js';
import type { Snapshot, DependencyObservation, Finding, Workspace } from '../src/types.js';
import { TechStackEngine } from '../src/service.js';

// ── discovery/index.ts pure functions ─────────────────────────────────

describe('mapEcosystem', () => {
  it('maps well-known language names', () => {
    expect(mapEcosystem('typescript')).toBe('npm');
    expect(mapEcosystem('javascript')).toBe('npm');
    expect(mapEcosystem('python')).toBe('python');
    expect(mapEcosystem('rust')).toBe('rust');
    expect(mapEcosystem('go')).toBe('go');
    expect(mapEcosystem('csharp')).toBe('dotnet');
    expect(mapEcosystem('php')).toBe('php');
    expect(mapEcosystem('dart')).toBe('dart');
    expect(mapEcosystem('java')).toBe('maven');
    expect(mapEcosystem('ruby')).toBe('ruby');
    expect(mapEcosystem('elixir')).toBe('elixir');
    expect(mapEcosystem('cpp')).toBe('cpp');
    expect(mapEcosystem('c++')).toBe('cpp');
    expect(mapEcosystem('swift')).toBe('swift');
  });

  it('is case-insensitive', () => {
    expect(mapEcosystem('TypeScript')).toBe('npm');
    expect(mapEcosystem('RUST')).toBe('rust');
  });

  it('returns undefined for unknown languages', () => {
    expect(mapEcosystem('brainfuck')).toBeUndefined();
    expect(mapEcosystem('')).toBeUndefined();
  });
});

describe('deriveCoverage', () => {
  it('returns unsupported for undefined ecosystem', () => {
    expect(deriveCoverage(undefined, 0.9)).toBe('unsupported');
  });
  it('returns unsupported when confidence < 0.3', () => {
    expect(deriveCoverage('npm', 0.2)).toBe('unsupported');
  });
  it('returns partial when 0.3 <= confidence < 0.7', () => {
    expect(deriveCoverage('npm', 0.5)).toBe('partial');
  });
  it('returns full when confidence >= 0.7', () => {
    expect(deriveCoverage('npm', 0.8)).toBe('full');
    expect(deriveCoverage('npm', 1.0)).toBe('full');
  });
});

describe('workspaceId', () => {
  it('produces a stable ws- prefixed hash', () => {
    const id = workspaceId('packages/cli', 'npm');
    expect(id).toMatch(/^ws-[0-9a-f]{12}$/);
    expect(workspaceId('packages/cli', 'npm')).toBe(id);
  });
  it('different inputs produce different ids', () => {
    expect(workspaceId('a', 'npm')).not.toBe(workspaceId('b', 'npm'));
    expect(workspaceId('a', 'npm')).not.toBe(workspaceId('a', 'rust'));
  });
});

describe('computeFingerprint', () => {
  it('hashes file contents deterministically', () => {
    const fp = computeFingerprint(['file1', 'file2']);
    expect(fp).toHaveLength(16);
    expect(computeFingerprint(['file1', 'file2'])).toBe(fp);
  });
  it('changes when contents change', () => {
    expect(computeFingerprint(['a'])).not.toBe(computeFingerprint(['b']));
  });
  it('uses a separator so order matters', () => {
    // 'a\nb' vs 'a' + '\n' + 'b' — these differ with a separator
    expect(computeFingerprint(['a', 'b'])).not.toBe(computeFingerprint(['ab']));
  });
});

// ── registry/client.ts pure functions ─────────────────────────────────

describe('parseNpmPackument', () => {
  it('extracts latest version and license', () => {
    const entry = parseNpmPackument(
      {
        'dist-tags': { latest: '1.2.3' },
        license: 'MIT',
        versions: {},
      },
      'test-pkg',
    );
    expect(entry.latestStable).toBe('1.2.3');
    expect(entry.license).toBe('MIT');
    expect(entry.deprecated).toBeUndefined();
    expect(entry.source).toContain('test-pkg');
  });

  it('detects deprecation of the latest version', () => {
    const entry = parseNpmPackument(
      {
        'dist-tags': { latest: '2.0.0' },
        versions: {
          '2.0.0': { deprecated: 'Use v3 instead' },
        },
      },
      'dead-pkg',
    );
    expect(entry.deprecated).toBe(true);
  });

  it('does NOT flag deprecation on old versions only', () => {
    const entry = parseNpmPackument(
      {
        'dist-tags': { latest: '2.0.0' },
        versions: {
          '1.0.0': { deprecated: 'old' },
          '2.0.0': {},
        },
      },
      'pkg',
    );
    expect(entry.deprecated).toBeUndefined();
  });

  it('handles missing dist-tags', () => {
    const entry = parseNpmPackument({}, 'pkg');
    expect(entry.latestStable).toBeUndefined();
  });
});

describe('supportedRegistryEcosystems', () => {
  it('lists all configured ecosystems', () => {
    const ecosystems = supportedRegistryEcosystems();
    expect(ecosystems).toContain('npm');
    expect(ecosystems).toContain('python');
    expect(ecosystems).toContain('cargo');
    expect(ecosystems).toContain('golang');
    expect(ecosystems).toContain('nuget');
    expect(ecosystems).toContain('composer');
    expect(ecosystems).toContain('pub');
  });
});

describe('clearRegistryCache', () => {
  it('does not throw', () => {
    expect(() => clearRegistryCache()).not.toThrow();
  });
});

describe('invalidateRegistryCache', () => {
  it('is scoped and safe for empty or unsupported ecosystems', () => {
    expect(invalidateRegistryCache('npm', ['not-cached'])).toBe(0);
    expect(invalidateRegistryCache('unsupported')).toBe(0);
  });
});

// ── service.ts: generateReport ────────────────────────────────────────

function dep(overrides: Partial<DependencyObservation> & { id: string }): DependencyObservation {
  return {
    workspaceId: 'ws-1',
    ecosystem: 'npm',
    name: overrides.id,
    sourceType: 'registry',
    direct: true,
    scope: 'runtime',
    status: 'current',
    evidence: [{ kind: 'manifest', source: 'pkg.json', retrievedAt: '2026-01-01T00:00:00Z' }],
    ...overrides,
  };
}

function finding(overrides: Partial<Finding> & { id: string }): Finding {
  return {
    dependencyId: 'dep-1',
    type: 'upgrade',
    severity: 'info',
    action: 'upgrade_minor',
    confidence: 1.0,
    rationale: 'test',
    evidence: [],
    ...overrides,
  };
}

function minimalSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    id: 'snap-1',
    projectId: 'proj-1',
    targetRoot: '/fake',
    fingerprint: 'fp-1',
    createdAt: '2026-01-01T00:00:00Z',
    workspaces: [],
    dependencies: [],
    findings: [],
    coverage: 'full',
    adapterVersion: '0.1.0',
    ...overrides,
  };
}

describe('TechStackEngine.generateReport', () => {
  // We need a store-like object; only saveSnapshot/saveJob/updateJobStatus are called
  // during inventory, but generateReport doesn't touch the store at all.
  const engine = new TechStackEngine({} as never);

  it('renders a Markdown report with workspaces, deps, and findings', () => {
    const ws: Workspace = {
      id: 'ws-1',
      relativeRoot: 'packages/cli',
      ecosystem: 'npm',
      manifests: ['package.json'],
      lockfiles: ['pnpm-lock.yaml'],
      confidence: 0.9,
      coverage: 'full',
    };
    const snap = minimalSnapshot({
      workspaces: [ws],
      dependencies: [
        dep({ id: 'dep-1', name: 'express', locked: '4.18.0', status: 'current' }),
        dep({ id: 'dep-2', name: 'lodash', locked: '4.17.20', status: 'deprecated' }),
      ],
      findings: [
        finding({
          id: 'f1',
          dependencyId: 'dep-2',
          type: 'deprecated',
          severity: 'medium',
          rationale: 'Package is deprecated',
        }),
      ],
    });
    const md = engine.generateReport(snap, 'md');
    expect(md).toContain('# TechStack Report');
    expect(md).toContain('packages/cli');
    expect(md).toContain('express');
    expect(md).toContain('lodash');
    expect(md).toContain('Medium (1)');
    expect(md).toContain('Package is deprecated');
  });

  it('renders a JSON report', () => {
    const snap = minimalSnapshot();
    const json = engine.generateReport(snap, 'json');
    const parsed = JSON.parse(json);
    expect(parsed.id).toBe('snap-1');
    expect(parsed.coverage).toBe('full');
  });

  it('handles a snapshot with no workspaces or deps', () => {
    const md = engine.generateReport(minimalSnapshot(), 'md');
    expect(md).toContain('# TechStack Report');
    expect(md).not.toContain('## Workspaces');
    expect(md).not.toContain('## Dependencies');
  });

  it('groups findings by severity', () => {
    const snap = minimalSnapshot({
      dependencies: [dep({ id: 'd1', name: 'vuln-pkg' })],
      findings: [
        finding({ id: 'f1', severity: 'critical', rationale: 'RCE', dependencyId: 'd1' }),
        finding({ id: 'f2', severity: 'low', rationale: 'minor', dependencyId: 'd1' }),
      ],
    });
    const md = engine.generateReport(snap, 'md');
    expect(md).toContain('Critical (1)');
    expect(md).toContain('Low (1)');
  });
});

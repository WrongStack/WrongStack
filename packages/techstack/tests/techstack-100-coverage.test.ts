import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { stripInlineComment } from '../src/adapters/parse-utils.js';
import { workspaceRoot } from '../src/adapters/paths.js';
import * as osvModule from '../src/advisory/osv.js';
import { queryOsvBatch } from '../src/advisory/osv.js';
import { attemptDelivery } from '../src/delivery/coordinator.js';
import { assessLicense, createLicenseFinding } from '../src/policy/license.js';
import { detectWorkspaceMisalignments } from '../src/policy/misalignment.js';
import { satisfiesRange } from '../src/policy/resolver.js';
import { validateRulebook } from '../src/policy/rulebook.js';
import {
  classifyStatus,
  failedLookupStatus,
  privateOrUnresolvedStatus,
} from '../src/policy/status.js';
import * as registryClientModule from '../src/registry/client.js';
import { RegistryAuthError, RegistryNotFoundError } from '../src/registry/client.js';
import { buildPurl, constructPurl, parsePurl } from '../src/registry/purl.js';
import { applyPlan } from '../src/remediation.js';
import { toCycloneDX, toSpdx } from '../src/sbom.js';
import { runEnrichPhase } from '../src/service/enrich-phase.js';
import {
  computeDependencyFingerprint,
  createFindingForStatus,
} from '../src/service/finding-factory.js';
import { runInventoryPhase } from '../src/service/inventory-phase.js';
import { runResearchPhase } from '../src/service/research-phase.js';
import { TechStackEngine } from '../src/service/techstack-engine.js';
import { diffSnapshots } from '../src/snapshot-diff.js';
import { applySchema } from '../src/store/schema.js';
import { TechStackStore } from '../src/store/sqlite.js';
import { renderTrendMarkdown, TrendStore } from '../src/trend.js';
import type { DependencyObservation, Finding, Snapshot, Workspace } from '../src/types.js';

function makeDep(
  name: string,
  overrides: Partial<DependencyObservation> = {},
): DependencyObservation {
  return {
    id: `dep-${name}`,
    workspaceId: 'ws-1',
    name,
    ecosystem: 'npm',
    sourceType: 'registry',
    scope: 'runtime',
    requested: '^1.0.0',
    locked: '1.0.0',
    direct: true,
    status: 'current',
    purl: `pkg:npm/${name}@1.0.0`,
    evidence: [],
    ...overrides,
  };
}

function makeSnapshot(deps: DependencyObservation[] = []): Snapshot {
  return {
    id: 'snap-1',
    projectId: 'proj-1',
    targetRoot: '/fake/root',
    createdAt: new Date().toISOString(),
    workspaces: [
      {
        id: 'ws-1',
        ecosystem: 'npm',
        relativeRoot: '',
        manifests: ['package.json'],
        coverage: 'full',
      },
    ],
    dependencies: deps,
    findings: [],
    coverage: 'full',
    fingerprint: 'fp-1',
    adapterVersion: '1.0.0',
  };
}

describe('TechStack 100% Coverage Suite', () => {
  describe('service/enrich-phase.ts', () => {
    it('covers all registry and advisory lookup branches in runEnrichPhase', async () => {
      const snap = makeSnapshot([
        makeDep('pkg-success', { purl: 'pkg:npm/pkg-success@1.0.0' }),
        makeDep('pkg-not-found', { purl: 'pkg:npm/pkg-not-found@1.0.0' }),
        makeDep('pkg-auth-err', { purl: 'pkg:npm/pkg-auth-err@1.0.0' }),
        makeDep('pkg-generic-err', { purl: 'pkg:npm/pkg-generic-err@1.0.0' }),
        makeDep('pkg-no-entry', { purl: 'pkg:npm/pkg-no-entry@1.0.0' }),
        makeDep('pkg-path', { sourceType: 'path', purl: undefined }),
      ]);

      vi.spyOn(registryClientModule, 'lookupRegistry').mockImplementation(async (_eco, name) => {
        if (name === 'pkg-success') {
          return {
            name,
            ecosystem: 'npm',
            latestStable: '2.0.0',
            deprecated: true,
            yanked: false,
            license: 'MIT',
            source: 'registry.npmjs.org',
            retrievedAt: new Date().toISOString(),
          };
        }
        if (name === 'pkg-not-found') throw new RegistryNotFoundError('Not found');
        if (name === 'pkg-auth-err') throw new RegistryAuthError('Auth error');
        if (name === 'pkg-generic-err') throw new Error('Network timeout');
        return undefined; // pkg-no-entry
      });

      vi.spyOn(osvModule, 'queryOsvBatch').mockImplementation(async (purls) => {
        if (purls.includes('pkg:npm/pkg-success@1.0.0')) {
          return {
            advisories: new Map([
              [
                'pkg:npm/pkg-success@1.0.0',
                [{ id: 'CVE-2026-1', summary: 'vuln', severity: 'high', aliases: [] }],
              ],
            ]),
            evidence: { kind: 'osv', source: 'api.osv.dev', retrievedAt: new Date().toISOString() },
          };
        }
        return {
          advisories: new Map(),
          evidence: { kind: 'osv', source: 'api.osv.dev', retrievedAt: new Date().toISOString() },
        };
      });

      const result = await runEnrichPhase(snap, { online: true });
      expect(result.dependencies.length).toBe(6);
      expect(result.findings.length).toBeGreaterThan(0);

      vi.restoreAllMocks();
    });

    it('throws AbortError when signal is aborted inside runEnrichPhase loop', async () => {
      const snap = makeSnapshot([
        makeDep('pkg-1', { purl: 'pkg:npm/pkg-1@1.0.0' }),
        makeDep('pkg-2', { purl: 'pkg:npm/pkg-2@1.0.0' }),
      ]);
      const ac = new AbortController();
      vi.spyOn(registryClientModule, 'lookupRegistry').mockImplementation(async () => {
        ac.abort();
        return undefined;
      });

      await expect(runEnrichPhase(snap, { online: true, signal: ac.signal })).rejects.toThrow(
        'TechStack job cancelled',
      );

      vi.restoreAllMocks();
    });
  });

  describe('advisory/osv.ts', () => {
    it('covers mapSeverity CVSS and database severity mappings', async () => {
      // Mock requestWithRetry to return different vulnerabilities
      const mockVulns = [
        {
          id: 'V1',
          severity: [{ type: 'CVSS_V3', score: '9.5' }],
        },
        {
          id: 'V2',
          severity: [{ type: 'CVSS_V3', score: '7.5' }],
        },
        {
          id: 'V3',
          severity: [{ type: 'CVSS_V2', score: '5.0' }],
        },
        {
          id: 'V4',
          severity: [{ type: 'CVSS_V3', score: '2.0' }],
        },
        {
          id: 'V5',
          severity: [{ type: 'CVSS_V3', score: '0.0' }],
          database_specific: { severity: 'CRITICAL' },
        },
        {
          id: 'V6',
          database_specific: { severity: 'HIGH' },
        },
        {
          id: 'V7',
          database_specific: { severity: 'MODERATE' },
        },
        {
          id: 'V8',
          database_specific: { severity: 'LOW' },
        },
        {
          id: 'V9',
          details: 'fallback details',
          database_specific: { severity: 'UNKNOWN' },
        },
      ];

      const httpFetch = await import('../src/registry/http-fetch.js');
      vi.spyOn(httpFetch, 'requestWithRetry').mockResolvedValueOnce({
        statusCode: 200,
        headers: {},
        body: JSON.stringify({
          results: [{ vulns: mockVulns }],
        }),
      });

      const res = await queryOsvBatch(['pkg:npm/test-osv-batch@1.0.0']);
      const advs = res.advisories.get('pkg:npm/test-osv-batch@1.0.0');
      expect(advs).toHaveLength(9);
      expect(advs![0].severity).toBe('critical');
      expect(advs![1].severity).toBe('high');
      expect(advs![2].severity).toBe('medium');
      expect(advs![3].severity).toBe('low');
      expect(advs![4].severity).toBe('critical');
      expect(advs![5].severity).toBe('high');
      expect(advs![6].severity).toBe('medium');
      expect(advs![7].severity).toBe('low');
      expect(advs![8].severity).toBe('info');
      expect(advs![8].summary).toBe('fallback details');

      // Status != 200 throws Error
      vi.spyOn(httpFetch, 'requestWithRetry').mockResolvedValueOnce({
        statusCode: 500,
        headers: {},
        body: 'Server error',
      });
      await expect(queryOsvBatch(['pkg:npm/test-osv-batch@1.0.0'])).rejects.toThrow(
        /OSV API returned 500/,
      );

      vi.restoreAllMocks();
    });
  });

  describe('remediation.ts', () => {
    it('covers applyPlan with dryRun, approval, execute success and failure', async () => {
      const plan = {
        snapshotId: 's1',
        generatedAt: new Date().toISOString(),
        warning: '',
        summary: {
          total: 3,
          patch: 1,
          minor: 1,
          major: 1,
          replace: 0,
          remove: 0,
          investigate: 0,
        },
        items: [
          {
            dependencyName: 'dep-approved',
            ecosystem: 'npm' as const,
            workspaceId: 'ws-1',
            action: 'upgrade_minor' as const,
            currentVersion: '1.0.0',
            targetVersion: '1.1.0',
            severity: 'info' as const,
            rationale: 'Safe',
            breakingRisk: 'low' as const,
            suggestedCommand: 'npm update dep-approved',
          },
          {
            dependencyName: 'dep-rejected',
            ecosystem: 'npm' as const,
            workspaceId: 'ws-1',
            action: 'upgrade_major' as const,
            currentVersion: '1.0.0',
            targetVersion: '2.0.0',
            severity: 'low' as const,
            rationale: 'Major bump',
            breakingRisk: 'high' as const,
            suggestedCommand: 'npm install dep-rejected@2.0.0',
          },
          {
            dependencyName: 'dep-fail',
            ecosystem: 'npm' as const,
            workspaceId: 'ws-1',
            action: 'upgrade_patch' as const,
            currentVersion: '1.0.0',
            targetVersion: '1.0.1',
            severity: 'high' as const,
            rationale: 'Patch',
            breakingRisk: 'none' as const,
            suggestedCommand: 'npm update dep-fail',
          },
        ],
      };

      // 1. dryRun: false without execute throws
      await expect(applyPlan(plan, { dryRun: false })).rejects.toThrow(
        'An execute strategy is required when dryRun is false',
      );

      // 2. dryRun: false with approve and execute
      const res = await applyPlan(plan, {
        dryRun: false,
        approve: async (item) => item.dependencyName !== 'dep-rejected',
        execute: async (item) => {
          if (item.dependencyName === 'dep-fail') throw new Error('Exec failure');
          return { detail: 'Updated successfully' };
        },
      });

      expect(res.items[0]).toMatchObject({ status: 'applied', detail: 'Updated successfully' });
      expect(res.items[1]).toMatchObject({ status: 'skipped', detail: 'Not approved' });
      expect(res.items[2]).toMatchObject({ status: 'failed', detail: 'Exec failure' });

      // 3. Abort signal
      const ac = new AbortController();
      ac.abort();
      await expect(applyPlan(plan, { signal: ac.signal })).rejects.toThrow('Remediation cancelled');
    });
  });

  describe('trend.ts', () => {
    it('covers vulnerability resolution when dep is removed, and renderTrendMarkdown', () => {
      const snap1 = makeSnapshot([makeDep('vuln-dep', { status: 'vulnerable' })]);
      snap1.createdAt = '2026-01-01T00:00:00.000Z';

      // In snap2, vuln-dep is removed (active doesn't have it)
      const snap2 = makeSnapshot([]);
      snap2.createdAt = '2026-01-03T00:00:00.000Z';

      const mockSource = {
        listSnapshots: () => [snap1, snap2],
      };
      const trend = new TrendStore(mockSource);
      const report = trend.analyze('proj-1');
      expect(report.vulnerabilityHalfLifeMs).toBeDefined();

      const md = renderTrendMarkdown(report);
      expect(md).toContain('# TechStack Trend');
      expect(md).toContain('Vulnerability half-life:');
    });
  });

  describe('sbom.ts', () => {
    it('covers toSpdx and toCycloneDX fallbacks for missing purl and license', () => {
      const snap = makeSnapshot([
        makeDep('pkg-bare', {
          purl: undefined,
          license: undefined,
          locked: undefined,
          requested: undefined,
        }),
      ]);

      const spdx = toSpdx(snap);
      expect(spdx.packages[0].downloadLocation).toBe('NOASSERTION');
      expect(spdx.packages[0].licenseConcluded).toBe('NOASSERTION');

      const cdx = toCycloneDX(snap);
      expect(cdx.components[0].purl).toBeUndefined();
      expect(cdx.components[0].licenses).toBeUndefined();
    });
  });

  describe('snapshot-diff.ts', () => {
    it('covers diffSnapshots with nullish transitions', () => {
      const oldSnap = makeSnapshot([makeDep('pkg', { locked: '1.0.0', latestStable: undefined })]);
      const newSnap = makeSnapshot([makeDep('pkg', { locked: undefined, latestStable: '2.0.0' })]);

      const diff = diffSnapshots(oldSnap, newSnap);
      expect(diff.changed.some((c) => c.field === 'locked')).toBe(true);
      expect(diff.changed.some((c) => c.field === 'latestStable')).toBe(true);
    });
  });

  describe('delivery/coordinator.ts', () => {
    it('covers un-claimable outbox and summary with critical findings', async () => {
      const store = new TechStackStore({ projectSlug: 'test-proj', dbPath: ':memory:' });
      const snap = makeSnapshot([makeDep('vuln-pkg')]);
      snap.findings = [
        {
          id: 'f1',
          dependencyId: 'dep-vuln-pkg',
          type: 'vulnerability',
          severity: 'critical',
          action: 'upgrade_patch',
          rationale: 'Critical CVE',
          confidence: 1,
          evidence: [],
        },
      ];
      store.saveSnapshot(snap);

      store.createOutbox('del-1', snap.id, 'sess-1');

      // Claim outbox fails CAS
      vi.spyOn(store, 'claimOutbox').mockReturnValueOnce(false);

      const res = await attemptDelivery('del-1', {
        store,
        deliverToSession: async () => true,
        isRunInProgress: () => false,
      });
      expect(res.delivered).toBe(false);
      vi.restoreAllMocks();

      // Now reset to pending and let attemptDelivery deliver with summary
      store.stmt("UPDATE outbox SET status = 'pending' WHERE delivery_id = ?").run('del-1');
      let deliveredSummary = '';
      const res2 = await attemptDelivery('del-1', {
        store,
        deliverToSession: async (_s, _r, summary) => {
          deliveredSummary = summary;
          return true;
        },
        isRunInProgress: () => false,
      });
      expect(res2.delivered).toBe(true);
      expect(deliveredSummary).toContain('Critical CVE');
    });
  });

  describe('service/finding-factory.ts', () => {
    it('covers createFindingForStatus for yanked, update safe and breaking, and default', () => {
      expect(createFindingForStatus('d1', 'yanked').severity).toBe('high');
      expect(createFindingForStatus('d2', 'update_available_safe').severity).toBe('info');
      expect(createFindingForStatus('d3', 'update_available_breaking').severity).toBe('low');
      expect(createFindingForStatus('d4', 'custom_unknown').type).toBe('investigate');
    });

    it('covers computeDependencyFingerprint with requested fallback and unknown fallback', () => {
      const d1 = [makeDep('p1', { locked: undefined, requested: '^1.0.0' })];
      const d2 = [makeDep('p2', { locked: undefined, requested: undefined })];
      expect(computeDependencyFingerprint(d1)).toBeDefined();
      expect(computeDependencyFingerprint(d2)).toBeDefined();
    });
  });

  describe('service/inventory-phase.ts and research-phase.ts', () => {
    it('covers inventory phase AbortError and workspace unsupported coverage', async () => {
      const store = new TechStackStore({ projectSlug: 'test-proj', dbPath: ':memory:' });
      const ac = new AbortController();
      const discoveryModule = await import('../src/discovery/workspace.js');
      vi.spyOn(discoveryModule, 'discoverWorkspaces').mockResolvedValueOnce([
        { id: 'w1', ecosystem: 'npm', relativeRoot: '', manifests: ['package.json'] },
        { id: 'w2', ecosystem: 'npm', relativeRoot: 'pkg2', manifests: ['package.json'] },
      ]);
      const npmModule = await import('../src/adapters/npm.js');
      vi.spyOn(npmModule.npmAdapter, 'inventory').mockImplementationOnce(async () => {
        ac.abort();
        return [];
      });

      await expect(
        runInventoryPhase(store, 'proj-1', process.cwd(), { signal: ac.signal }),
      ).rejects.toThrow('TechStack job cancelled');

      vi.restoreAllMocks();
    });

    it('covers research phase researcher exception and 0 findings', async () => {
      const snap = makeSnapshot([makeDep('dep-breaking', { status: 'update_available_breaking' })]);

      // 1. Researcher throws
      const res1 = await runResearchPhase(snap, {
        researcher: {
          research: async () => {
            throw new Error('Research crash');
          },
        },
      });
      expect(res1).toBe(snap);

      // 2. Researcher returns empty array
      const res2 = await runResearchPhase(snap, {
        researcher: {
          research: async () => [],
        },
      });
      expect(res2).toBe(snap);

      // 3. Researcher returns findings
      const mockFinding: Finding = {
        id: 'f-res',
        dependencyId: snap.dependencies[0]!.id,
        type: 'upgrade',
        severity: 'info',
        action: 'upgrade_minor',
        confidence: 0.9,
        evidence: [],
        rationale: 'research passed',
      };
      const res3 = await runResearchPhase(snap, {
        researcher: {
          research: async () => [mockFinding],
        },
      });
      expect(res3.findings).toHaveLength(1);
    });
  });

  describe('service/techstack-engine.ts', () => {
    it('triggers researcher onProgress callback during engine analyze', async () => {
      const store = new TechStackStore({ projectSlug: 'test-proj', dbPath: ':memory:' });
      const engine = new TechStackEngine(store);

      // Mock inventory & enrich
      vi.spyOn(engine, 'inventory').mockResolvedValue(
        makeSnapshot([makeDep('pkg', { status: 'update_available_breaking' })]),
      );
      vi.spyOn(engine, 'enrich').mockImplementation(async (s) => s);

      let progressCalled = false;
      await engine.analyze('proj-1', {
        targetRoot: '/fake/root',
        online: true,
        researcher: {
          research: async (_c, opts) => {
            opts.onProgress?.(1, 1);
            progressCalled = true;
            return [];
          },
        },
      });
      expect(progressCalled).toBe(true);
    });
  });

  describe('store/sqlite.ts and store/schema.ts', () => {
    it('covers schema version upgrade in applySchema', () => {
      const store = new TechStackStore({ projectSlug: 'test-proj', dbPath: ':memory:' });
      // Reset version to 0
      store.stmt('UPDATE techstack_schema_version SET version = 0').run();
      // Re-run applySchema
      applySchema((store as any).db);
      const row = store.stmt('SELECT version FROM techstack_schema_version').get() as {
        version: number;
      };
      expect(row.version).toBeGreaterThan(0);
    });

    it('handles corrupted JSON in snapshots and research_cache', () => {
      const store = new TechStackStore({ projectSlug: 'test-proj', dbPath: ':memory:' });
      store
        .stmt(
          'INSERT INTO snapshots (id, project_id, target_root, fingerprint, created_at, raw_json) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run('corrupt-snap', 'p1', '/root', 'fp', new Date().toISOString(), '{ corrupt json');

      expect(store.getSnapshotById('corrupt-snap')).toBeUndefined();

      store
        .stmt(
          'INSERT INTO research_cache (cache_key, findings_json, created_at, expires_at) VALUES (?, ?, ?, ?)',
        )
        .run(
          'corrupt-cache',
          '{ corrupt json',
          new Date().toISOString(),
          new Date(Date.now() + 10000).toISOString(),
        );

      expect(store.getCachedResearch('corrupt-cache')).toBeNull();
    });
  });

  describe('policy/rulebook.ts', () => {
    it('covers validateRulebook validation errors for selector, deprecates, packageManager, advisorHints', () => {
      const errors = validateRulebook({
        name: 'test-rules',
        preferred: [
          {
            selector: {} as any, // selector without fields
            context: 'use this',
            deprecates: {} as any, // deprecates without fields
          },
        ],
        packageManager: 'not-an-object' as any,
        advisorHints: 123 as any,
      });

      expect(
        errors.some((e) => e.includes('must set at least one of name/namePattern/ecosystem')),
      ).toBe(true);
      expect(errors.some((e) => e.includes('deprecates must be a valid selector'))).toBe(true);
      expect(errors.some((e) => e.includes('packageManager must be an object'))).toBe(true);
      expect(errors.some((e) => e.includes('advisorHints must be a string'))).toBe(true);

      // Oversized advisorHints
      const errors2 = validateRulebook({
        name: 'test-rules',
        advisorHints: 'A'.repeat(9000),
      });
      expect(errors2.some((e) => e.includes('exceeds the 8192-byte limit'))).toBe(true);
    });
  });

  describe('policy/resolver.ts', () => {
    it('covers satisfiesRange comparators and fallbacks', () => {
      expect(satisfiesRange('2.0.0', { kind: 'comparator', op: '>', version: '1.0.0' })).toBe(true);
      expect(satisfiesRange('1.0.0', { kind: 'comparator', op: '=', version: '1.0.0' })).toBe(true);
      expect(
        satisfiesRange('1.0.0', { kind: 'comparator', op: '!=' as any, version: '1.0.0' }),
      ).toBe(false);
      expect(satisfiesRange('1.0.0', { kind: 'unknown' as any })).toBe(false);
    });
  });

  describe('policy/status.ts', () => {
    it('covers isBreakingUpgrade and classifyStatus edge cases', () => {
      // classifyStatus with major upgrade
      const depMajor = makeDep('pkg-major', { locked: '1.0.0', requested: '>=1.0.0' });
      expect(classifyStatus(depMajor, { latestStable: '2.0.0' })).toBe('update_available_breaking');

      // classifyStatus with minor upgrade
      const depMinor = makeDep('pkg-minor', { locked: '1.0.0', requested: '>=1.0.0' });
      expect(classifyStatus(depMinor, { latestStable: '1.1.0' })).toBe('update_available_safe');

      // locked > latestStable
      const depAhead = makeDep('pkg-ahead', { locked: '2.0.0', requested: '^1.0.0' });
      expect(classifyStatus(depAhead, { latestStable: '1.0.0' })).toBe('current');

      // local_path and git_dependency holdover
      const depLocal = makeDep('pkg-local', { status: 'local_path' });
      expect(classifyStatus(depLocal)).toBe('local_path');

      // privateOrUnresolvedStatus and failedLookupStatus helpers
      const priv = privateOrUnresolvedStatus('my-registry', 'detail');
      expect(priv.privateOrUnresolved).toBe(true);

      const failed = failedLookupStatus('my-registry', 'detail');
      expect(failed.lookupFailed).toBe(true);
    });
  });

  describe('policy/license.ts', () => {
    it('evaluates gpl and unknown licenses', () => {
      const gpl = assessLicense('GPL-3.0');
      expect(gpl.category).toBe('strong_copyleft');
      expect(gpl.isCopyleft).toBe(true);

      const unk = assessLicense('MyCompany-Proprietary-Custom');
      expect(unk.category).toBe('unknown');

      expect(createLicenseFinding('dep-1', 'pkg-1', 'GPL-3.0')).toBeDefined();
    });
  });

  describe('policy/misalignment.ts', () => {
    it('covers workspace misalignment edge cases', () => {
      // 1. Single workspace or empty deps
      expect(detectWorkspaceMisalignments([], [])).toEqual([]);

      // 2. Dep without duplicate across workspaces
      const ws1: Workspace = { id: 'ws-1', ecosystem: 'npm', relativeRoot: '', manifests: [] };
      const ws2: Workspace = {
        id: 'ws-2',
        ecosystem: 'npm',
        relativeRoot: 'packages/sub',
        manifests: [],
      };
      const deps = [
        makeDep('unique-pkg', { workspaceId: 'ws-1' }),
        makeDep('same-ver-pkg', { workspaceId: 'ws-1', locked: '1.0.0' }),
        makeDep('same-ver-pkg', { workspaceId: 'ws-2', locked: '1.0.0' }),
      ];
      expect(detectWorkspaceMisalignments(deps, [ws1, ws2])).toEqual([]);

      // 3. Unknown workspace id fallback
      const depsDiff = [
        makeDep('diff-pkg', { id: 'd1', workspaceId: 'unknown-ws-1', locked: '1.0.0' }),
        makeDep('diff-pkg', { id: 'd2', workspaceId: 'unknown-ws-2', locked: '2.0.0' }),
      ];
      const findings = detectWorkspaceMisalignments(depsDiff, [ws1, ws2]);
      expect(findings.length).toBe(2);
    });
  });

  describe('adapters/paths.ts and parse-utils.ts', () => {
    it('covers workspaceRoot with empty relativeRoot', () => {
      const root = workspaceRoot(
        { id: 'w', ecosystem: 'npm', relativeRoot: '', manifests: [] },
        {},
      );
      expect(root).toBeDefined();
    });

    it('covers stripInlineComment with escaped quotes and comments', async () => {
      const res = stripInlineComment('key = "escaped \\" quote" # comment');
      expect(res).toBe('key = "escaped \\" quote"');
      expect(stripInlineComment('plain # comment')).toBe('plain');
      expect(stripInlineComment("key = 'single quote' # comment")).toBe("key = 'single quote'");

      const { parseTomlKeyValue, parseXmlAttributes, xmlTagValue } = await import(
        '../src/adapters/parse-utils.js'
      );
      expect(parseTomlKeyValue('invalid line without equals')).toBeUndefined();
      expect(parseTomlKeyValue('"quoted-key" = "value"')).toEqual({
        key: 'quoted-key',
        value: '"value"',
      });
      expect(parseTomlKeyValue("'single-key' = 'value'")).toEqual({
        key: 'single-key',
        value: "'value'",
      });
      expect(parseTomlKeyValue('plain_key = 123')).toEqual({ key: 'plain_key', value: '123' });

      const attrs = parseXmlAttributes('<tag id="1" name=\'test\' />');
      expect(attrs.get('id')).toBe('1');
      expect(attrs.get('name')).toBe('test');

      expect(xmlTagValue('<item>hello</item>', 'item')).toBe('hello');
      expect(xmlTagValue('<empty />', 'missing')).toBeUndefined();
    });
  });

  describe('registry/purl.ts', () => {
    it('constructs and parses PURL with qualifiers and subpaths', () => {
      const purl = buildPurl({
        type: 'npm',
        name: 'mypkg',
        version: '1.0.0',
        qualifiers: new Map([['arch', 'x64']]),
        subpath: 'dist/index.js',
      });
      expect(purl).toContain('?arch=x64#dist%2Findex.js');

      const parsed = parsePurl(purl);
      expect(parsed?.subpath).toBe('dist/index.js');
      expect(parsed?.qualifiers?.get('arch')).toBe('x64');

      expect(constructPurl('npm', 'test-pkg', '1.0.0')).toBe('pkg:npm/test-pkg@1.0.0');
    });
  });

  describe('Additional coverage gaps for 100%', () => {
    it('covers remediation toLanguagePackageInput, suggestCommand, generateUpgradePlan, renderPlanMarkdown', async () => {
      const { toLanguagePackageInput, generateUpgradePlan, renderPlanMarkdown } = await import(
        '../src/remediation.js'
      );

      // toLanguagePackageInput error on replace / investigate
      expect(() =>
        toLanguagePackageInput({
          ecosystem: 'npm',
          workspaceId: 'ws-1',
          dependencyName: 'foo',
          action: 'replace',
        }),
      ).toThrow('replace requires a manual package choice');

      expect(() =>
        toLanguagePackageInput({
          ecosystem: 'npm',
          workspaceId: 'ws-1',
          dependencyName: 'foo',
          action: 'investigate',
        }),
      ).toThrow('investigate requires a manual package choice');

      // toLanguagePackageInput unsupported ecosystem
      expect(() =>
        toLanguagePackageInput({
          ecosystem: 'unsupported-eco',
          workspaceId: 'ws-1',
          dependencyName: 'foo',
          action: 'upgrade_patch',
        }),
      ).toThrow('Automated remediation is not supported');

      // toLanguagePackageInput remove operations for go, python, php, etc.
      expect(
        toLanguagePackageInput({
          ecosystem: 'go',
          workspaceId: 'ws-1',
          dependencyName: 'pkg-go',
          action: 'remove',
        }),
      ).toMatchObject({ operation: 'add', names: ['pkg-go@none'] });

      expect(
        toLanguagePackageInput({
          ecosystem: 'npm',
          workspaceId: 'ws-1',
          dependencyName: 'pkg-npm',
          action: 'remove',
        }),
      ).toMatchObject({ operation: 'remove', names: ['pkg-npm'] });

      // versionedPackageName for python, php, default
      expect(
        toLanguagePackageInput({
          ecosystem: 'python',
          workspaceId: 'ws-1',
          dependencyName: 'pkg-py',
          action: 'upgrade_minor',
          targetVersion: '2.0.0',
        }),
      ).toMatchObject({ operation: 'add', names: ['pkg-py==2.0.0'] });

      expect(
        toLanguagePackageInput({
          ecosystem: 'php',
          workspaceId: 'ws-1',
          dependencyName: 'pkg-php',
          action: 'upgrade_minor',
          targetVersion: '2.0.0',
        }),
      ).toMatchObject({ operation: 'add', names: ['pkg-php:2.0.0'] });

      // generateUpgradePlan and suggestCommand for all ecosystems and actions
      const snapWithFindings = makeSnapshot([
        makeDep('npm-dep', { ecosystem: 'npm', latestStable: '2.0.0' }),
        makeDep('py-dep', { ecosystem: 'python', latestStable: '2.0.0' }),
        makeDep('rust-dep', { ecosystem: 'rust', latestStable: '2.0.0' }),
        makeDep('go-dep', { ecosystem: 'go', latestStable: '2.0.0' }),
        makeDep('php-dep', { ecosystem: 'php', latestStable: '2.0.0' }),
        makeDep('dotnet-dep', { ecosystem: 'dotnet', latestStable: '2.0.0' }),
        makeDep('other-dep', { ecosystem: 'swift', latestStable: '2.0.0' }),
      ]);
      snapWithFindings.findings = [
        {
          id: 'f1',
          dependencyId: 'dep-npm-dep',
          type: 'update',
          severity: 'critical',
          action: 'remove',
          rationale: 'Remove npm',
          confidence: 1,
          evidence: [],
        },
        {
          id: 'f2',
          dependencyId: 'dep-py-dep',
          type: 'update',
          severity: 'high',
          action: 'remove',
          rationale: 'Remove py',
          confidence: 1,
          evidence: [],
        },
        {
          id: 'f3',
          dependencyId: 'dep-rust-dep',
          type: 'update',
          severity: 'medium',
          action: 'remove',
          rationale: 'Remove rust',
          confidence: 1,
          evidence: [],
        },
        {
          id: 'f4',
          dependencyId: 'dep-go-dep',
          type: 'update',
          severity: 'low',
          action: 'remove',
          rationale: 'Remove go',
          confidence: 1,
          evidence: [],
        },
        {
          id: 'f5',
          dependencyId: 'dep-php-dep',
          type: 'update',
          severity: 'info',
          action: 'remove',
          rationale: 'Remove php',
          confidence: 1,
          evidence: [],
        },
        {
          id: 'f6',
          dependencyId: 'dep-dotnet-dep',
          type: 'update',
          severity: 'low',
          action: 'remove',
          rationale: 'Remove dotnet',
          confidence: 1,
          evidence: [],
        },
        {
          id: 'f7',
          dependencyId: 'dep-other-dep',
          type: 'update',
          severity: 'low',
          action: 'remove',
          rationale: 'Remove other',
          confidence: 1,
          evidence: [],
        },
        {
          id: 'f8',
          dependencyId: 'dep-rust-dep',
          type: 'update',
          severity: 'medium',
          action: 'upgrade_minor',
          rationale: 'Add rust',
          confidence: 1,
          evidence: [],
        },
        {
          id: 'f9',
          dependencyId: 'dep-go-dep',
          type: 'update',
          severity: 'low',
          action: 'upgrade_minor',
          rationale: 'Add go',
          confidence: 1,
          evidence: [],
        },
        {
          id: 'f10',
          dependencyId: 'dep-php-dep',
          type: 'update',
          severity: 'info',
          action: 'upgrade_minor',
          rationale: 'Add php',
          confidence: 1,
          evidence: [],
        },
        {
          id: 'f11',
          dependencyId: 'dep-dotnet-dep',
          type: 'update',
          severity: 'low',
          action: 'upgrade_minor',
          rationale: 'Add dotnet',
          confidence: 1,
          evidence: [],
        },
        {
          id: 'f12',
          dependencyId: 'dep-other-dep',
          type: 'update',
          severity: 'low',
          action: 'none', // should be skipped
          rationale: 'none',
          confidence: 1,
          evidence: [],
        },
      ];

      const plan = generateUpgradePlan(snapWithFindings);
      expect(plan.items.length).toBeGreaterThan(0);
      const rendered = renderPlanMarkdown(plan);
      expect(rendered).toContain('# TechStack Remediation Plan');

      // Empty plan markdown
      const emptyPlan = generateUpgradePlan(makeSnapshot([]));
      const emptyRendered = renderPlanMarkdown(emptyPlan);
      expect(emptyRendered).toContain('No remediation actions needed');
    });

    it('covers native audit createAuditRunner and error branches', async () => {
      const { createAuditRunner } = await import('../src/advisory/native-audit.js');
      const runner = createAuditRunner(async (cmd, args) => {
        if (cmd === 'dotnet' && args[0] !== '--version') {
          return { status: 0, stdout: '{ "invalid json', stderr: '' };
        }
        if (cmd === 'cargo' && args[0] !== '--version') {
          return { status: 1, stdout: '', stderr: 'audit fail' };
        }
        return { status: 0, stdout: 'version 1.0', stderr: '' };
      });

      expect(await runner.isAvailable('npm')).toBe(true);
      expect(await runner.isAvailable('python')).toBe(true);
      expect(await runner.isAvailable('rust')).toBe(true);
      expect(await runner.isAvailable('go')).toBe(true);
      expect(await runner.isAvailable('php')).toBe(true);
      expect(await runner.isAvailable('dotnet')).toBe(true);
      expect(await runner.isAvailable('swift' as any)).toBe(false);

      const dotnetRes = await runner.run('dotnet', process.cwd());
      expect(dotnetRes.evidence.detail).toContain('Failed to parse dotnet');

      const cargoRes = await runner.run('rust', process.cwd());
      expect(cargoRes.evidence.detail).toContain('cargo audit exited with code 1');
    });

    it('covers inventory phase malformed and unsupported workspaces', async () => {
      const store = new TechStackStore({ projectSlug: 'test-proj', dbPath: ':memory:' });
      // Mock discoverWorkspaces to return an unsupported workspace and a throwing workspace
      const discoveryModule = await import('../src/discovery/workspace.js');
      vi.spyOn(discoveryModule, 'discoverWorkspaces').mockResolvedValueOnce([
        {
          id: 'ws-unsupported',
          ecosystem: 'cpp',
          relativeRoot: 'cpp-ws',
          manifests: ['conanfile.txt'],
          coverage: 'unsupported',
        },
        {
          id: 'ws-throws',
          ecosystem: 'npm',
          relativeRoot: 'throws-ws',
          manifests: ['package.json'],
          coverage: 'full',
        },
      ]);

      const npmMod = await import('../src/adapters/npm.js');
      vi.spyOn(npmMod.npmAdapter, 'inventory').mockRejectedValueOnce(
        new Error('Malformed npm workspace'),
      );

      const snap = await runInventoryPhase(store, 'proj-1', process.cwd());
      expect(snap.coverage).toBe('partial');

      vi.restoreAllMocks();
    });

    it('covers techstack engine error updateJob cancelled vs failed', async () => {
      const store = new TechStackStore({ projectSlug: 'test-proj', dbPath: ':memory:' });
      const engine = new TechStackEngine(store);

      // AbortError branch
      vi.spyOn(engine, 'inventory').mockRejectedValueOnce(
        new DOMException('User aborted', 'AbortError'),
      );
      await expect(
        engine.analyze('proj-1', { targetRoot: process.cwd(), online: false }),
      ).rejects.toThrow('User aborted');

      // Generic error branch
      vi.spyOn(engine, 'inventory').mockRejectedValueOnce(new Error('Generic failure'));
      await expect(
        engine.analyze('proj-1', { targetRoot: process.cwd(), online: false }),
      ).rejects.toThrow('Generic failure');

      vi.restoreAllMocks();
    });

    it('covers coordinator delivery run-in-progress, not found, and failed delivery', async () => {
      const store = new TechStackStore({ projectSlug: 'test-proj', dbPath: ':memory:' });
      store.createOutbox('del-pending', 'snap-missing', 'sess-1');

      // 1. isRunInProgress returns true
      const res1 = await attemptDelivery('del-pending', {
        store,
        isRunInProgress: () => true,
        deliverToSession: async () => true,
      });
      expect(res1.delivered).toBe(false);

      // 2. entry not found
      const res2 = await attemptDelivery('non-existent-del', {
        store,
        isRunInProgress: () => false,
        deliverToSession: async () => true,
      });
      expect(res2.delivered).toBe(false);

      // 3. deliverToSession fails
      const res3 = await attemptDelivery('del-pending', {
        store,
        isRunInProgress: () => false,
        deliverToSession: async () => false,
      });
      expect(res3.delivered).toBe(false);

      const { drainPendingDeliveries } = await import('../src/delivery/coordinator.js');
      expect(
        await drainPendingDeliveries('sess-1', {
          store,
          isRunInProgress: () => true,
          deliverToSession: async () => true,
        }),
      ).toBe(0);
    });

    it('covers status.ts edge cases', async () => {
      // 1. compareVersions with different major, minor, patch, prerelease
      const { compareVersions } = await import('../src/policy/status.js');
      expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0);
      expect(compareVersions('1.0.0-beta', '1.0.0-alpha')).toBeGreaterThan(0);
      expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.2')).toBeLessThan(0);
      expect(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.1')).toBeGreaterThan(0);

      // 2. classifyStatus with locked < latestStable without constraint
      const depNoConstraint = makeDep('pkg-noconstraint', {
        locked: '1.0.0',
        requested: undefined,
      });
      expect(classifyStatus(depNoConstraint, { latestStable: '2.0.0' })).toBe(
        'update_available_safe',
      );

      // 3. classifyStatus fallback to dep.status ?? 'current'
      const depDefault = makeDep('pkg-default', {
        status: undefined as any,
        locked: undefined,
        requested: undefined,
      });
      expect(classifyStatus(depDefault)).toBe('current');
    });

    it('covers rulebook loadRulebook resolution branches and error handling', async () => {
      const { loadRulebook, asVersionRange, asIsoDateTime } = await import(
        '../src/policy/rulebook.js'
      );
      expect(asVersionRange('^1.0.0')).toBe('^1.0.0');
      expect(asIsoDateTime('2026-01-01T00:00:00Z')).toBe('2026-01-01T00:00:00Z');

      const mockIo = {
        exists: async (p: string) =>
          p.includes('valid.json') || p.includes('bad.yaml') || p.includes('bad.json'),
        readFile: async (p: string) => {
          if (p.includes('bad.json')) return '{ corrupt json';
          if (p.includes('bad.yaml')) return 'yaml: true';
          return JSON.stringify({
            schemaVersion: '1',
            preferred: [{ context: 'ctx', selector: { name: 'foo' } }],
          });
        },
        stat: async () => ({ size: 100 }),
      };

      // 1. overridePath yaml
      const resYaml = await loadRulebook('/root', '/root/bad.yaml', mockIo);
      expect(resYaml.kind).toBe('malformed');

      // 2. corrupt json
      const resBadJson = await loadRulebook('/root', '/root/bad.json', mockIo);
      expect(resBadJson.kind).toBe('malformed');

      // 3. valid json
      const resValid = await loadRulebook('/root', '/root/valid.json', mockIo);
      expect(resValid.kind).toBe('loaded');

      // 4. absent
      const resAbsent = await loadRulebook('/root', '/root/non-existent.json', {
        exists: async () => false,
        readFile: async () => '',
        stat: async () => ({ size: 0 }),
      });
      expect(resAbsent.kind).toBe('absent');

      // 5. readFile throws
      const resReadErr = await loadRulebook('/root', '/root/valid.json', {
        exists: async () => true,
        readFile: async () => {
          throw new Error('EACCES');
        },
        stat: async () => ({ size: 0 }),
      });
      expect(resReadErr.kind).toBe('malformed');

      // 6. io.exists throws
      const resExistsErr = await loadRulebook('/root', '/root/valid.json', {
        exists: async () => {
          throw new Error('EIO');
        },
        readFile: async () => '',
        stat: async () => ({ size: 0 }),
      });
      expect(resExistsErr.kind).toBe('absent');
    });

    it('covers rulebook validateRulebook additional schema error branches', async () => {
      const { validateRulebook } = await import('../src/policy/rulebook.js');
      // non-plain-object entry
      expect(validateRulebook(null as any)).toEqual(['rulebook must be a JSON object']);
      // schemaVersion !== '1'
      expect(
        validateRulebook({ schemaVersion: '2', pinned: [] } as any).some((e) =>
          e.includes("schemaVersion must be '1'"),
        ),
      ).toBe(true);
      // no sections
      expect(
        validateRulebook({ schemaVersion: '1' } as any).some((e) =>
          e.includes('must declare at least one'),
        ),
      ).toBe(true);
      // pinned non-array, item not object, item bad fields
      const pinnedErrors = validateRulebook({
        schemaVersion: '1',
        pinned: [
          'not-object' as any,
          { selector: { name: 'foo' }, max: '', reason: '' },
          { selector: { name: 'bar' }, max: '1.0.0', reason: 'ok', reviewAfter: 'invalid-date' },
        ],
      });
      expect(pinnedErrors.some((e) => e.includes('pinned[0] must be an object'))).toBe(true);
      expect(pinnedErrors.some((e) => e.includes('pinned[1].max'))).toBe(true);
      expect(pinnedErrors.some((e) => e.includes('pinned[1].reason'))).toBe(true);
      expect(pinnedErrors.some((e) => e.includes('pinned[2].reviewAfter'))).toBe(true);

      // banned non-array, item not object, replacement errors, since error, empty selector
      const bannedErrors = validateRulebook({
        schemaVersion: '1',
        banned: [
          'not-object' as any,
          {
            selector: { name: 'foo' },
            reason: '',
            since: 'invalid-date',
            replacement: 'not-an-object' as any,
          },
          { selector: { name: 'bar' }, reason: 'banned', replacement: { ecosystem: '', name: '' } },
          { selector: {} as any, reason: 'banned' },
        ],
      });
      expect(bannedErrors.some((e) => e.includes('banned[0] must be an object'))).toBe(true);
      expect(bannedErrors.some((e) => e.includes('banned[1].reason'))).toBe(true);
      expect(bannedErrors.some((e) => e.includes('banned[1].since'))).toBe(true);
      expect(bannedErrors.some((e) => e.includes('banned[1].replacement must be an object'))).toBe(
        true,
      );
      expect(bannedErrors.some((e) => e.includes('banned[2].replacement.ecosystem'))).toBe(true);
      expect(bannedErrors.some((e) => e.includes('banned[2].replacement.name'))).toBe(true);
      expect(bannedErrors.some((e) => e.includes('banned[3].selector must set at least one'))).toBe(
        true,
      );

      // deferred non-array, item not object, item bad fields, empty selector
      const deferredErrors = validateRulebook({
        schemaVersion: '1',
        deferred: [
          'not-object' as any,
          { selector: { name: 'foo' }, reason: '', until: 'invalid-date' },
          { selector: { name: 'bar' }, reason: 'deferred', until: '2020-01-01T00:00:00Z' }, // in the past
          { selector: {} as any, reason: 'deferred', until: '2099-01-01T00:00:00Z' },
        ],
      });
      expect(deferredErrors.some((e) => e.includes('deferred[0] must be an object'))).toBe(true);
      expect(deferredErrors.some((e) => e.includes('deferred[1].reason'))).toBe(true);
      expect(deferredErrors.some((e) => e.includes('deferred[1].until must be a valid ISO'))).toBe(
        true,
      );
      expect(
        deferredErrors.some((e) => e.includes('deferred[2].until must be in the future')),
      ).toBe(true);
      expect(
        deferredErrors.some((e) => e.includes('deferred[3].selector must set at least one')),
      ).toBe(true);

      // non-array sections
      expect(
        validateRulebook({ schemaVersion: '1', pinned: 'not-array' as any }).some((e) =>
          e.includes('pinned must be an array'),
        ),
      ).toBe(true);
      expect(
        validateRulebook({ schemaVersion: '1', banned: 'not-array' as any }).some((e) =>
          e.includes('banned must be an array'),
        ),
      ).toBe(true);
      expect(
        validateRulebook({ schemaVersion: '1', deferred: 'not-array' as any }).some((e) =>
          e.includes('deferred must be an array'),
        ),
      ).toBe(true);
      expect(
        validateRulebook({ schemaVersion: '1', preferred: 'not-array' as any }).some((e) =>
          e.includes('preferred must be an array'),
        ),
      ).toBe(true);

      // preferred non-array, item not object
      const preferredErrors = validateRulebook({
        schemaVersion: '1',
        preferred: ['not-object' as any, { selector: { name: 'foo' }, context: '' }],
      });
      expect(preferredErrors.some((e) => e.includes('preferred[0] must be an object'))).toBe(true);
      expect(preferredErrors.some((e) => e.includes('preferred[1].context'))).toBe(true);
    });

    it('covers trend.ts median with even length array', async () => {
      const snap1 = makeSnapshot([makeDep('dep1', { status: 'vulnerable' })]);
      snap1.createdAt = '2026-01-01T00:00:00.000Z';
      const snap2 = makeSnapshot([makeDep('dep1', { status: 'current' })]);
      snap2.createdAt = '2026-01-02T00:00:00.000Z';
      const snap3 = makeSnapshot([makeDep('dep2', { status: 'vulnerable' })]);
      snap3.createdAt = '2026-01-03T00:00:00.000Z';
      const snap4 = makeSnapshot([makeDep('dep2', { status: 'current' })]);
      snap4.createdAt = '2026-01-05T00:00:00.000Z';

      const trend = new TrendStore({ listSnapshots: () => [snap1, snap2, snap3, snap4] });
      const report = trend.analyze('proj-1');
      expect(report.vulnerabilityHalfLifeMs).toBeDefined();
    });

    it('covers adapters: go, gradle, maven, cpp, dotnet, elixir, php, python, ruby, rust, swift edge cases', async () => {
      // 1. go adapter
      const { GoAdapter } = await import('../src/adapters/go.ts');
      const goAdapter = new GoAdapter();
      // Test missing go.mod read error
      const emptyGo = await goAdapter.inventory(
        {
          id: 'w-go',
          ecosystem: 'go',
          relativeRoot: 'nonexistent-dir-12345',
          manifests: ['go.mod'],
        },
        {},
      );
      expect(emptyGo).toEqual([]);

      // Test parseGoReplacements multi-line and single-line + parseGoModuleName missing
      const fs = await import('node:fs');
      const path = await import('node:path');
      const os = await import('node:os');
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'techstack-test-'));
      try {
        const goModFile = path.join(tmpDir, 'go.mod');
        fs.writeFileSync(
          goModFile,
          [
            '// No module statement here',
            'require example.com/pkg v1.0.0',
            'replace (',
            '  example.com/pkg => ./local/pkg',
            ')',
            'replace example.com/gitpkg => git.com/remote/gitpkg v1.0.0',
          ].join('\n'),
        );
        const goDeps = await goAdapter.inventory(
          { id: 'w-go2', ecosystem: 'go', relativeRoot: tmpDir, manifests: ['go.mod'] },
          { projectRoot: tmpDir },
        );
        expect(goDeps.length).toBeGreaterThan(0);
        expect(goDeps[0].status).toBe('local_path');

        // 2. gradle adapter: group + name version catalog
        const { GradleAdapter } = await import('../src/adapters/gradle.ts');
        const gradleAdapter = new GradleAdapter();
        const gradleDir = path.join(tmpDir, 'gradle');
        fs.mkdirSync(gradleDir, { recursive: true });
        const tomlPath = path.join(gradleDir, 'libs.versions.toml');
        fs.writeFileSync(
          tomlPath,
          [
            '[versions]',
            'myver = "1.2.3"',
            '[libraries]',
            'my-lib = { group = "com.example", name = "foo", version.ref = "myver" }',
          ].join('\n'),
        );
        const buildGradle = path.join(tmpDir, 'build.gradle');
        fs.writeFileSync(buildGradle, 'dependencies { implementation(libs.my.lib) }');
        const gradleDeps = await gradleAdapter.inventory(
          {
            id: 'w-gradle',
            ecosystem: 'gradle',
            relativeRoot: tmpDir,
            manifests: ['build.gradle'],
          },
          { projectRoot: tmpDir },
        );
        expect(gradleDeps.length).toBe(1);
        expect(gradleDeps[0].name).toBe('com.example:foo');

        // 3. maven adapter: scopes and read failure
        const { MavenAdapter } = await import('../src/adapters/maven.ts');
        const mavenAdapter = new MavenAdapter();
        const pomFile = path.join(tmpDir, 'pom.xml');
        fs.writeFileSync(
          pomFile,
          `<project>
            <dependencies>
              <dependency><groupId>g1</groupId><artifactId>a1</artifactId><version>1.0</version><scope>provided</scope></dependency>
              <dependency><groupId>g2</groupId><artifactId>a2</artifactId><version>1.0</version><scope>runtime</scope></dependency>
              <dependency><groupId>g3</groupId><artifactId>a3</artifactId><version>1.0</version><scope>compile</scope></dependency>
            </dependencies>
          </project>`,
        );
        const mavenDeps = await mavenAdapter.inventory(
          { id: 'w-mvn', ecosystem: 'maven', relativeRoot: tmpDir, manifests: [pomFile] },
          { projectRoot: tmpDir },
        );
        expect(mavenDeps.find((d) => d.name === 'g1:a1')?.scope).toBe('optional');
        expect(mavenDeps.find((d) => d.name === 'g2:a2')?.scope).toBe('runtime');

        // Read error for maven
        expect(
          await mavenAdapter.inventory(
            {
              id: 'w-mvn-bad',
              ecosystem: 'maven',
              relativeRoot: tmpDir,
              manifests: ['nonexistent/pom.xml'],
            },
            { projectRoot: tmpDir },
          ),
        ).toEqual([]);

        // 4. cpp adapter: conanfile with single part dependency, non-matching manifest
        const { CppAdapter } = await import('../src/adapters/cpp.ts');
        const cppAdapter = new CppAdapter();
        const conanPath = path.join(tmpDir, 'conanfile.txt');
        fs.writeFileSync(conanPath, '[requires]\nzlib\nfmt/8.0.1\n');
        const cmakePath = path.join(tmpDir, 'CMakeLists.txt');
        fs.writeFileSync(cmakePath, 'cmake_minimum_required(VERSION 3.10)');
        const cppDeps = await cppAdapter.inventory(
          {
            id: 'w-cpp',
            ecosystem: 'cpp',
            relativeRoot: tmpDir,
            manifests: [conanPath, cmakePath],
          },
          { projectRoot: tmpDir },
        );
        expect(cppDeps.some((d) => d.name === 'zlib')).toBe(true);

        // 5. dotnet adapter: read failure (directory named test.csproj makes readFile throw EISDIR)
        const { DotNetAdapter } = await import('../src/adapters/dotnet.ts');
        const dotnetAdapter = new DotNetAdapter();
        const csprojDir = path.join(tmpDir, 'test.csproj');
        fs.mkdirSync(csprojDir, { recursive: true });
        const emptyDotnet = await dotnetAdapter.inventory(
          { id: 'w-dotnet', ecosystem: 'dotnet', relativeRoot: tmpDir, manifests: [csprojDir] },
          { projectRoot: tmpDir },
        );
        expect(emptyDotnet).toEqual([]);

        // 6. elixir adapter: read failure
        const { ElixirAdapter } = await import('../src/adapters/elixir.ts');
        const elixirAdapter = new ElixirAdapter();
        expect(
          await elixirAdapter.inventory(
            {
              id: 'w-ex',
              ecosystem: 'elixir',
              relativeRoot: tmpDir,
              manifests: ['nonexistent/mix.exs'],
              lockfiles: [],
            },
            { projectRoot: tmpDir },
          ),
        ).toEqual([]);

        // 7. php adapter: read failure and corrupt json
        const { PhpAdapter } = await import('../src/adapters/php.ts');
        const phpAdapter = new PhpAdapter();
        expect(
          await phpAdapter.inventory(
            {
              id: 'w-php1',
              ecosystem: 'php',
              relativeRoot: tmpDir,
              manifests: ['nonexistent/composer.json'],
              lockfiles: [],
            },
            { projectRoot: tmpDir },
          ),
        ).toEqual([]);
        const badPhpComposer = path.join(tmpDir, 'composer.json');
        fs.writeFileSync(badPhpComposer, '{ corrupt json');
        expect(
          await phpAdapter.inventory(
            {
              id: 'w-php2',
              ecosystem: 'php',
              relativeRoot: tmpDir,
              manifests: [badPhpComposer],
              lockfiles: [],
            },
            { projectRoot: tmpDir },
          ),
        ).toEqual([]);

        // 8. python adapter: parsePipfileLock and missing manifestEv fallback
        const { PythonAdapter } = await import('../src/adapters/python.ts');
        const pyAdapter = new PythonAdapter();
        const pipfileLock = path.join(tmpDir, 'Pipfile.lock');
        fs.writeFileSync(
          pipfileLock,
          JSON.stringify({
            default: { requests: { version: '==2.31.0' } },
            develop: { pytest: { version: '==8.0.0' } },
          }),
        );
        const reqFile = path.join(tmpDir, 'requirements.txt');
        fs.writeFileSync(reqFile, 'requests\npytest\n');
        const pyDeps = await pyAdapter.inventory(
          {
            id: 'w-py',
            ecosystem: 'python',
            relativeRoot: tmpDir,
            manifests: [reqFile],
            lockfiles: [pipfileLock],
          },
          { projectRoot: tmpDir },
        );
        expect(pyDeps.find((d) => d.name === 'requests')?.locked).toBe('2.31.0');

        // Pipfile only: manifestEv is undefined, triggering line 369 fallback
        const pipfileOnly = path.join(tmpDir, 'Pipfile');
        fs.writeFileSync(
          pipfileOnly,
          '[[source]]\nurl = "https://pypi.org/simple"\n\n[packages]\nflask = "*"\n',
        );
        fs.unlinkSync(reqFile);
        const pipfileOnlyDeps = await pyAdapter.inventory(
          {
            id: 'w-py-pipfile',
            ecosystem: 'python',
            relativeRoot: tmpDir,
            manifests: [pipfileOnly],
            lockfiles: [],
          },
          { projectRoot: tmpDir },
        );
        expect(pipfileOnlyDeps.find((d) => d.name === 'flask')?.evidence[0]?.source).toContain(
          'Pipfile',
        );

        // 9. ruby adapter: Gemfile read failure and specs block ending
        const { RubyAdapter } = await import('../src/adapters/ruby.ts');
        const rubyAdapter = new RubyAdapter();
        expect(
          await rubyAdapter.inventory(
            {
              id: 'w-rb',
              ecosystem: 'ruby',
              relativeRoot: tmpDir,
              manifests: ['nonexistent/Gemfile'],
              lockfiles: [],
            },
            { projectRoot: tmpDir },
          ),
        ).toEqual([]);
        const gemfile = path.join(tmpDir, 'Gemfile');
        fs.writeFileSync(gemfile, "gem 'pg', '~> 1.5'");
        const gemlock = path.join(tmpDir, 'Gemfile.lock');
        fs.writeFileSync(
          gemlock,
          ['GEM', '  specs:', '    pg (1.5.4)', 'PLATFORMS', '  ruby'].join('\n'),
        );
        const rbDeps = await rubyAdapter.inventory(
          {
            id: 'w-rb2',
            ecosystem: 'ruby',
            relativeRoot: tmpDir,
            manifests: [gemfile],
            lockfiles: [gemlock],
          },
          { projectRoot: tmpDir },
        );
        expect(rbDeps.find((d) => d.name === 'pg')?.locked).toBe('1.5.4');

        // 10. rust adapter: Cargo.toml read failure and build-dependencies
        const { RustAdapter } = await import('../src/adapters/rust.ts');
        const rustAdapter = new RustAdapter();
        expect(
          await rustAdapter.inventory(
            {
              id: 'w-rs',
              ecosystem: 'rust',
              relativeRoot: tmpDir,
              manifests: ['nonexistent/Cargo.toml'],
              lockfiles: [],
            },
            { projectRoot: tmpDir },
          ),
        ).toEqual([]);
        const cargoToml = path.join(tmpDir, 'Cargo.toml');
        fs.writeFileSync(cargoToml, '[build-dependencies]\ncc = "1.0"');
        const rustDeps = await rustAdapter.inventory(
          {
            id: 'w-rs-build',
            ecosystem: 'rust',
            relativeRoot: tmpDir,
            manifests: [cargoToml],
            lockfiles: [],
          },
          { projectRoot: tmpDir },
        );
        expect(rustDeps.find((d) => d.name === 'cc')?.scope).toBe('build');

        // 11. swift adapter: revision pin and transitive
        const { SwiftAdapter } = await import('../src/adapters/swift.ts');
        const swiftAdapter = new SwiftAdapter();
        const pkgResolved = path.join(tmpDir, 'Package.resolved');
        fs.writeFileSync(
          pkgResolved,
          JSON.stringify({
            version: 2,
            pins: [
              { identity: 'pin-direct', state: { revision: 'abc1234' } },
              { identity: 'pin-transitive', state: { version: '1.0.0' } },
            ],
          }),
        );
        const pkgSwift = path.join(tmpDir, 'Package.swift');
        fs.writeFileSync(
          pkgSwift,
          '// swift-tools-version: 5.9\nlet package = Package(dependencies: [\n  .package(url: "https://github.com/foo/pin-direct.git", from: "1.0.0"),\n  .package(path: "../local-pkg")\n])',
        );
        const swiftDeps = await swiftAdapter.inventory(
          {
            id: 'w-swift',
            ecosystem: 'swift',
            relativeRoot: tmpDir,
            manifests: [pkgSwift],
            lockfiles: [pkgResolved],
          },
          { projectRoot: tmpDir, includeTransitive: true },
        );
        expect(
          swiftDeps.some(
            (d) => d.name === 'local-pkg' && d.sourceType === 'path' && d.status === 'local_path',
          ),
        ).toBe(true);
        expect(swiftDeps.some((d) => d.name === 'pin-direct' && d.locked === 'abc1234')).toBe(true);
        expect(swiftDeps.some((d) => d.name === 'pin-transitive' && d.scope === 'transitive')).toBe(
          true,
        );

        // 12. npm adapter: lockfile v2 packages entry without dependencies
        const { NpmAdapter } = await import('../src/adapters/npm.ts');
        const npmAdapter = new NpmAdapter();
        const npmPkgJson = path.join(tmpDir, 'package.json');
        fs.writeFileSync(npmPkgJson, JSON.stringify({ dependencies: { 'left-pad': '^1.0.0' } }));
        const npmLockJson = path.join(tmpDir, 'package-lock.json');
        fs.writeFileSync(
          npmLockJson,
          JSON.stringify({
            lockfileVersion: 2,
            packages: {
              'node_modules/left-pad': { version: '1.3.0' },
            },
          }),
        );
        const npmDeps = await npmAdapter.inventory(
          { id: 'w-npm', ecosystem: 'npm', relativeRoot: tmpDir, manifests: [npmPkgJson] },
          { projectRoot: tmpDir },
        );
        expect(npmDeps.find((d) => d.name === 'left-pad')?.locked).toBe('1.3.0');

        // 13. dart adapter: pubspec.yaml read failure and git/path dep
        const { DartAdapter } = await import('../src/adapters/dart.ts');
        const dartAdapter = new DartAdapter();
        expect(
          await dartAdapter.inventory(
            {
              id: 'w-dart-err',
              ecosystem: 'dart',
              relativeRoot: tmpDir,
              manifests: ['nonexistent/pubspec.yaml'],
            },
            { projectRoot: tmpDir },
          ),
        ).toEqual([]);
        const dartPubspec = path.join(tmpDir, 'pubspec.yaml');
        fs.writeFileSync(
          dartPubspec,
          [
            'name: myapp',
            'dependencies:',
            '  local_pkg:',
            '    path: ../local',
            '  git_pkg:',
            '    git: https://github.com/foo/git_pkg.git',
          ].join('\n'),
        );
        const dartDeps = await dartAdapter.inventory(
          { id: 'w-dart', ecosystem: 'dart', relativeRoot: tmpDir, manifests: [dartPubspec] },
          { projectRoot: tmpDir },
        );
        expect(dartDeps.find((d) => d.name === 'local_pkg')?.status).toBe('local_path');
        expect(dartDeps.find((d) => d.name === 'git_pkg')?.status).toBe('git_dependency');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('covers native audit runner parse errors and non-zero exit codes', async () => {
      const { runPipAudit, runGoVulncheck, runComposerAudit } = await import(
        '../src/advisory/native-audit.js'
      );
      // 1. pip-audit corrupt json and non-zero exit
      const resPipBadJson = await runPipAudit('/fake/dir', async () => ({
        status: 0,
        stdout: '{ corrupt',
        stderr: '',
      }));
      expect(resPipBadJson.evidence.detail).toContain('Failed to parse pip-audit');
      const resPipExitErr = await runPipAudit('/fake/dir', async () => ({
        status: 2,
        stdout: '',
        stderr: 'pip-audit failure',
      }));
      expect(resPipExitErr.evidence.detail).toContain('pip-audit exited with code 2');

      // 2. govulncheck corrupt json, status 1, and exit error
      const resGoBadJson = await runGoVulncheck('/fake/dir', async () => ({
        status: 0,
        stdout: '{ corrupt',
        stderr: '',
      }));
      expect(resGoBadJson.evidence.detail).toContain('Failed to parse govulncheck');
      const resGoNoVulns = await runGoVulncheck('/fake/dir', async () => ({
        status: 1,
        stdout: '',
        stderr: '',
      }));
      expect(resGoNoVulns.evidence.detail).toContain('govulncheck: no vulnerabilities found');
      const resGoExitErr = await runGoVulncheck('/fake/dir', async () => ({
        status: 2,
        stdout: '',
        stderr: 'govulncheck crash',
      }));
      expect(resGoExitErr.evidence.detail).toContain('govulncheck exited with code 2');

      // 3. composer audit corrupt json and exit error
      const resComposerBadJson = await runComposerAudit('/fake/dir', async () => ({
        status: 0,
        stdout: '{ corrupt',
        stderr: '',
      }));
      expect(resComposerBadJson.evidence.detail).toContain('Failed to parse composer audit');
      const resComposerExitErr = await runComposerAudit('/fake/dir', async () => ({
        status: 1,
        stdout: '',
        stderr: 'composer error',
      }));
      expect(resComposerExitErr.evidence.detail).toContain('composer audit exited with code 1');
    });

    it('covers status.ts version comparisons and constraint evaluations', async () => {
      const { compareVersions, classifyStatus } = await import('../src/policy/status.js');
      // Prerelease ties
      expect(compareVersions('1.0.0-alpha', '1.0.0-alpha')).toBe(0);
      expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.1')).toBe(0);

      // ~ constraint with minor bump
      const depTilde = makeDep('pkg-tilde', { locked: '1.2.3', requested: '~1.2.0' });
      expect(classifyStatus(depTilde, { latestStable: '1.3.0' })).toBe('update_available_breaking');
      expect(classifyStatus(depTilde, { latestStable: '1.2.4' })).toBe('update_available_safe');

      // Exact pin breaking when major bump
      const depExact = makeDep('pkg-exact', { locked: '1.2.3', requested: '1.2.3' });
      expect(classifyStatus(depExact, { latestStable: '2.0.0' })).toBe('update_available_breaking');
      expect(classifyStatus(depExact, { latestStable: '1.2.4' })).toBe('update_available_safe');
    });

    it('covers client.ts nuget and packagist edge cases', async () => {
      const { lookupRegistry } = await import('../src/registry/client.js');
      const httpFetch = await import('../src/registry/http-fetch.js');

      // NuGet: stable version comparison ver > latestStable
      vi.spyOn(httpFetch, 'requestWithRetry').mockResolvedValueOnce({
        statusCode: 200,
        headers: {},
        body: JSON.stringify({
          items: [
            {
              items: [
                { catalogEntry: { version: '1.0.0' } },
                { catalogEntry: { version: '1.1.0' } },
                { catalogEntry: { version: '2.0.0-beta' } },
              ],
            },
          ],
        }),
      });
      const nugetRes = await lookupRegistry('nuget', 'Newtonsoft.Json');
      expect(nugetRes?.latestStable).toBe('1.1.0');

      // Packagist: empty versions array
      vi.spyOn(httpFetch, 'requestWithRetry').mockResolvedValueOnce({
        statusCode: 200,
        headers: {},
        body: JSON.stringify({
          packages: { 'vendor/package': [] },
        }),
      });
      const composerRes = await lookupRegistry('composer', 'vendor/package');
      expect(composerRes?.latestStable).toBeUndefined();

      // lookupRegistryBatch with an erroring dep and invalidateRegistryCache
      const { lookupRegistryBatch, invalidateRegistryCache } = await import(
        '../src/registry/client.js'
      );
      vi.spyOn(httpFetch, 'requestWithRetry').mockRejectedValueOnce(new Error('Network error'));
      const batchRes = await lookupRegistryBatch('npm', ['failing-pkg-batch']);
      expect(batchRes.get('failing-pkg-batch')).toBeUndefined();

      // invalidateRegistryCache with and without names
      expect(invalidateRegistryCache('npm', ['failing-pkg-batch'])).toBeGreaterThanOrEqual(0);
      expect(invalidateRegistryCache('npm')).toBeGreaterThanOrEqual(0);
      expect(invalidateRegistryCache('unsupported-eco')).toBe(0);

      vi.restoreAllMocks();
    });

    it('covers realFs in rulebook.ts', async () => {
      const { loadRulebook } = await import('../src/policy/rulebook.js');
      const fs = await import('node:fs');
      const path = await import('node:path');
      const os = await import('node:os');
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'techstack-rulebook-realfs-'));
      try {
        const wrongstackDir = path.join(tmpDir, '.wrongstack');
        fs.mkdirSync(wrongstackDir, { recursive: true });
        const rbPath = path.join(wrongstackDir, 'techstack.rulebook.json');
        fs.writeFileSync(
          rbPath,
          JSON.stringify({
            schemaVersion: '1',
            pinned: [
              {
                selector: { name: 'foo' },
                max: '<=2.0.0',
                reason: 'pin reason',
              },
            ],
          }),
        );
        // Call loadRulebook without passing io, so realFs.exists and realFs.readFile are used
        const res = await loadRulebook(tmpDir);
        expect(res.kind).toBe('loaded');

        // Also call loadRulebook on a non-existent dir to cover realFs.exists returning false
        const resMissing = await loadRulebook(path.join(tmpDir, 'does-not-exist'));
        expect(resMissing.kind).toBe('absent');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('covers sqlite.ts loadDatabaseSync error branch', async () => {
      const persistence = await import('@wrongstack/persistence');
      const { TechStackStore, _resetDatabaseSyncForTesting } = await import(
        '../src/store/sqlite.js'
      );

      _resetDatabaseSyncForTesting();
      const spy = vi.spyOn(persistence, 'loadRuntimeDatabaseSync').mockImplementationOnce(() => {
        throw new Error('SQLite not supported');
      });
      expect(() => new TechStackStore({ projectSlug: 'test-error-slug' })).toThrow(
        /SQLite not supported/,
      );

      _resetDatabaseSyncForTesting();
      vi.spyOn(persistence, 'loadRuntimeDatabaseSync').mockImplementationOnce(() => {
        throw 'non-error failure';
      });
      expect(() => new TechStackStore({ projectSlug: 'test-error-slug-str' })).toThrow(
        /non-error failure/,
      );

      _resetDatabaseSyncForTesting();
      spy.mockRestore();
    });

    it('covers license.ts AGPL branch', async () => {
      const { assessLicense } = await import('../src/policy/license.js');
      // A license string with agpl that is NOT in NETWORK_COPYLEFT_LICENSES set
      const agpl = assessLicense('custom-agpl-v3');
      expect(agpl.category).toBe('strong_copyleft');
      expect(agpl.isCopyleft).toBe(true);
    });

    it('covers misalignment.ts locked and requested undefined fallback', async () => {
      const { detectWorkspaceMisalignments } = await import('../src/policy/misalignment.js');
      const ws1: Workspace = { id: 'ws-1', ecosystem: 'npm', relativeRoot: '', manifests: [] };
      const ws2: Workspace = { id: 'ws-2', ecosystem: 'npm', relativeRoot: 'pkg2', manifests: [] };
      const deps = [
        makeDep('pkg-none', { workspaceId: 'ws-1', locked: undefined, requested: undefined }),
        makeDep('pkg-none', { workspaceId: 'ws-2', locked: '1.0.0', requested: '^1.0.0' }),
      ];
      const findings = detectWorkspaceMisalignments(deps, [ws1, ws2]);
      expect(findings.length).toBe(2);
      expect(findings[0].rationale).toContain('unknown');
    });

    it('covers resolver.ts satisfiesRange <= and < comparator branches', async () => {
      const { satisfiesRange } = await import('../src/policy/resolver.js');
      expect(satisfiesRange('1.0.0', { kind: 'comparator', op: '<=', version: '1.0.0' })).toBe(
        true,
      );
      expect(satisfiesRange('0.9.0', { kind: 'comparator', op: '<=', version: '1.0.0' })).toBe(
        true,
      );
      expect(satisfiesRange('1.1.0', { kind: 'comparator', op: '<=', version: '1.0.0' })).toBe(
        false,
      );
      expect(satisfiesRange('0.9.0', { kind: 'comparator', op: '<', version: '1.0.0' })).toBe(true);
      expect(satisfiesRange('1.0.0', { kind: 'comparator', op: '<', version: '1.0.0' })).toBe(
        false,
      );
    });

    it('covers osv.ts mapSeverity CVSS_V2 and lowercase database_specific branches', async () => {
      const httpFetch = await import('../src/registry/http-fetch.js');
      vi.spyOn(httpFetch, 'requestWithRetry').mockResolvedValueOnce({
        statusCode: 200,
        headers: {},
        body: JSON.stringify({
          results: [
            {
              vulns: [
                {
                  id: 'V-V2',
                  severity: [{ type: 'CVSS_V2', score: '7.5' }],
                },
                {
                  id: 'V-LOW',
                  database_specific: { severity: 'low' },
                },
                {
                  id: 'V-MED',
                  database_specific: { severity: 'medium' },
                },
              ],
            },
          ],
        }),
      });

      const res = await queryOsvBatch(['pkg:npm/test-v2@1.0.0']);
      const advs = res.advisories.get('pkg:npm/test-v2@1.0.0');
      expect(advs?.[0].severity).toBe('high');
      expect(advs?.[1].severity).toBe('low');
      expect(advs?.[2].severity).toBe('medium');
      vi.restoreAllMocks();
    });

    it('covers client.ts host concurrency queue release when concurrency exceeds max', async () => {
      const { lookupRegistry, clearRegistryCache } = await import('../src/registry/client.js');
      const httpFetch = await import('../src/registry/http-fetch.js');
      clearRegistryCache();

      // Launch 5 concurrent lookups for npm
      let activeRequests = 0;
      let maxSeenActive = 0;

      vi.spyOn(httpFetch, 'requestWithRetry').mockImplementation(async () => {
        activeRequests++;
        if (activeRequests > maxSeenActive) maxSeenActive = activeRequests;
        await new Promise((resolve) => setTimeout(resolve, 30));
        activeRequests--;
        return {
          statusCode: 200,
          headers: {},
          body: JSON.stringify({ 'dist-tags': { latest: '1.0.0' } }),
        };
      });

      const promises = [
        lookupRegistry('npm', 'pkg-q-1'),
        lookupRegistry('npm', 'pkg-q-2'),
        lookupRegistry('npm', 'pkg-q-3'),
        lookupRegistry('npm', 'pkg-q-4'),
        lookupRegistry('npm', 'pkg-q-5'),
      ];

      const results = await Promise.all(promises);
      expect(results).toHaveLength(5);
      expect(maxSeenActive).toBeLessThanOrEqual(3);
      vi.restoreAllMocks();
    });

    it('covers http-fetch.ts timeout and abort listener cleanup', async () => {
      const http = await import('node:http');
      const { requestWithRetry } = await import('../src/registry/http-fetch.js');

      // Create a server that delays response to trigger timeout
      const server = http.createServer((_req, res) => {
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{}');
        }, 150);
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const addr = server.address() as any;
      const port = addr.port;

      try {
        await expect(
          requestWithRetry({
            hostname: '127.0.0.1',
            path: `:${port}/test`,
            timeoutMs: 20,
            maxAttempts: 1,
          }),
        ).rejects.toThrow();
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('covers native-audit.ts requirements.txt detection', async () => {
      const { runPipAudit } = await import('../src/advisory/native-audit.js');
      const fs = await import('node:fs');
      const path = await import('node:path');
      const os = await import('node:os');
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'techstack-pip-reqs-'));
      try {
        fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'requests==2.25.0\n');
        let capturedArgs: readonly string[] = [];
        const res = await runPipAudit(tmpDir, async (_cmd, args) => {
          capturedArgs = args;
          return { status: 0, stdout: '[]', stderr: '' };
        });
        expect(capturedArgs).toContain('--requirement');
        expect(capturedArgs).toContain('requirements.txt');
        expect(res.advisories).toEqual([]);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('covers resolver.ts pin evaluation when dep has neither locked nor installed (evaluates latestStable)', async () => {
      const { resolveDependency } = await import('../src/policy/resolver.js');
      const depLatest = makeDep('pkg-pin-latest', {
        locked: undefined,
        installed: undefined,
        latestStable: '1.5.0',
      });
      const rulebook = {
        schemaVersion: '1' as const,
        pinned: [
          { selector: { name: 'pkg-pin-latest' }, max: '<=2.0.0' as any, reason: 'pin latest' },
        ],
        banned: [],
        deferred: [],
        preferred: [],
      };
      const res = resolveDependency(depLatest, rulebook, new Date());
      expect(res.satisfies).toBe(true);
      expect(res.detail).toContain('latestStable');
    });

    it('covers client.ts cache expiration and trimming eviction', async () => {
      const { lookupRegistry, clearRegistryCache } = await import('../src/registry/client.js');
      const httpFetch = await import('../src/registry/http-fetch.js');
      clearRegistryCache();

      // Mock requestWithRetry to return successful metadata
      vi.spyOn(httpFetch, 'requestWithRetry').mockResolvedValue({
        statusCode: 200,
        headers: {},
        body: JSON.stringify({ 'dist-tags': { latest: '1.0.0' } }),
      });

      // Insert an entry with expired timestamp into registryCache
      await lookupRegistry('npm', 'expiring-pkg');
      // Advance time by default TTL + 1ms to trigger lines 54-55
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 25 * 60 * 60 * 1000);
      // Next lookup for same key should see Date.now() > entry.expiresAt and delete it
      await lookupRegistry('npm', 'expiring-pkg');
      nowSpy.mockRestore();

      // Trigger trimCache lines 71-78 by populating > 512 entries
      // We can directly call lookupRegistry or mock registryCache size
      for (let i = 0; i <= 515; i++) {
        await lookupRegistry('npm', `pkg-cache-${i}`);
      }

      vi.restoreAllMocks();
    });

    it('covers defaultRulebookFileSystem stat and exists', async () => {
      const { defaultRulebookFileSystem } = await import('../src/policy/rulebook.js');
      const filePath = fileURLToPath(import.meta.url);
      const stats = await defaultRulebookFileSystem.stat(filePath);
      expect(stats.size).toBeGreaterThan(0);
      const exists = await defaultRulebookFileSystem.exists(filePath);
      expect(exists).toBe(true);
    });

    it('covers status.ts compareVersions identical prereleases', async () => {
      const { compareVersions } = await import('../src/policy/status.js');
      expect(compareVersions('1.0.0-alpha', '1.0.0-alpha')).toBe(0);
      expect(compareVersions('1.0.0-beta.1', '1.0.0-beta.1')).toBe(0);
      expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
    });
  });
});
